/**
 * The run engine (spec §7.2, decision D5): runs execute inside the Next server process. Step
 * state lives in `runs.plan` and is written before and after each step; events go to
 * `run_events`; steps whose dependencies are done run concurrently; one AbortController per run
 * answers cancel. `enqueue` and `cancel` are the whole interface so a hosted build can swap in
 * a queue later.
 */
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import { getDb } from '../db';
import * as t from '../db/schema';
import { listMemory } from '../memory';
import { addUsage, ZERO_USAGE } from '../pricing';
import type { Agent, MemoryEntry, Run, Step } from '../schemas';
import { emitEvent } from './events';
import { mergeRun } from './merge';
import {
  abortError,
  anthropicModelClient,
  describeFailure,
  EngineError,
  withRetries,
  type ModelClient,
} from './model';
import { MERGE_STEP_ID, planRun } from './plan';
import { ensureSandbox, wipeSandbox } from './sandbox';
import { runStep, setAgentStatus } from './step';

export type EngineOptions = {
  client?: ModelClient;
  /** Runs executing at once; steps inside a run fan out on their own. */
  concurrency?: number;
  getDb?: () => Promise<Db>;
};

export class Engine {
  private readonly queue: string[] = [];
  private readonly active = new Map<string, AbortController>();
  private readonly waiters: (() => void)[] = [];
  private clientInstance: ModelClient | null;
  private readonly concurrency: number;
  private readonly db: () => Promise<Db>;

  constructor(opts: EngineOptions = {}) {
    this.clientInstance = opts.client ?? null;
    this.concurrency = opts.concurrency ?? 2;
    this.db = opts.getDb ?? getDb;
  }

  private client(): ModelClient {
    this.clientInstance ??= anthropicModelClient();
    return this.clientInstance;
  }

  /** Queues a run; returns at once. */
  enqueue(runId: string): void {
    if (this.queue.includes(runId) || this.active.has(runId)) return;
    this.queue.push(runId);
    this.pump();
  }

  /** Aborts a running run or drops a queued one; the run is marked `cancelled` either way. */
  async cancel(runId: string): Promise<boolean> {
    const controller = this.active.get(runId);
    if (controller) {
      controller.abort(abortError());
      return true;
    }
    const queued = this.queue.indexOf(runId);
    if (queued !== -1) {
      this.queue.splice(queued, 1);
      const db = await this.db();
      await db
        .update(t.runs)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(eq(t.runs.id, runId));
      await emitEvent(db, { runId, kind: 'error', text: 'Run cancelled before it started.' });
      return true;
    }
    return false;
  }

  /** Runs left `running` by a previous process go back to work; queued ones are picked up (D5). */
  async resumeInterrupted(db: Db): Promise<number> {
    const rows = await db
      .select({ id: t.runs.id, status: t.runs.status, plan: t.runs.plan })
      .from(t.runs)
      .where(inArray(t.runs.status, ['queued', 'running']));
    for (const row of rows) {
      if (row.status === 'running') {
        const plan = row.plan.map((s) =>
          s.status === 'live' ? { ...s, status: 'todo' as const } : s,
        );
        await db.update(t.runs).set({ plan }).where(eq(t.runs.id, row.id));
        await emitEvent(db, {
          runId: row.id,
          kind: 'message',
          text: 'Magpipe restarted; resuming where the run left off.',
        });
      }
      this.enqueue(row.id);
    }
    return rows.length;
  }

  /** Resolves when nothing is queued or running (tests, shutdown). */
  whenIdle(): Promise<void> {
    if (this.queue.length === 0 && this.active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  get isBusy(): boolean {
    return this.active.size > 0 || this.queue.length > 0;
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.queue.length > 0) {
      const runId = this.queue.shift()!;
      const controller = new AbortController();
      this.active.set(runId, controller);
      void this.execute(runId, controller)
        .catch((err) => console.error(`[engine] run ${runId} crashed:`, err))
        .finally(() => {
          this.active.delete(runId);
          this.pump();
          if (this.queue.length === 0 && this.active.size === 0) {
            for (const w of this.waiters.splice(0)) w();
          }
        });
    }
  }

  private async execute(runId: string, controller: AbortController): Promise<void> {
    const db = await this.db();
    const signal = controller.signal;
    let [run] = await db.select().from(t.runs).where(eq(t.runs.id, runId));
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return;

    const save = async (patch: Partial<Run>) => {
      run = { ...run!, ...patch };
      await db.update(t.runs).set(patch).where(eq(t.runs.id, runId));
    };
    const emit = (
      kind: Parameters<typeof emitEvent>[1]['kind'],
      text: string,
      payload?: unknown,
      stepId?: string | null,
    ) => emitEvent(db, { runId, stepId: stepId ?? null, agentId: null, kind, text, payload });

    const agents = await db.select().from(t.agents);
    const names = new Map(agents.map((a) => [a.id, a.name]));
    const [settings] = await db.select().from(t.settings);
    const orchestratorModel = settings?.models.orchestrator ?? 'claude-opus-5-5';
    const sandboxDir = await ensureSandbox(runId);
    const touched = new Set<string>();

    try {
      await save({ status: 'running', startedAt: run.startedAt ?? new Date() });
      const memory = await relevantMemory(db, run.input.text);

      // 1. plan (skipped on resume when a plan exists)
      if (run.plan.length === 0) {
        const planned = await withRetries(
          () =>
            planRun({
              client: this.client(),
              model: orchestratorModel,
              run: run!,
              agents,
              memory,
              signal,
            }),
          { signal, onRetry: (f, n) => void emit('error', `Retry ${n}: ${f.message}`) },
        );
        await save({ plan: planned.steps, usage: addUsage(run.usage, planned.usage) });
        await emit('plan', planned.summary, {
          steps: planned.steps.map((s) => ({
            id: s.id,
            agentId: s.agentId,
            title: s.title,
            dependsOn: s.dependsOn,
          })),
        });
      }

      // 2. the DAG: everything whose dependencies are done runs together
      for (;;) {
        signal.throwIfAborted();
        const plan = run.plan;
        const byId = new Map(plan.map((s) => [s.id, s]));
        const ready = plan.filter(
          (s) =>
            s.status === 'todo' &&
            s.id !== MERGE_STEP_ID &&
            s.dependsOn.every((d) => byId.get(d)?.status === 'done'),
        );
        // steps whose dependencies failed or were skipped cannot run
        const blocked = plan.filter(
          (s) =>
            s.status === 'todo' &&
            s.id !== MERGE_STEP_ID &&
            s.dependsOn.some((d) => ['failed', 'skipped'].includes(byId.get(d)?.status ?? '')),
        );
        if (blocked.length) {
          await save({
            plan: plan.map((s) => (blocked.includes(s) ? { ...s, status: 'skipped' } : s)),
          });
          continue;
        }
        if (ready.length === 0) break;

        const startedAt = new Date().toISOString();
        await save({
          plan: plan.map((s) => (ready.includes(s) ? { ...s, status: 'live', startedAt } : s)),
        });
        await Promise.all(
          ready.map(async (step) => {
            const agent = agents.find((a) => a.id === step.agentId);
            if (!agent) {
              await this.finishStep(save, () => run!, step.id, {
                status: 'failed',
                error: { code: 'no_agent', message: 'The agent no longer exists.' },
              });
              return;
            }
            touched.add(agent.id);
            await setAgentStatus(db, agent.id, 'running');
            try {
              const outcome = await runStep({
                db,
                client: this.client(),
                run: run!,
                step,
                agent,
                upstream: step.dependsOn.map((d) => byId.get(d)!).filter(Boolean),
                memory,
                attachments: run!.input.attachments,
                sandboxDir,
                signal,
              });
              await this.finishStep(save, () => run!, step.id, {
                status: 'done',
                result: { summary: outcome.summary },
                usage: outcome.usage,
              });
              await emit('message', `${agent.name} finished: ${step.title}`, null, step.id);
            } catch (err) {
              if (signal.aborted) throw err;
              const f =
                err instanceof EngineError
                  ? { code: err.code, message: err.message }
                  : describeFailure(err);
              await this.finishStep(save, () => run!, step.id, {
                status: 'failed',
                error: { code: f.code, message: f.message },
              });
              await emitEvent(db, {
                runId,
                stepId: step.id,
                agentId: agent.id,
                kind: 'error',
                text: f.message,
                payload: { code: f.code },
              });
            } finally {
              await setAgentStatus(db, agent.id, 'idle');
            }
          }),
        );
      }

      // 3. merge, unless a required step failed
      const hardFailure = run.plan.find(
        (s) => s.status === 'failed' && !s.optional && s.id !== MERGE_STEP_ID,
      );
      if (hardFailure) {
        throw new EngineError(
          hardFailure.error?.code ?? 'step_failed',
          `${names.get(hardFailure.agentId ?? '') ?? 'A step'} failed: ${hardFailure.error?.message ?? hardFailure.title}`,
        );
      }
      const mergeStartedAt = new Date().toISOString();
      await save({
        plan: run.plan.map((s) =>
          s.id === MERGE_STEP_ID ? { ...s, status: 'live', startedAt: mergeStartedAt } : s,
        ),
      });
      const merged = await withRetries(
        () =>
          mergeRun({
            client: this.client(),
            model: orchestratorModel,
            run: run!,
            steps: run!.plan,
            agentNames: names,
            signal,
          }),
        { signal, onRetry: (f, n) => void emit('error', `Retry ${n}: ${f.message}`) },
      );
      const finishedAt = new Date();
      const stepUsage = run.plan.reduce(
        (acc, s) => (s.usage ? addUsage(acc, s.usage) : acc),
        ZERO_USAGE,
      );
      await save({
        plan: run.plan.map((s) =>
          s.id === MERGE_STEP_ID
            ? {
                ...s,
                status: 'done',
                finishedAt: finishedAt.toISOString(),
                usage: merged.usage,
                result: { summary: 'Composed the final answer' },
              }
            : s,
        ),
        status: 'done',
        output: { markdown: merged.markdown, artifacts: [] },
        finishedAt,
        durationMs: finishedAt.getTime() - (run.startedAt ?? run.createdAt).getTime(),
        usage: addUsage(addUsage(run.usage, stepUsage), merged.usage),
      });
      await emit('done', 'Run finished');
    } catch (err) {
      const finishedAt = new Date();
      const stepUsage = run.plan.reduce(
        (acc, s) => (s.usage ? addUsage(acc, s.usage) : acc),
        ZERO_USAGE,
      );
      const cancelled = signal.aborted;
      const f = cancelled
        ? { code: 'cancelled', message: 'Run cancelled by the operator.' }
        : err instanceof EngineError
          ? { code: err.code, message: err.message }
          : describeFailure(err);
      await save({
        status: cancelled ? 'cancelled' : 'failed',
        plan: run.plan.map((s) =>
          s.status === 'live'
            ? {
                ...s,
                status: 'failed',
                finishedAt: finishedAt.toISOString(),
                error: { code: f.code, message: f.message },
              }
            : s.status === 'todo'
              ? { ...s, status: 'skipped' }
              : s,
        ),
        finishedAt,
        durationMs: finishedAt.getTime() - (run.startedAt ?? run.createdAt).getTime(),
        usage: addUsage(run.usage, stepUsage),
      });
      await emit('error', f.message, { code: f.code });
    } finally {
      for (const id of touched) await setAgentStatus(db, id, 'idle').catch(() => {});
      await wipeSandbox(runId).catch(() => {});
    }
  }

  private async finishStep(
    save: (patch: Partial<Run>) => Promise<void>,
    current: () => Run,
    stepId: string,
    patch: Partial<Step>,
  ): Promise<void> {
    const finishedAt = new Date().toISOString();
    await save({
      plan: current().plan.map((s) => (s.id === stepId ? { ...s, ...patch, finishedAt } : s)),
    });
  }
}

/** All decisions plus whatever the task text matches (spec §7.1), capped for the prompt. */
export async function relevantMemory(db: Db, task: string): Promise<MemoryEntry[]> {
  const words = task
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 8);
  const [decisions, matches] = await Promise.all([
    listMemory(db, { ns: 'decisions' }),
    words.length ? listMemory(db, { q: words.join(' ') }) : Promise.resolve([] as MemoryEntry[]),
  ]);
  const seen = new Set<string>();
  return [...decisions, ...matches]
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .slice(0, 30);
}

const g = globalThis as unknown as { __magpipeEngine?: Engine };

/** The process-wide engine (survives dev HMR). */
export function getEngine(): Engine {
  g.__magpipeEngine ??= new Engine();
  return g.__magpipeEngine;
}

export type { Agent };

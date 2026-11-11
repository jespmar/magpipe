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
import { env } from '../env';
import { listMemory } from '../memory';
import { loadThread } from '../runs';
import { addUsage, ZERO_USAGE } from '../pricing';
import type { Agent, Goal, MemoryEntry, Run, RunEventKind, Step } from '../schemas';
import { apiBackend, type RunBackend } from './backend';
import { claudeCodeBackend } from './claude-code';
import { emitEvent } from './events';
import { acquireWriteLocks, writeTargets, type WriteTarget } from './locks';
import { capReached, spendCapMessage, spendToday } from '../spend';
import { foldWork, runArtifacts, workItems, type WorkItem } from '../work';
import { sendBackSet, threadText } from '../runs-util';
import { parseVerdict, runAction } from './actions';
import { acceptanceCriteria, renderGoals } from '../goals';
import { documentAnswer, mergeRun } from './merge';
import { TrackerError } from '../tracker/types';
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
import { scriptedModelClient } from './stub-model';

/**
 * At most this many steps of one run work at once (D28), as the Claude Code backend's scope
 * planned: each step is a CLI process, and a wide fan-out costs more than it saves.
 */
export const MAX_PARALLEL_STEPS = 3;

export type EngineOptions = {
  /** A scripted Messages API client (tests); wrapped in the API backend. */
  client?: ModelClient;
  /** The backend outright; wins over `client`. */
  backend?: RunBackend;
  /** Runs executing at once; steps inside a run fan out on their own. */
  concurrency?: number;
  getDb?: () => Promise<Db>;
};

/**
 * Which backend a production run uses (D22): the scripted stub in development and tests, the
 * Messages API when `magpipe.env` asks for it, the Claude Code on this machine otherwise.
 */
function selectBackend(): RunBackend {
  if (env.MAGPIPE_MODEL_STUB === 'scripted' && process.env.NODE_ENV !== 'production') {
    return apiBackend(scriptedModelClient());
  }
  if (env.MAGPIPE_MODEL_BACKEND === 'api') return apiBackend(anthropicModelClient());
  return claudeCodeBackend();
}

export class Engine {
  private readonly queue: string[] = [];
  private readonly active = new Map<string, AbortController>();
  private readonly waiters: (() => void)[] = [];
  private backendInstance: RunBackend | null;
  private concurrency: number;
  private readonly db: () => Promise<Db>;

  constructor(opts: EngineOptions = {}) {
    this.backendInstance = opts.backend ?? (opts.client ? apiBackend(opts.client) : null);
    this.concurrency = opts.concurrency ?? 2;
    this.db = opts.getDb ?? getDb;
  }

  private backend(): RunBackend {
    this.backendInstance ??= selectBackend();
    return this.backendInstance;
  }

  /** How many runs may work at once (D41, a setting). Raising it starts queued runs now. */
  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.floor(n));
    this.pump();
  }

  get runLimit(): number {
    return this.concurrency;
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
    // A run waiting for approval is in no queue: cancel it in the database (D30).
    const db = await this.db();
    const [row] = await db.select().from(t.runs).where(eq(t.runs.id, runId));
    if (row?.status === 'waiting') {
      const finishedAt = new Date();
      await db
        .update(t.runs)
        .set({
          status: 'cancelled',
          finishedAt,
          durationMs: finishedAt.getTime() - (row.startedAt ?? row.createdAt).getTime(),
          plan: row.plan.map((s) =>
            s.status === 'todo' ? { ...s, status: 'skipped' as const } : s,
          ),
        })
        .where(eq(t.runs.id, runId));
      await emitEvent(db, { runId, kind: 'error', text: 'Run cancelled by the operator.' });
      return true;
    }
    return false;
  }

  /**
   * Runs left `running` by a previous process go back to work; queued ones are picked up (D5).
   * A step that was live starts again, counting the restart and keeping the work it had recorded,
   * so its next attempt continues from there (D33).
   */
  async resumeInterrupted(db: Db): Promise<number> {
    const rows = await db
      .select({ id: t.runs.id, status: t.runs.status, plan: t.runs.plan })
      .from(t.runs)
      .where(inArray(t.runs.status, ['queued', 'running']));
    for (const row of rows) {
      if (row.status === 'running') {
        const plan = row.plan.map((s) =>
          s.status === 'live'
            ? { ...s, status: 'todo' as const, restarts: (s.restarts ?? 0) + 1 }
            : s,
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
    // A finished step by an agent that pauses for approval holds back what depends on it (D30).
    const pausing = new Set(agents.filter((a) => a.pauseAfter).map((a) => a.id));
    const held = (s: Step) =>
      s.status === 'done' && s.agentId !== null && pausing.has(s.agentId) && !s.approvedAt;
    const tools = await db
      .select({
        id: t.tools.id,
        name: t.tools.name,
        status: t.tools.status,
        repository: t.tools.repository,
      })
      .from(t.tools);
    // Which work trees each agent's steps would change, worked out once per run (D28).
    const workTrees = new Map<string, string | null>();
    const targetsOf = new Map<string, Promise<WriteTarget[]>>();
    // A build run works in its goal's worktree (D41): the repository tool's folder is the
    // worktree for this run, so its write lock is the worktree's and other goals go on.
    const wt = run.input.worktree;
    const repoPaths = wt ? { [wt.toolId]: wt.path } : undefined;
    if (wt) {
      for (const tool of tools) {
        if (tool.id === wt.toolId && tool.repository) {
          tool.repository = { ...tool.repository, path: wt.path };
        }
      }
    }
    const writeTargetsFor = (agent: (typeof agents)[number]) => {
      if (!targetsOf.has(agent.id)) targetsOf.set(agent.id, writeTargets(agent, tools, workTrees));
      return targetsOf.get(agent.id)!;
    };
    const names = new Map(agents.map((a) => [a.id, a.name]));
    const [settings] = await db.select().from(t.settings);
    const orchestratorModel = settings?.models.orchestrator ?? 'claude-opus-5-5';
    const sandboxDir = await ensureSandbox(runId);
    const touched = new Set<string>();

    try {
      await save({ status: 'running', startedAt: run.startedAt ?? new Date() });
      const memory = await relevantMemory(db, run.input.text);
      // A follow-up carries the conversation it continues into every prompt.
      const conversation = threadText(await loadThread(db, run)) || undefined;

      // 1. plan (skipped on resume when a plan exists), unless today's spend is at the cap
      if (run.plan.length === 0) {
        const stop = await this.spendCapStop(db, 'planning');
        if (stop) throw stop;
        const planned = await withRetries(
          () =>
            planRun({
              backend: this.backend(),
              model: orchestratorModel,
              run: run!,
              agents,
              tools,
              memory,
              conversation,
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

      // 2. the DAG: everything whose dependencies are done runs together. Once today's spend
      // reaches the cap no step goes live; steps already working finish, then the run stops (D32).
      let capStop: EngineError | null = null;
      for (;;) {
        signal.throwIfAborted();
        const plan: Step[] = run.plan;
        const byId = new Map(plan.map((s) => [s.id, s]));
        // A judge that said fail with nothing sent back stops the agent work after it (D40);
        // actions still run, since they report the verdict.
        const judgedFail = (dep: Step | undefined) =>
          dep?.status === 'done' && dep.judges === true && dep.verdict === 'fail';
        const settled = (dep: Step | undefined) =>
          !!dep &&
          (dep.status === 'failed' ||
            dep.status === 'skipped' ||
            (dep.status === 'done' && !held(dep)));
        const ready = plan.filter(
          (s) =>
            s.status === 'todo' &&
            s.id !== MERGE_STEP_ID &&
            (s.always
              ? // A finishing step runs once everything before it has settled, however it went.
                s.dependsOn.every((d) => settled(byId.get(d)))
              : s.dependsOn.every((d) => {
                  const dep = byId.get(d);
                  return dep?.status === 'done' && !held(dep) && (s.action || !judgedFail(dep));
                })),
        );
        // steps whose dependencies failed or were skipped cannot run
        const blocked = plan.filter(
          (s) =>
            s.status === 'todo' &&
            s.id !== MERGE_STEP_ID &&
            !s.always &&
            s.dependsOn.some((d) => {
              const dep = byId.get(d);
              return (
                ['failed', 'skipped'].includes(dep?.status ?? '') || (!s.action && judgedFail(dep))
              );
            }),
        );
        if (blocked.length) {
          await save({
            plan: plan.map((s) => (blocked.includes(s) ? { ...s, status: 'skipped' } : s)),
          });
          continue;
        }
        if (ready.length === 0) break;

        // A wave is at most MAX_PARALLEL_STEPS steps, and never two that change the same work
        // tree; the rest wait for the next wave (D28). The first ready step always goes.
        const wave: Step[] = [];
        const claimed = new Set<string>();
        for (const step of ready) {
          if (wave.length >= MAX_PARALLEL_STEPS) break;
          const agent = agents.find((a) => a.id === step.agentId);
          const keys = agent ? (await writeTargetsFor(agent)).map((w) => w.key) : [];
          if (keys.some((k) => claimed.has(k))) continue;
          for (const k of keys) claimed.add(k);
          wave.push(step);
        }

        await Promise.all(
          wave.map(async (step) => {
            // Magpipe's own work (D38): no agent, no model, no spend, no lock.
            if (step.action) {
              await this.runActionStep(db, save, () => run!, step, names, emit, signal);
              return;
            }
            const agent = agents.find((a) => a.id === step.agentId);
            if (!agent) {
              await this.finishStep(save, () => run!, step.id, {
                status: 'failed',
                error: { code: 'no_agent', message: 'The agent no longer exists.' },
              });
              return;
            }
            touched.add(agent.id);
            // Another run may be changing the same work tree: wait for it, then go live.
            const targets = await writeTargetsFor(agent);
            const release = await acquireWriteLocks(
              targets.map((w) => w.key),
              `run ${run!.displayId}`,
              signal,
              async (key, holder) => {
                const name = targets.find((w) => w.key === key)?.name ?? 'the repository';
                await setAgentStatus(db, agent.id, 'waiting');
                await emit(
                  'message',
                  `Waiting to change ${name}: ${holder} is changing it.`,
                  { waitingFor: holder },
                  step.id,
                );
              },
            );
            // Checked as late as possible: after any wait, just before the step goes live.
            const stop = capStop ?? (await this.spendCapStop(db, `“${step.title}”`));
            if (stop) {
              capStop ??= stop;
              release();
              await setAgentStatus(db, agent.id, 'idle');
              return;
            }
            const startedAt = new Date().toISOString();
            await save({
              plan: run!.plan.map((s) =>
                s.id === step.id ? { ...s, status: 'live', startedAt } : s,
              ),
            });
            await setAgentStatus(db, agent.id, 'running');
            // What the step's repository tools do, kept whether the step finishes or fails, and
            // saved onto the step as it grows. A step resumed after a restart starts from what it
            // had recorded, so its record covers both attempts (D33).
            const work: WorkItem[] = workItems(step.work);
            const saveWork = () =>
              save({
                plan: run!.plan.map((s) => (s.id === step.id ? { ...s, work: foldWork(work) } : s)),
              });
            // A reviewing agent may send the work back while rounds remain (D31).
            const remaining = agent.sendBackRounds - ((step.round ?? 1) - 1);
            // In a template only a judging step sends back (D40): the Test Agent writing tests
            // never returns them to the goal it was given.
            const mayJudge = step.judges === true || !run!.input.template;
            const sendBack: { remaining: number; findings?: string } | undefined =
              remaining > 0 && mayJudge ? { remaining } : undefined;
            // A step that splits a spec records goals against the spec's numbered criteria (D39).
            const upstream = step.dependsOn.map((d) => byId.get(d)!).filter(Boolean);
            const spec = upstream.find((s) => s.document && !s.recordsGoals)?.document;
            const criteria = spec ? acceptanceCriteria(spec) : [];
            const recordGoals = step.recordsGoals
              ? { criteria: criteria.length ? criteria.map((c) => c.n) : null }
              : undefined;
            try {
              const outcome = await runStep({
                db,
                backend: this.backend(),
                run: run!,
                step,
                agent,
                upstream,
                memory,
                attachments: run!.input.attachments,
                sandboxDir,
                conversation,
                work,
                sendBack,
                recordGoals,
                repoPaths,
                onWork: saveWork,
                signal,
              });
              const goals = (recordGoals as { goals?: Goal[] } | undefined)?.goals;
              if (recordGoals && !goals) {
                throw new EngineError(
                  'no_goals',
                  `${agent.name} finished without recording goals that pass Magpipe's checks.`,
                );
              }
              await this.finishStep(save, () => run!, step.id, {
                status: 'done',
                result: { summary: outcome.summary },
                // The goals are the step's document: what the review reads and the run hands over.
                ...(goals ? { goals, document: renderGoals(goals, criteria) } : {}),
                ...(outcome.document ? { document: outcome.document } : {}),
                // A judging step's verdict, read once from its result (D38).
                ...(step.judges ? { verdict: parseVerdict(outcome.summary) ?? undefined } : {}),
                usage: outcome.usage,
                work: foldWork(work),
                ...(sendBack?.findings ? { sentBack: sendBack.findings } : {}),
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
                work: foldWork(work),
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
              release();
              await setAgentStatus(db, agent.id, 'idle');
            }
          }),
        );
        if (capStop) throw capStop;

        // A reviewing step that sent the work back reopens it: the steps it reviews run again
        // with its findings, then it reviews once more (D31). Usage so far stays counted.
        for (const step of wave) {
          const current = run.plan.find((s) => s.id === step.id);
          const agent = agents.find((a) => a.id === current?.agentId);
          if (!current || !agent || current.status !== 'done' || !current.sentBack) continue;
          const round = current.round ?? 1;
          if (round > agent.sendBackRounds) continue;
          const reopen = sendBackSet(run.plan, current.id);
          const spent = run.plan
            .filter((s) => reopen.has(s.id) && s.usage)
            .reduce((acc, s) => addUsage(acc, s.usage!), ZERO_USAGE);
          const findings = current.sentBack;
          await save({
            usage: addUsage(run.usage, spent),
            plan: run.plan.map((s) =>
              reopen.has(s.id)
                ? {
                    ...s,
                    status: 'todo' as const,
                    round: (s.round ?? 1) + 1,
                    feedback:
                      s.id === current.id
                        ? `Your findings last round sent the work back: ${findings} Check whether they were addressed.`
                        : `${agent.name} sent the work back after round ${round}: ${findings}`,
                    result: undefined,
                    usage: undefined,
                    error: undefined,
                    startedAt: undefined,
                    finishedAt: undefined,
                    sentBack: undefined,
                    verdict: undefined,
                    approvedAt: undefined,
                    approvalNote: undefined,
                  }
                : s,
            ),
          });
          const others = run.plan.filter((s) => reopen.has(s.id) && s.id !== current.id);
          await emit(
            'message',
            `Round ${round + 1}: ${agent.name} sent the work back to ${others.map((s) => `“${s.title}”`).join(' and ')}.`,
            { round: round + 1, findings },
            current.id,
          );
        }
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

      // 2b. a step that waits for approval holds its dependants: the run waits for the operator
      // and gives the engine back. Approving puts it in the queue again (D30).
      const holding = run.plan.filter(
        (s) =>
          held(s) &&
          run!.plan.some(
            (d) => d.id !== MERGE_STEP_ID && d.status === 'todo' && d.dependsOn.includes(s.id),
          ),
      );
      if (holding.length > 0) {
        await save({ status: 'waiting' });
        await emit(
          'message',
          `Waiting for you: approve ${holding.map((s) => `“${s.title}”`).join(' and ')} to go on.`,
          { waitingFor: holding.map((s) => s.id) },
        );
        return;
      }

      const mergeStep = run.plan.find((s) => s.id === MERGE_STEP_ID);
      // A plan that wrote a document answers with it, and needs no model to do so (D37).
      const document = documentAnswer(run.plan, names);
      if (!document) {
        const mergeStop = await this.spendCapStop(db, `“${mergeStep?.title ?? 'Merge results'}”`);
        if (mergeStop) throw mergeStop;
      }
      const mergeStartedAt = new Date().toISOString();
      await save({
        plan: run.plan.map((s) =>
          s.id === MERGE_STEP_ID ? { ...s, status: 'live', startedAt: mergeStartedAt } : s,
        ),
      });
      const merged = document
        ? { markdown: document, usage: ZERO_USAGE }
        : await withRetries(
            () =>
              mergeRun({
                backend: this.backend(),
                model: orchestratorModel,
                run: run!,
                steps: run!.plan,
                agentNames: names,
                conversation,
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
                result: {
                  summary: document ? 'Handed over the document' : 'Composed the final answer',
                },
              }
            : s,
        ),
        status: 'done',
        output: { markdown: merged.markdown, artifacts: runArtifacts(run.plan) },
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

  /**
   * The daily spend cap (D32): null while today's spend is under the cap or there is none, else
   * the error the run stops with. Read fresh each time, so a cap raised mid-run counts at once.
   */
  private async spendCapStop(db: Db, before: string): Promise<EngineError | null> {
    const spend = await spendToday(db);
    return capReached(spend) ? new EngineError('spend_cap', spendCapMessage(spend, before)) : null;
  }

  /** Runs an action step (D38) and records its outcome; a failure fails the step, not the run. */
  private async runActionStep(
    db: Db,
    save: (patch: Partial<Run>) => Promise<void>,
    current: () => Run,
    step: Step,
    names: Map<string, string>,
    emit: (
      kind: RunEventKind,
      text: string,
      payload?: unknown,
      stepId?: string | null,
    ) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    await save({
      plan: current().plan.map((s) => (s.id === step.id ? { ...s, status: 'live', startedAt } : s)),
    });
    try {
      const outcome = await withRetries(
        () =>
          runAction({
            db,
            run: current(),
            step: step as Step & { action: NonNullable<Step['action']> },
            agentNames: names,
            signal,
          }).catch((err: unknown) => {
            // Linear out of reach is worth another try; a refused key is not.
            throw err instanceof TrackerError
              ? new EngineError(`tracker_${err.code}`, err.message, err.code === 'network')
              : err;
          }),
        {
          signal,
          onRetry: (f, n) => void emit('error', `Retry ${n}: ${f.message}`, null, step.id),
        },
      );
      await this.finishStep(save, current, step.id, {
        status: outcome.status,
        result: { summary: outcome.summary.slice(0, 1000) },
        ...(outcome.document ? { document: outcome.document } : {}),
      });
      await emit('message', outcome.summary, null, step.id);
    } catch (err) {
      if (signal.aborted) throw err;
      const f =
        err instanceof EngineError
          ? { code: err.code, message: err.message }
          : describeFailure(err);
      await this.finishStep(save, current, step.id, {
        status: 'failed',
        error: { code: f.code, message: f.message },
      });
      await emit('error', f.message, { code: f.code }, step.id);
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
    // `websearch_to_tsquery` ANDs words by default; any one matching word makes a fact relevant.
    words.length ? listMemory(db, { q: words.join(' OR ') }) : Promise.resolve([] as MemoryEntry[]),
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

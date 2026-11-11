import 'server-only';
import { and, count, desc, eq, gte, ilike, or, sql } from 'drizzle-orm';
import type { Db } from './db';
import { nextRunDisplayId } from './db';
import * as t from './db/schema';
import { newId } from './ids';
import { ZERO_USAGE } from './pricing';
import { computeRunsStats, threadTurn, type RunsStats, type ThreadTurn } from './runs-util';
import { emitEvent } from './engine/events';
import { runStatuses, type Run, type RunStatus, type Step } from './schemas';

/**
 * A new queued run. With `plan` (a template's, D37) the run starts from it and the engine skips
 * planning; the trail says where the plan came from.
 */
export async function createRun(
  db: Db,
  input: Run['input'],
  parentRunId: string | null = null,
  preset?: { plan: Step[]; text: string; createdBy?: string },
): Promise<Run> {
  const run: Run = {
    id: newId('run'),
    displayId: await nextRunDisplayId(db),
    input,
    status: 'queued',
    plan: preset?.plan ?? [],
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    usage: ZERO_USAGE,
    output: null,
    parentRunId,
    dismissedAt: null,
    createdBy: preset?.createdBy ?? 'user',
    createdAt: new Date(),
  };
  await db.insert(t.runs).values(run);
  if (preset) {
    await emitEvent(db, {
      runId: run.id,
      stepId: null,
      agentId: null,
      kind: 'plan',
      text: preset.text,
      payload: {
        steps: preset.plan.map((s) => ({
          id: s.id,
          agentId: s.agentId,
          title: s.title,
          dependsOn: s.dependsOn,
        })),
      },
    });
  }
  return run;
}

/**
 * Lets a waiting run go on (D30): every finished step by an agent that waits for approval is
 * marked approved, with the operator's note if there is one, and the run is queued again. The
 * caller hands it to the engine. Returns undefined when the run is not waiting.
 */
export async function approveRun(db: Db, id: string, note?: string): Promise<Run | undefined> {
  const [current] = await db.select().from(t.runs).where(eq(t.runs.id, id));
  if (!current || current.status !== 'waiting') return undefined;
  const pausing = new Set(
    (await db.select({ id: t.agents.id, pauseAfter: t.agents.pauseAfter }).from(t.agents))
      .filter((a) => a.pauseAfter)
      .map((a) => a.id),
  );
  const approvedAt = new Date().toISOString();
  const text = note?.trim();
  const plan = current.plan.map((s) =>
    s.status === 'done' && s.agentId !== null && pausing.has(s.agentId) && !s.approvedAt
      ? { ...s, approvedAt, ...(text ? { approvalNote: text } : {}) }
      : s,
  );
  const [row] = await db
    .update(t.runs)
    .set({ plan, status: 'queued' })
    .where(and(eq(t.runs.id, id), eq(t.runs.status, 'waiting')))
    .returning();
  return row;
}

/** Closes (or reopens) a run's card on Home. The Runs screen keeps listing it. */
export async function setRunDismissed(
  db: Db,
  id: string,
  dismissed: boolean,
): Promise<Run | undefined> {
  const [row] = await db
    .update(t.runs)
    .set({ dismissedAt: dismissed ? new Date() : null })
    .where(eq(t.runs.id, id))
    .returning();
  return row;
}

/**
 * The conversation a run continues: its ancestors by `parentRunId`, oldest first, as the
 * operator's task and Magpipe's answer. A re-fly repeats its parent's task, so an ancestor whose
 * task equals its child's is a retry and is folded away. Capped so a long thread cannot grow the
 * prompt without bound.
 */
export async function loadThread(db: Db, run: Run, limit = 6): Promise<ThreadTurn[]> {
  const turns: ThreadTurn[] = [];
  let cursor: Run | undefined = run;
  const seen = new Set<string>([run.id]);
  while (cursor?.parentRunId && turns.length < limit && !seen.has(cursor.parentRunId)) {
    seen.add(cursor.parentRunId);
    const [parent]: Run[] = await db.select().from(t.runs).where(eq(t.runs.id, cursor.parentRunId));
    if (!parent) break;
    if (parent.input.text.trim() !== cursor.input.text.trim()) turns.unshift(threadTurn(parent));
    cursor = parent;
  }
  return turns;
}

/** Accepts a run id (`run_…`) or the human display id (`flight_…`). */
export async function getRun(db: Db, idOrDisplayId: string): Promise<Run | undefined> {
  const column = idOrDisplayId.startsWith('flight_') ? t.runs.displayId : t.runs.id;
  const [run] = await db.select().from(t.runs).where(eq(column, idOrDisplayId));
  return run;
}

export type RunListFilter = { status?: RunStatus; q?: string; limit?: number };

export async function listRuns(
  db: Db,
  filter: RunListFilter = {},
): Promise<{ runs: Run[]; counts: Record<RunStatus | 'all', number> }> {
  const q = filter.q?.trim();
  const where = and(
    filter.status ? eq(t.runs.status, filter.status) : undefined,
    q
      ? or(ilike(sql`${t.runs.input}->>'text'`, `%${q}%`), ilike(t.runs.displayId, `%${q}%`))
      : undefined,
  );
  const [rows, byStatus] = await Promise.all([
    db
      .select()
      .from(t.runs)
      .where(where)
      .orderBy(desc(t.runs.createdAt))
      .limit(filter.limit ?? 50),
    db.select({ status: t.runs.status, n: count() }).from(t.runs).groupBy(t.runs.status),
  ]);
  const counts = Object.fromEntries(runStatuses.map((s) => [s, 0])) as Record<
    RunStatus | 'all',
    number
  >;
  counts.all = 0;
  for (const row of byStatus) {
    counts[row.status] = row.n;
    counts.all += row.n;
  }
  return { runs: rows, counts };
}

/** The Runs screen's stats strip (spec §3.4): runs today · succeeded 7d · median duration · spend. */
export async function runsStats(db: Db, now = new Date()): Promise<RunsStats> {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      status: t.runs.status,
      createdAt: t.runs.createdAt,
      finishedAt: t.runs.finishedAt,
      durationMs: t.runs.durationMs,
      usage: t.runs.usage,
    })
    .from(t.runs)
    .where(gte(t.runs.createdAt, since));
  return computeRunsStats(rows, now);
}

export type HomeStats = {
  activeAgents: number;
  runsToday: number;
  queued: number;
  tokensToday: number;
  spendToday: number;
};

/** `GET /api/stats/home` (spec §8): the orb's counters. "Today" is the server's local day. */
export async function homeStats(db: Db, now = new Date()): Promise<HomeStats> {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const [[active], [queued], today] = await Promise.all([
    db.select({ n: count() }).from(t.agents).where(eq(t.agents.status, 'running')),
    db.select({ n: count() }).from(t.runs).where(eq(t.runs.status, 'queued')),
    db.select({ usage: t.runs.usage }).from(t.runs).where(gte(t.runs.createdAt, dayStart)),
  ]);
  return {
    activeAgents: active?.n ?? 0,
    runsToday: today.length,
    queued: queued?.n ?? 0,
    tokensToday: today.reduce((n, r) => n + r.usage.inputTokens + r.usage.outputTokens, 0),
    spendToday: Math.round(today.reduce((n, r) => n + r.usage.costUsd, 0) * 10_000) / 10_000,
  };
}

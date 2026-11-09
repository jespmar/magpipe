import 'server-only';
import { and, count, desc, eq, gte, ilike, or, sql } from 'drizzle-orm';
import type { Db } from './db';
import { nextRunDisplayId } from './db';
import * as t from './db/schema';
import { newId } from './ids';
import { ZERO_USAGE } from './pricing';
import { computeRunsStats, type RunsStats } from './runs-util';
import { runStatuses, type Attachment, type Run, type RunStatus } from './schemas';

export async function createRun(
  db: Db,
  input: { text: string; attachments: Attachment[] },
  parentRunId: string | null = null,
): Promise<Run> {
  const run: Run = {
    id: newId('run'),
    displayId: await nextRunDisplayId(db),
    input,
    status: 'queued',
    plan: [],
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    usage: ZERO_USAGE,
    output: null,
    parentRunId,
    createdBy: 'user',
    createdAt: new Date(),
  };
  await db.insert(t.runs).values(run);
  return run;
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

/**
 * The daily spend cap (D32): what today's runs have cost so far, read in one aggregate query,
 * and the words the engine stops a run with once it is reached. "Today" is the server's local
 * day and a run counts on the day it was asked for, as on Home and the Runs screen.
 */
import { and, gte, sql } from 'drizzle-orm';
import type { Db } from './db';
import * as t from './db/schema';
import { formatUsd } from './runs-util';

export type SpendToday = {
  /** The cap in force, in dollars; null when there is none (a cap of 0, or no settings row). */
  capUsd: number | null;
  /** What runs asked for today have cost so far, including the steps of runs still going. */
  spentUsd: number;
};

/** Midnight at the start of `now`'s day, in the server's local time zone. */
export function startOfLocalDay(now: Date): Date {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day;
}

/**
 * Today's spend and the cap, in one query. A finished run's usage already holds its steps; a run
 * that is still going holds only its plan's cost so far, so its steps' usage is added from the
 * plan. Cheap enough to run before every step: one indexed range over today's runs.
 */
export async function spendToday(
  db: Db,
  now = new Date(),
  /** A factory project's own cap and runs (D45), instead of the workspace's. */
  project?: { id: string; spendCapUsd: number | null },
): Promise<SpendToday> {
  const stepsCost = sql`(select coalesce(sum((s->'usage'->>'costUsd')::float8), 0) from jsonb_array_elements(${t.runs.plan}) s)`;
  const [row] = await db
    .select({
      capUsd: project
        ? sql<number | null>`${project.spendCapUsd ?? 0}::float8`
        : sql<number | null>`(select ${t.settings.spendCapUsd} from ${t.settings} limit 1)`,
      spentUsd: sql<number>`coalesce(sum(
        coalesce((${t.runs.usage}->>'costUsd')::float8, 0)
        + case when ${t.runs.status} in ('done', 'failed', 'cancelled') then 0 else ${stepsCost} end
      ), 0)`,
    })
    .from(t.runs)
    .where(
      and(
        gte(t.runs.createdAt, startOfLocalDay(now)),
        project ? sql`${t.runs.input}->>'projectId' = ${project.id}` : undefined,
      ),
    );
  const cap = row?.capUsd === null || row?.capUsd === undefined ? 0 : Number(row.capUsd);
  return {
    capUsd: cap > 0 ? cap : null,
    spentUsd: Math.round(Number(row?.spentUsd ?? 0) * 10_000) / 10_000,
  };
}

/** True once a cap is set and today's spend has reached it. */
export function capReached(spend: SpendToday): boolean {
  return spend.capUsd !== null && spend.spentUsd >= spend.capUsd;
}

/** The cap as the operator set it: `$50.00`, or "no cap" for 0. */
export function capText(capUsd: number | null): string {
  return capUsd && capUsd > 0 ? `$${capUsd.toFixed(2)}` : 'no cap';
}

/**
 * Why the run stopped, for its trail and the run page. `before` is what did not start:
 * "planning", or a step's title in quotes.
 */
export function spendCapMessage(spend: SpendToday, before: string, project?: string): string {
  if (project) {
    return `Today’s spend on ${project} (${formatUsd(spend.spentUsd)}) reached its ${capText(spend.capUsd)} cap, so the run stopped before ${before}. Raise the project’s cap on Factory → Projects to go on.`;
  }
  return `Today’s spend (${formatUsd(spend.spentUsd)}) reached the ${capText(spend.capUsd)} cap, so the run stopped before ${before}. Raise the cap in Settings to go on.`;
}

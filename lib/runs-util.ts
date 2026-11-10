/** Pure helpers for the Runs screens, safe on the client. Tested in tests/runs-util.test.ts. */
import { formatDuration, formatTokens } from './format';
import type { Run, RunStatus, Step } from './schemas';

export const RUN_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed' },
  { key: 'queued', label: 'Queued' },
] as const;

export type RunFilter = (typeof RUN_FILTERS)[number]['key'];

export function matchesRunFilter(status: RunStatus, filter: RunFilter): boolean {
  return filter === 'all' || status === filter;
}

export type AgentChip = { id: string; name: string; initials: string; slug: string };

/** Task text, flight id and the names of the birds that flew it. */
export function matchesRunQuery(
  run: Pick<Run, 'displayId' | 'input' | 'plan'>,
  q: string,
  agents: readonly AgentChip[],
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (run.input.text.toLowerCase().includes(needle)) return true;
  if (run.displayId.toLowerCase().includes(needle)) return true;
  return runAgentIds(run).some((id) =>
    agents
      .find((a) => a.id === id)
      ?.name.toLowerCase()
      .includes(needle),
  );
}

/** One turn of a conversation: the operator's task and what Magpipe answered. */
export type ThreadTurn = {
  id: string;
  displayId: string;
  status: RunStatus;
  text: string;
  /** The merged result, or null when the run did not produce one. */
  answer: string | null;
};

export function threadTurn(
  run: Pick<Run, 'id' | 'displayId' | 'status' | 'input' | 'output'>,
): ThreadTurn {
  return {
    id: run.id,
    displayId: run.displayId,
    status: run.status,
    text: run.input.text,
    answer: run.output?.markdown ?? null,
  };
}

/** What a run without a result says in its place. */
export function resultPlaceholder(status: RunStatus): string {
  switch (status) {
    case 'queued':
    case 'running':
      return 'The merged result appears here when the flight lands.';
    case 'failed':
      return 'This run failed before a result was merged.';
    case 'cancelled':
      return 'This run was cancelled before a result was merged.';
    default:
      return 'No result was recorded for this run.';
  }
}

const TURN_CAP = 2_000;
const clip = (s: string) => (s.length > TURN_CAP ? `${s.slice(0, TURN_CAP - 1).trimEnd()}…` : s);

/** The thread as prompt text: the earlier tasks and answers, oldest first, each clipped. */
export function threadText(turns: readonly ThreadTurn[]): string {
  return turns
    .map(
      (t) =>
        `Operator: ${clip(t.text.trim())}\nMagpipe: ${clip(
          (t.answer ?? resultPlaceholder(t.status)).trim(),
        )}`,
    )
    .join('\n\n');
}

/**
 * The conversation of a run among runs already loaded (Home's cards): its ancestors by
 * `parentRunId`, oldest first, with re-flies (same task as the child) folded away, then the run
 * itself. Ancestors outside the loaded set are simply not shown.
 */
export function threadFor<T extends Pick<Run, 'id' | 'parentRunId' | 'input'>>(
  runs: readonly T[],
  selected: T,
  limit = 6,
): T[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const chain: T[] = [];
  const seen = new Set<string>([selected.id]);
  let cursor: T | undefined = selected;
  while (cursor?.parentRunId && chain.length < limit && !seen.has(cursor.parentRunId)) {
    seen.add(cursor.parentRunId);
    const parent = byId.get(cursor.parentRunId);
    if (!parent) break;
    if (parent.input.text.trim() !== cursor.input.text.trim()) chain.unshift(parent);
    cursor = parent;
  }
  chain.push(selected);
  return chain;
}

/** Distinct agents in plan order, the orchestrator left out. */
export function runAgentIds(run: Pick<Run, 'plan'>): string[] {
  const seen = new Set<string>();
  for (const s of run.plan) if (s.agentId && !seen.has(s.agentId)) seen.add(s.agentId);
  return Array.from(seen);
}

export const LIVE: ReadonlySet<RunStatus> = new Set(['queued', 'running']);

/** `6m 40s`, `48s`, `1h 02m` — the stats strip's median. */
export function formatDurationWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** `$18.40`; amounts under a cent show as `<$0.01` rather than a false zero. */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export type RunsStats = {
  runsToday: number;
  /** done / (done + failed) over runs finished in the last 7 days, 0–100; null without any. */
  successPct7d: number | null;
  /** Median of finished runs' durations over the last 7 days; null without any. */
  medianDurationMs: number | null;
  spendToday: number;
};

type RunForStats = Pick<Run, 'status' | 'createdAt' | 'finishedAt' | 'durationMs' | 'usage'>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function computeRunsStats(runs: readonly RunForStats[], now: Date = new Date()): RunsStats {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const weekAgo = now.getTime() - WEEK_MS;
  let runsToday = 0;
  let spendToday = 0;
  let done = 0;
  let failed = 0;
  const durations: number[] = [];
  for (const r of runs) {
    if (r.createdAt >= dayStart) {
      runsToday += 1;
      spendToday += r.usage.costUsd;
    }
    const finished = r.finishedAt ?? null;
    if (!finished || finished.getTime() < weekAgo) continue;
    if (r.status === 'done') done += 1;
    if (r.status === 'failed') failed += 1;
    if (r.durationMs !== null && (r.status === 'done' || r.status === 'failed')) {
      durations.push(r.durationMs);
    }
  }
  durations.sort((a, b) => a - b);
  const mid = durations.length >> 1;
  const median =
    durations.length === 0
      ? null
      : durations.length % 2
        ? durations[mid]!
        : Math.round((durations[mid - 1]! + durations[mid]!) / 2);
  return {
    runsToday,
    successPct7d: done + failed > 0 ? Math.round((done / (done + failed)) * 100) : null,
    medianDurationMs: median,
    spendToday: Math.round(spendToday * 10_000) / 10_000,
  };
}

const tokensOf = (s: Step) => (s.usage ? s.usage.inputTokens + s.usage.outputTokens : 0);

/** The step card's mono meta line: what a reader checks about a step at a glance. */
export function stepMeta(step: Step, now: Date = new Date()): string {
  switch (step.status) {
    case 'done': {
      const dur =
        step.startedAt && step.finishedAt
          ? formatDuration(Date.parse(step.finishedAt) - Date.parse(step.startedAt))
          : null;
      const tokens = tokensOf(step);
      // No false zero: a step without usage says what it was instead of "0 tok".
      const spend =
        tokens > 0 ? `${formatTokens(tokens)} tok` : step.agentId === null ? 'plan' : null;
      return [dur, spend].filter(Boolean).join(' · ') || 'done';
    }
    case 'live':
      return `running · ${
        step.startedAt ? formatDuration(now.getTime() - Date.parse(step.startedAt)) : '00:00'
      }`;
    case 'failed':
      return step.error?.code ? `failed · ${step.error.code}` : 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'waiting';
  }
}

/** A page title stays a title: long tasks are cut, the full text lives in the input section. */
export function headTitle(text: string, max = 140): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The last error event's text, for the failed flight's one-line reason under the head. */
export function lastErrorText(events: readonly { kind: string; text: string }[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === 'error') return events[i]!.text;
  }
  return null;
}

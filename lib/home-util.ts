/** Pure helpers for the Home screen, safe on the client. Tested in tests/home-util.test.ts. */
import { formatDuration, formatTokens, relativeTime } from './format';
import type { Agent, AgentStatus, Run, RunEvent, Step } from './schemas';

export type AgentCardData = {
  id: string;
  slug: string;
  name: string;
  role: string;
  initials: string;
  model: string;
  status: AgentStatus;
  /** The live step's title while the agent is running; otherwise the last step it finished. */
  task: string | null;
  live: boolean;
  /** Completion of the current run, 0–1, while the agent is running; null otherwise. */
  progress: number | null;
  /** Tokens spent so far in the current run, or by the last finished step. */
  tokens: number | null;
  /** ISO time: when the live step started, or when the last step finished. */
  since: string | null;
};

type RunForCard = Pick<Run, 'id' | 'status' | 'plan'>;

const SETTLED = new Set<Step['status']>(['done', 'failed', 'skipped']);

const stepTokens = (s: Step) => (s.usage ? s.usage.inputTokens + s.usage.outputTokens : 0);

/** What one card says about an agent, from the recent runs (newest first). */
export function agentCard(agent: Agent, runs: readonly RunForCard[]): AgentCardData {
  const base = {
    id: agent.id,
    slug: agent.slug,
    name: agent.name,
    role: agent.role,
    initials: agent.initials,
    model: agent.model,
    status: agent.status,
  };
  for (const run of runs) {
    if (run.status !== 'running') continue;
    const live = run.plan.find((s) => s.agentId === agent.id && s.status === 'live');
    if (!live) continue;
    const settled = run.plan.filter((s) => SETTLED.has(s.status)).length;
    const tokens = run.plan
      .filter((s) => s.agentId === agent.id)
      .reduce((n, s) => n + stepTokens(s), 0);
    return {
      ...base,
      task: live.title,
      live: true,
      progress: run.plan.length > 0 ? settled / run.plan.length : 0,
      tokens,
      since: live.startedAt ?? null,
    };
  }
  let last: Step | null = null;
  for (const run of runs) {
    for (const s of run.plan) {
      if (s.agentId !== agent.id || !s.finishedAt) continue;
      if (s.status !== 'done' && s.status !== 'failed') continue;
      if (!last || s.finishedAt > last.finishedAt!) last = s;
    }
  }
  if (last) {
    return {
      ...base,
      task: last.title,
      live: false,
      progress: null,
      tokens: last.usage ? stepTokens(last) : null,
      since: last.finishedAt!,
    };
  }
  return { ...base, task: null, live: false, progress: null, tokens: null, since: null };
}

/** "12k tok · 00:42" while running, "4k tok · 2 hours ago" after, "no runs yet" before. */
export function cardFooter(card: AgentCardData, now: Date = new Date()): string {
  if (!card.since) return 'no runs yet';
  const since = new Date(card.since);
  const when = card.live
    ? formatDuration(now.getTime() - since.getTime())
    : relativeTime(since, now);
  return `${formatTokens(card.tokens ?? 0)} tok · ${when}`;
}

/** 24 B, 1.2 kB, 3.4 MB — the attachment chip's size. */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${Math.round(n / 100) / 10} kB`;
  return `${Math.round(n / 100_000) / 10} MB`;
}

/** `14:02:17` — the flight log's time column (24 h, the operator's clock). */
export function clockTime(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

/** A run event as the flight log shows it: the agent's name resolved, the time serialisable. */
export type FlightEvent = {
  seq: number;
  ts: string;
  /** null = the orchestrator. */
  agentId: string | null;
  agent: string;
  kind: RunEvent['kind'];
  text: string;
};

export type RunEventLike = Omit<RunEvent, 'ts'> & { ts: Date | string };

export function toFlightEvent(
  event: RunEventLike,
  names: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): FlightEvent {
  const lookup = (id: string) =>
    names instanceof Map ? names.get(id) : (names as Readonly<Record<string, string>>)[id];
  const name = event.agentId === null ? 'Magpipe' : (lookup(event.agentId) ?? 'agent');
  return {
    seq: event.seq,
    ts: typeof event.ts === 'string' ? event.ts : event.ts.toISOString(),
    agentId: event.agentId,
    agent: name,
    kind: event.kind,
    text: event.text,
  };
}

/** Server replay and streamed events overlap; one list, by sequence, capped. */
export function mergeEvents(
  a: readonly FlightEvent[],
  b: readonly FlightEvent[],
  cap = 200,
): FlightEvent[] {
  const bySeq = new Map<number, FlightEvent>();
  for (const e of a) bySeq.set(e.seq, e);
  for (const e of b) bySeq.set(e.seq, e);
  return Array.from(bySeq.values())
    .sort((x, y) => x.seq - y.seq)
    .slice(-cap);
}

export const LIVE_RUN_STATUSES: ReadonlySet<Run['status']> = new Set(['queued', 'running']);

/** Home's first choice among the cards: the flight that is live, else the newest. */
export function defaultSelected<T extends Pick<Run, 'status'>>(runs: readonly T[]): T | null {
  return runs.find((r) => LIVE_RUN_STATUSES.has(r.status)) ?? runs[0] ?? null;
}

/** A run that came back from the API as JSON: its dates are strings until revived. */
export function reviveRun(run: Run): Run {
  const date = (v: Date | string | null) => (v === null ? null : new Date(v));
  return {
    ...run,
    startedAt: date(run.startedAt),
    finishedAt: date(run.finishedAt),
    dismissedAt: date(run.dismissedAt),
    createdAt: new Date(run.createdAt),
  };
}

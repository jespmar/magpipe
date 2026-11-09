/** Pure helpers for agents, safe on the client. Tested in tests/agents.test.ts. */
import type { Agent, AgentStatus, Run } from './schemas';

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'agent';
}

/** "Researcher" → "RE", "Data Scout" → "DS". The editor lets the operator override it. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export type AgentStats = {
  /** Distinct runs in the last 7 days with a step for this agent. */
  runs7d: number;
  /** done / (done + failed) over the agent's steps, 0–100; null without finished steps. */
  successPct: number | null;
  /** Mean tokens per step with usage; null without any. */
  avgTokens: number | null;
};

type RunForStats = Pick<Run, 'id' | 'createdAt' | 'plan'>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function computeAgentStats(
  agentId: string,
  runs: readonly RunForStats[],
  now: Date = new Date(),
): AgentStats {
  const since = now.getTime() - WEEK_MS;
  const runIds = new Set<string>();
  let done = 0;
  let failed = 0;
  let tokenSum = 0;
  let tokenSteps = 0;
  for (const run of runs) {
    if (run.createdAt.getTime() < since) continue;
    for (const step of run.plan) {
      if (step.agentId !== agentId) continue;
      runIds.add(run.id);
      if (step.status === 'done') done += 1;
      if (step.status === 'failed') failed += 1;
      if (step.usage) {
        tokenSum += step.usage.inputTokens + step.usage.outputTokens;
        tokenSteps += 1;
      }
    }
  }
  return {
    runs7d: runIds.size,
    successPct: done + failed > 0 ? Math.round((done / (done + failed)) * 100) : null,
    avgTokens: tokenSteps > 0 ? Math.round(tokenSum / tokenSteps) : null,
  };
}

/** "Read + write · facts, rate limits" / "Read · all namespaces" / "No memory access". */
export function describeMemoryScope(
  scope: Agent['memoryScope'],
  namespaces: readonly { id: string; label: string }[],
): string {
  const label = (ids: string[]) =>
    ids.length === namespaces.length && namespaces.length > 0
      ? 'all namespaces'
      : ids.map((id) => namespaces.find((n) => n.id === id)?.label.toLowerCase() ?? id).join(', ');
  const read = [...scope.read].sort();
  const write = [...scope.write].sort();
  if (read.length === 0 && write.length === 0) return 'No memory access';
  if (write.length === 0) return `Read · ${label(read)}`;
  if (read.length === 0) return `Write · ${label(write)}`;
  if (read.join() === write.join()) return `Read + write · ${label(read)}`;
  return `Read · ${label(read)} · Write · ${label(write)}`;
}

export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

/** Filter buckets on the Agents screen (spec §3.3). Paused birds sit with the idle ones. */
export type AgentFilter = 'all' | 'running' | 'waiting' | 'idle';

export const AGENT_FILTERS: readonly { key: AgentFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'idle', label: 'Idle' },
];

export function matchesFilter(status: AgentStatus, filter: AgentFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'idle') return status === 'idle' || status === 'paused';
  return status === filter;
}

export function matchesQuery(
  agent: Pick<Agent, 'name' | 'role' | 'model' | 'description'>,
  q: string,
) {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [agent.name, agent.role, agent.model, agent.description].some((s) =>
    s.toLowerCase().includes(needle),
  );
}

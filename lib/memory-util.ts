/** Pure helpers for the Memory screen, safe on the client. Tested in tests/memory-util.test.ts. */
import { shortWhen } from './format';
import type { MemoryEntry } from './schemas';

export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** A memory entry as the API serialises it: the four date fields arrive as ISO strings. */
export type MemoryEntryJson = Omit<
  MemoryEntry,
  'expiresAt' | 'verifiedAt' | 'createdAt' | 'updatedAt'
> & {
  expiresAt: string | null;
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
};

export function reviveEntry(json: MemoryEntryJson): MemoryEntry {
  return {
    ...json,
    expiresAt: json.expiresAt ? new Date(json.expiresAt) : null,
    verifiedAt: new Date(json.verifiedAt),
    createdAt: new Date(json.createdAt),
    updatedAt: new Date(json.updatedAt),
  };
}

/** Verified more than 30 days ago, or flagged by a job (spec §7.3). Computed on read (D14). */
export function isStale(
  entry: Pick<MemoryEntry, 'stale' | 'verifiedAt'>,
  now = new Date(),
): boolean {
  return entry.stale || now.getTime() - entry.verifiedAt.getTime() > STALE_AFTER_MS;
}

export function isExpired(entry: Pick<MemoryEntry, 'expiresAt'>, now = new Date()): boolean {
  return entry.expiresAt !== null && entry.expiresAt.getTime() <= now.getTime();
}

/** `0.96`, `1.00` — two decimals in mono, as the artboard shows. */
export function formatConfidence(value: number): string {
  return value.toFixed(2);
}

/** `2026-12-06` or `never`. */
export function formatExpires(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : 'never';
}

export type AuthorChip = { id: string; name: string; initials: string };

/** Who wrote or read a fact, in plain words: an agent's initials, or "you". */
export function authorLabel(writtenBy: string, agents: readonly AuthorChip[]): string {
  if (writtenBy === 'user') return 'you';
  return agents.find((a) => a.id === writtenBy)?.initials ?? writtenBy;
}

export function authorName(writtenBy: string, agents: readonly AuthorChip[]): string {
  if (writtenBy === 'user') return 'you';
  return agents.find((a) => a.id === writtenBy)?.name ?? writtenBy;
}

export function matchesMemoryQuery(
  entry: Pick<MemoryEntry, 'key' | 'value' | 'source' | 'ns'>,
  q: string,
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [entry.key, entry.value, entry.source, entry.ns].some((s) =>
    s.toLowerCase().includes(needle),
  );
}

/** The raw record as the detail's `<pre>` shows it: the fields a bird would read, snake_case. */
export function rawJson(entry: MemoryEntry, agents: readonly AuthorChip[]): string {
  return JSON.stringify(
    {
      ns: entry.ns,
      key: entry.key,
      value: entry.value,
      ...(entry.data !== null && entry.data !== undefined ? { data: entry.data } : {}),
      confidence: entry.confidence,
      source: entry.source,
      written_by: authorName(entry.writtenBy, agents),
      read_by: entry.readBy.map((id) => authorName(id, agents)),
      expires: entry.expiresAt ? entry.expiresAt.toISOString() : null,
      verified_at: entry.verifiedAt.toISOString(),
      updated_at: entry.updatedAt.toISOString(),
      history: entry.history.length,
    },
    null,
    2,
  );
}

export type NestHealthSummary = {
  facts: number;
  stale: number;
  conflicts: number;
  expired: number;
  /** 0–100, facts verified in the last 30 days; null when there are no facts. */
  verifiedPct: number | null;
};

export function summarizeHealth(
  entries: readonly Pick<MemoryEntry, 'stale' | 'conflict' | 'verifiedAt' | 'expiresAt'>[],
  now = new Date(),
): NestHealthSummary {
  const facts = entries.length;
  const stale = entries.filter((e) => isStale(e, now)).length;
  const conflicts = entries.filter((e) => e.conflict).length;
  const expired = entries.filter((e) => isExpired(e, now)).length;
  return {
    facts,
    stale,
    conflicts,
    expired,
    verifiedPct: facts === 0 ? null : Math.round(((facts - stale) / facts) * 100),
  };
}

export function updatedLabel(entry: Pick<MemoryEntry, 'updatedAt'>, now = new Date()): string {
  return shortWhen(entry.updatedAt, now);
}

/** The namespace whose entries steer every plan: the operator's standing instructions (D34). */
export const STANDING_NS = 'decisions';

/**
 * How many memories reach a plan: every `decisions` entry first, most recently updated first,
 * then what the task matches, up to this many in all (`relevantMemory` in lib/engine/index.ts;
 * tests/conventions.test.ts pins the two together).
 */
export const PLAN_MEMORY_CAP = 30;

/** Where standing instructions go, said on Settings and above the namespace on Memory (D34). */
export function standingReach(count: number): string {
  if (count <= PLAN_MEMORY_CAP)
    return 'Every entry here reaches every plan the orchestrator makes.';
  return `The ${PLAN_MEMORY_CAP} most recently updated entries here reach every plan the orchestrator makes; the other ${count - PLAN_MEMORY_CAP} are left out until they are edited.`;
}

/** A long value cut for a list, at a word where one is near; the full value stays in Memory. */
export function clipValue(value: string, max = 180): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const space = flat.lastIndexOf(' ', max - 1);
  return `${flat.slice(0, space > max * 0.6 ? space : max - 1).trimEnd()}…`;
}

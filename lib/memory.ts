import 'server-only';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Db } from './db';
import * as t from './db/schema';
import { slugify } from './agents-util';
import { newId } from './ids';
import { summarizeHealth, type AuthorChip, type NestHealthSummary } from './memory-util';
import type { MemoryEntry, MemoryInput, MemoryNamespace, MemoryPatch } from './schemas';

/** Who wrote a fact: an agent id, or the operator. */
export type MemoryAuthor = MemoryEntry['writtenBy'];

/** A request that is well-formed but refers to things that do not exist or are not allowed. */
export class MemoryValidationError extends Error {
  readonly code = 'validation';
}

/** A write to the same (ns, key) that moves confidence by more than this flags a conflict (§6). */
export const CONFLICT_DELTA = 0.3;

export type NamespaceCount = MemoryNamespace & { count: number };

export async function listMemory(
  db: Db,
  filter: { ns?: string; q?: string } = {},
): Promise<MemoryEntry[]> {
  const q = filter.q?.trim();
  const where = and(
    filter.ns ? eq(t.memory.ns, filter.ns) : undefined,
    q
      ? or(
          ilike(t.memory.key, `%${q}%`),
          ilike(t.memory.value, `%${q}%`),
          sql`${t.memory.search} @@ websearch_to_tsquery('english', ${q})`,
        )
      : undefined,
  );
  const rows = await db
    .select()
    .from(t.memory)
    .where(where)
    .orderBy(desc(t.memory.updatedAt), asc(t.memory.key));
  return rows.map(({ search: _search, ...entry }) => entry);
}

export async function getMemory(db: Db, id: string): Promise<MemoryEntry | undefined> {
  const [row] = await db.select().from(t.memory).where(eq(t.memory.id, id));
  if (!row) return undefined;
  const { search: _search, ...entry } = row;
  return entry;
}

export async function listNamespaces(db: Db): Promise<NamespaceCount[]> {
  const [namespaces, counts] = await Promise.all([
    db.select().from(t.memoryNamespaces).orderBy(asc(t.memoryNamespaces.label)),
    db
      .select({ ns: t.memory.ns, n: sql<number>`count(*)::int` })
      .from(t.memory)
      .groupBy(t.memory.ns),
  ]);
  return namespaces.map((ns) => ({ ...ns, count: counts.find((c) => c.ns === ns.id)?.n ?? 0 }));
}

export async function memoryHealth(db: Db, now = new Date()): Promise<NestHealthSummary> {
  const rows = await db
    .select({
      stale: t.memory.stale,
      conflict: t.memory.conflict,
      verifiedAt: t.memory.verifiedAt,
      expiresAt: t.memory.expiresAt,
    })
    .from(t.memory);
  return summarizeHealth(rows, now);
}

export async function listAuthorChips(db: Db): Promise<AuthorChip[]> {
  return db
    .select({ id: t.agents.id, name: t.agents.name, initials: t.agents.initials })
    .from(t.agents)
    .orderBy(asc(t.agents.name));
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  return new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
}

async function requireNamespace(db: Db, ns: string) {
  const [row] = await db.select().from(t.memoryNamespaces).where(eq(t.memoryNamespaces.id, ns));
  if (!row) throw new MemoryValidationError(`Unknown namespace: ${ns}`);
}

/**
 * "+ Add fact". A write to an existing (ns, key) is a new version of that fact: the old value
 * goes to history, verifiedAt is stamped, and a confidence swing above CONFLICT_DELTA flags a
 * conflict for the operator to settle (spec §6, §7.3).
 */
export async function writeMemory(
  db: Db,
  input: MemoryInput,
  author: MemoryAuthor = 'user',
): Promise<{ entry: MemoryEntry; created: boolean }> {
  await requireNamespace(db, input.ns);
  const now = new Date();
  const [existing] = await db
    .select()
    .from(t.memory)
    .where(and(eq(t.memory.ns, input.ns), eq(t.memory.key, input.key)));

  if (existing) {
    const { search: _search, ...current } = existing;
    const entry: MemoryEntry = {
      ...current,
      value: input.value,
      data: input.data ?? current.data,
      confidence: input.confidence,
      source: input.source,
      writtenBy: author,
      expiresAt: toDate(input.expiresAt),
      verifiedAt: now,
      stale: false,
      conflict: Math.abs(input.confidence - current.confidence) > CONFLICT_DELTA,
      updatedAt: now,
      history: [
        ...current.history,
        {
          value: input.value,
          confidence: input.confidence,
          writtenBy: author,
          at: now.toISOString(),
        },
      ],
    };
    await db.update(t.memory).set(entry).where(eq(t.memory.id, current.id));
    return { entry, created: false };
  }

  const entry: MemoryEntry = {
    id: newId('mem'),
    ns: input.ns,
    key: input.key,
    value: input.value,
    data: input.data ?? null,
    confidence: input.confidence,
    source: input.source,
    writtenBy: author,
    readBy: [],
    expiresAt: toDate(input.expiresAt),
    verifiedAt: now,
    stale: false,
    conflict: false,
    createdAt: now,
    updatedAt: now,
    history: [
      {
        value: input.value,
        confidence: input.confidence,
        writtenBy: author,
        at: now.toISOString(),
      },
    ],
  };
  await db.insert(t.memory).values(entry);
  return { entry, created: true };
}

/** Edit, or mark verified. A changed value or confidence is a new version in history. */
export async function updateMemory(
  db: Db,
  id: string,
  patch: MemoryPatch,
): Promise<MemoryEntry | undefined> {
  const current = await getMemory(db, id);
  if (!current) return undefined;
  const now = new Date();
  const value = patch.value ?? current.value;
  const confidence = patch.confidence ?? current.confidence;
  const changed = value !== current.value || confidence !== current.confidence;
  const entry: MemoryEntry = {
    ...current,
    value,
    confidence,
    source: patch.source ?? current.source,
    data: patch.data !== undefined ? patch.data : current.data,
    expiresAt: patch.expiresAt !== undefined ? toDate(patch.expiresAt) : current.expiresAt,
    writtenBy: changed ? 'user' : current.writtenBy,
    verifiedAt: patch.verified || changed ? now : current.verifiedAt,
    stale: patch.verified || changed ? false : current.stale,
    conflict: patch.verified
      ? false
      : changed
        ? Math.abs(confidence - current.confidence) > CONFLICT_DELTA
        : current.conflict,
    updatedAt: now,
    history: changed
      ? [...current.history, { value, confidence, writtenBy: 'user', at: now.toISOString() }]
      : current.history,
  };
  await db.update(t.memory).set(entry).where(eq(t.memory.id, id));
  return entry;
}

/** "Forget". */
export async function deleteMemory(db: Db, id: string): Promise<boolean> {
  const current = await getMemory(db, id);
  if (!current) return false;
  await db.delete(t.memory).where(eq(t.memory.id, id));
  return true;
}

export async function createNamespace(db: Db, label: string): Promise<MemoryNamespace> {
  const id = slugify(label);
  const [existing] = await db
    .select()
    .from(t.memoryNamespaces)
    .where(eq(t.memoryNamespaces.id, id));
  if (existing)
    throw new MemoryValidationError(`A namespace called “${existing.label}” already exists`);
  const ns: MemoryNamespace = { id, label, createdAt: new Date() };
  await db.insert(t.memoryNamespaces).values(ns);
  return ns;
}

/** Records that an agent read these facts (spec §6 `readBy`); idempotent. */
export async function markRead(db: Db, ids: string[], agentId: string): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: t.memory.id, readBy: t.memory.readBy })
    .from(t.memory)
    .where(inArray(t.memory.id, ids));
  for (const row of rows) {
    if (row.readBy.includes(agentId)) continue;
    await db
      .update(t.memory)
      .set({ readBy: [...row.readBy, agentId] })
      .where(eq(t.memory.id, row.id));
  }
}

/** The nest's write semantics (spec §6, §7.3; decisions D14) against the real embedded database. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import {
  createNamespace,
  deleteMemory,
  listMemory,
  listNamespaces,
  memoryHealth,
  MemoryValidationError,
  updateMemory,
  writeMemory,
} from '@/lib/memory';

describe('memory', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
  }, 30_000);
  afterAll(() => close());

  it('writes a fact, then versions it on the same namespace and key', async () => {
    const first = await writeMemory(db, {
      ns: 'facts',
      key: 'sie.encoding',
      value: 'CP437',
      confidence: 0.9,
      source: 'flight_1',
      expiresAt: null,
    });
    expect(first.created).toBe(true);
    expect(first.entry).toMatchObject({
      writtenBy: 'user',
      readBy: [],
      stale: false,
      conflict: false,
    });
    expect(first.entry.history).toHaveLength(1);

    const second = await writeMemory(db, {
      ns: 'facts',
      key: 'sie.encoding',
      value: 'UTF-8 since the 2026 upgrade',
      confidence: 0.5,
      source: 'flight_2',
      expiresAt: '2027-01-01',
    });
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.value).toBe('UTF-8 since the 2026 upgrade');
    expect(second.entry.conflict).toBe(true); // 0.9 → 0.5 is a swing above 0.3
    expect(second.entry.expiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(second.entry.history.map((h) => h.value)).toEqual([
      'CP437',
      'UTF-8 since the 2026 upgrade',
    ]);

    const [row] = await listMemory(db, { ns: 'facts' });
    expect(row?.conflict).toBe(true);
  });

  it('marks verified, clearing stale and conflict without a new version', async () => {
    const [row] = await listMemory(db, { ns: 'facts' });
    const verified = await updateMemory(db, row!.id, { verified: true });
    expect(verified).toMatchObject({ conflict: false, stale: false });
    expect(verified?.history).toHaveLength(2);

    const edited = await updateMemory(db, row!.id, { source: 'docs' });
    expect(edited?.source).toBe('docs');
    expect(edited?.history).toHaveLength(2); // metadata only: no new version
  });

  it('searches dotted keys and words in values', async () => {
    await writeMemory(db, {
      ns: 'decisions',
      key: 'pr.merge_policy',
      value: 'Reviewer approves, humans merge',
      confidence: 1,
      source: 'you',
      expiresAt: null,
    });
    expect((await listMemory(db, { q: 'merge_pol' })).map((e) => e.key)).toEqual([
      'pr.merge_policy',
    ]);
    expect((await listMemory(db, { q: 'humans' })).map((e) => e.key)).toEqual(['pr.merge_policy']);
    expect(await listMemory(db, { q: 'zebra' })).toEqual([]);
  });

  it('counts namespaces and health, and refuses unknown or duplicate namespaces', async () => {
    const counts = await listNamespaces(db);
    expect(counts.find((n) => n.id === 'facts')?.count).toBe(1);
    expect(await memoryHealth(db)).toMatchObject({
      facts: 2,
      conflicts: 0,
      stale: 0,
      expired: 0,
      verifiedPct: 100,
    });

    await expect(
      writeMemory(db, {
        ns: 'nope',
        key: 'k',
        value: 'v',
        confidence: 1,
        source: 'you',
        expiresAt: null,
      }),
    ).rejects.toBeInstanceOf(MemoryValidationError);

    const ns = await createNamespace(db, 'Runbooks');
    expect(ns.id).toBe('runbooks');
    await expect(createNamespace(db, 'runbooks')).rejects.toBeInstanceOf(MemoryValidationError);
  });

  it('forgets', async () => {
    const [row] = await listMemory(db, { ns: 'decisions' });
    expect(await deleteMemory(db, row!.id)).toBe(true);
    expect(await deleteMemory(db, row!.id)).toBe(false);
  });
});

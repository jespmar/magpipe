/**
 * Runs the real migrations and seeding against an in-memory PGlite — the same engine the
 * desktop app embeds — plus the on-disk lock and persistence behaviour.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbLockedError, nextRunDisplayId, openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { loadDemo } from '@/lib/db/seed';
import { newId } from '@/lib/ids';
import * as s from '@/lib/schemas';

describe('embedded database', () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
  }, 30_000);
  afterAll(() => close());

  it('bootstraps an empty database with settings, namespaces and tool-less starter agents', async () => {
    const [settings] = await db.select().from(t.settings);
    expect(s.settings.parse(settings).workspaceName).toBe('Magpipe');
    expect(await db.$count(t.memoryNamespaces)).toBe(5);
    const agents = await db.select().from(t.agents);
    expect(agents.map((a) => a.slug).sort()).toEqual([
      'coder',
      'operator',
      'researcher',
      'reviewer',
    ]);
    expect(agents.every((a) => a.tools.length === 0)).toBe(true);
    expect(await db.$count(t.tools)).toBe(0);
  });

  it('loads the demo data idempotently, and rows read back as valid schema objects', async () => {
    const first = await loadDemo(db);
    await loadDemo(db);
    expect(await db.$count(t.agents)).toBe(first.agents);
    expect(await db.$count(t.tools)).toBe(first.tools);
    expect(await db.$count(t.memory)).toBe(first.memory);
    expect(await db.$count(t.runEvents)).toBe(first.runEvents);

    const [run] = await db.select().from(t.runs).where(eq(t.runs.displayId, 'flight_8f3972'));
    expect(s.run.parse(run).status).toBe('failed');
    for (const row of await db.select().from(t.memory)) {
      const { search, ...entry } = row;
      expect(typeof search).toBe('string');
      expect(() => s.memoryEntry.parse(entry)).not.toThrow();
    }
    for (const row of await db.select().from(t.runEvents))
      expect(() => s.runEvent.parse(row)).not.toThrow();
  });

  it('continues flight ids after the seeded ones', async () => {
    const a = await nextRunDisplayId(db);
    const b = await nextRunDisplayId(db);
    expect(parseInt(a.slice(7), 36)).toBeGreaterThan(parseInt('8f39e0', 36));
    expect(parseInt(b.slice(7), 36)).toBe(parseInt(a.slice(7), 36) + 1);
  });

  it('full-text searches memory by key and stemmed value', async () => {
    const hits = await db
      .select({ key: t.memory.key })
      .from(t.memory)
      .where(sql`${t.memory.search} @@ websearch_to_tsquery('english', 'arrives')`);
    expect(hits.map((h) => h.key)).toContain('sie.encoding');
  });

  it('enforces the (ns, key) uniqueness and the namespace foreign key', async () => {
    const base = {
      value: 'x',
      data: null,
      confidence: 0.5,
      source: 'test',
      writtenBy: 'user',
      readBy: [],
      expiresAt: null,
      verifiedAt: new Date(),
      history: [],
    };
    await expect(
      db.insert(t.memory).values({ ...base, id: newId('mem'), ns: 'facts', key: 'sie.encoding' }),
    ).rejects.toThrow();
    await expect(
      db.insert(t.memory).values({ ...base, id: newId('mem'), ns: 'no-such-ns', key: 'k' }),
    ).rejects.toThrow();
    await expect(
      db
        .update(t.agents)
        .set({ status: 'flying' as never })
        .where(eq(t.agents.slug, 'coder')),
    ).rejects.toThrow();
  });

  it('cascades run deletion to its events', async () => {
    await db.delete(t.runs).where(eq(t.runs.id, 'run_8f3940'));
    expect(await db.$count(t.runEvents, and(eq(t.runEvents.runId, 'run_8f3940')))).toBe(0);
  });
});

describe('on-disk database', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-db-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('persists across reopen and refuses a second live process', async () => {
    const dir = path.join(root, 'db');
    const first = await openDb(dir);
    await first.db.insert(t.memoryNamespaces).values({ id: 'scratch', label: 'Scratch' });

    // Simulate another live process holding the lock (our parent process is alive).
    await first.close();
    fs.writeFileSync(`${dir}.lock`, String(process.ppid));
    await expect(openDb(dir)).rejects.toBeInstanceOf(DbLockedError);

    // A stale lock from a dead process is taken over.
    fs.writeFileSync(`${dir}.lock`, '999999999');
    const second = await openDb(dir);
    expect(await second.db.$count(t.memoryNamespaces, eq(t.memoryNamespaces.id, 'scratch'))).toBe(
      1,
    );
    await second.close();
    expect(fs.existsSync(`${dir}.lock`)).toBe(false);
  }, 60_000);
});

/**
 * Seeding. `bootstrap` runs on every open and only acts on an empty database; `loadDemo` loads
 * the design's demo data (Settings → Load demo data, or `npm run seed`).
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as s from '../schemas';
import type { Db } from './index';
import * as t from './schema';
import { buildSeed } from './seed-data';

/** First launch: workspace settings, the memory namespaces and the four starter agents. */
export async function bootstrap(db: Db): Promise<boolean> {
  const existing = await db.select({ id: t.settings.id }).from(t.settings).limit(1);
  if (existing.length > 0) return false;

  const seed = buildSeed();
  await db.transaction(async (tx) => {
    // The demo's region label belongs to the demo; a fresh workspace is simply local.
    await tx
      .insert(t.settings)
      .values({ ...seed.settings, region: 'local' })
      .onConflictDoNothing();
    await tx.insert(t.memoryNamespaces).values(seed.namespaces).onConflictDoNothing();
    // Tool grants come with the tools, which a fresh install does not have yet.
    await tx
      .insert(t.agents)
      .values(seed.agents.map((a) => ({ ...a, tools: [] })))
      .onConflictDoNothing();
  });
  return true;
}

/**
 * Upsert the demo data. Rows with the same id — or the same slug / (ns, key) — are replaced;
 * everything else is left alone. `reset` first deletes every agent, tool, memory entry and run.
 */
export async function loadDemo(db: Db, { reset = false } = {}) {
  const seed = buildSeed();
  // Fail before writing anything if the seed drifted from the schemas.
  z.array(s.agent).parse(seed.agents);
  z.array(s.tool).parse(seed.tools);
  z.array(s.memoryNamespace).parse(seed.namespaces);
  z.array(s.memoryEntry).parse(seed.memory);
  z.array(s.run).parse(seed.runs);
  z.array(s.newRunEvent).parse(seed.runEvents);
  s.settings.parse(seed.settings);

  await db.transaction(async (tx) => {
    if (reset) {
      await tx.delete(t.runs); // cascades to run_events
      await tx.delete(t.memory);
      await tx.delete(t.tools);
      await tx.delete(t.agents);
    }

    await tx.delete(t.agents).where(
      or(
        inArray(
          t.agents.id,
          seed.agents.map((a) => a.id),
        ),
        inArray(
          t.agents.slug,
          seed.agents.map((a) => a.slug),
        ),
      ),
    );
    await tx.insert(t.agents).values(seed.agents);

    await tx.delete(t.tools).where(
      or(
        inArray(
          t.tools.id,
          seed.tools.map((x) => x.id),
        ),
        inArray(
          t.tools.slug,
          seed.tools.map((x) => x.slug),
        ),
      ),
    );
    await tx.insert(t.tools).values(seed.tools);

    await tx.insert(t.memoryNamespaces).values(seed.namespaces).onConflictDoNothing();
    await tx.delete(t.memory).where(
      or(
        inArray(
          t.memory.id,
          seed.memory.map((m) => m.id),
        ),
        ...seed.memory.map((m) => and(eq(t.memory.ns, m.ns), eq(t.memory.key, m.key))),
      ),
    );
    await tx.insert(t.memory).values(seed.memory);

    await tx.delete(t.runs).where(
      inArray(
        t.runs.id,
        seed.runs.map((r) => r.id),
      ),
    );
    await tx.insert(t.runs).values(seed.runs);
    await tx.insert(t.runEvents).values(seed.runEvents);

    // Workspace settings are the operator's, not the demo's: insert only if somehow missing.
    await tx.insert(t.settings).values(seed.settings).onConflictDoNothing();

    // New runs continue after the seeded flight ids.
    await tx.execute(
      sql`select setval('run_seq', greatest(${seed.runCounter}::bigint, (select last_value from run_seq)))`,
    );
  });

  return {
    agents: seed.agents.length,
    tools: seed.tools.length,
    memory: seed.memory.length,
    runs: seed.runs.length,
    runEvents: seed.runEvents.length,
  };
}

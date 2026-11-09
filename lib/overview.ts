import 'server-only';
import { count, desc, eq } from 'drizzle-orm';
import { cache } from 'react';
import { getDb } from './db';
import * as t from './db/schema';
import type { RunStatus } from './schemas';

export type Overview = {
  agents: { count: number; names: string[] };
  tools: { count: number; needsAuth: number };
  memory: { count: number; namespaces: number };
  runs: {
    count: number;
    latest: { displayId: string; text: string; status: RunStatus; at: Date } | null;
  };
  /** A workspace with nothing but the starter agents — the demo data is the obvious next step. */
  fresh: boolean;
};

/**
 * The real numbers the holding screens show while their bodies are unbuilt. One request-cached
 * read; `null` when the database cannot be opened (the shell banner explains why, and every
 * screen shows `UnavailableState` instead of claiming emptiness).
 */
export const getOverview = cache(async (): Promise<Overview | null> => {
  try {
    const db = await getDb();
    const [agentRows, [tools], [toolsNeedingAuth], [memory], [namespaces], [runs], [latest]] =
      await Promise.all([
        db.select({ name: t.agents.name }).from(t.agents).orderBy(t.agents.name),
        db.select({ n: count() }).from(t.tools),
        db.select({ n: count() }).from(t.tools).where(eq(t.tools.status, 'needs_auth')),
        db.select({ n: count() }).from(t.memory),
        db.select({ n: count() }).from(t.memoryNamespaces),
        db.select({ n: count() }).from(t.runs),
        db
          .select({
            displayId: t.runs.displayId,
            input: t.runs.input,
            status: t.runs.status,
            finishedAt: t.runs.finishedAt,
            createdAt: t.runs.createdAt,
          })
          .from(t.runs)
          .orderBy(desc(t.runs.createdAt))
          .limit(1),
      ]);
    const toolCount = tools?.n ?? 0;
    const memoryCount = memory?.n ?? 0;
    const runCount = runs?.n ?? 0;
    return {
      agents: { count: agentRows.length, names: agentRows.map((a) => a.name) },
      tools: { count: toolCount, needsAuth: toolsNeedingAuth?.n ?? 0 },
      memory: { count: memoryCount, namespaces: namespaces?.n ?? 0 },
      runs: {
        count: runCount,
        latest: latest
          ? {
              displayId: latest.displayId,
              text: latest.input.text,
              status: latest.status,
              at: latest.finishedAt ?? latest.createdAt,
            }
          : null,
      },
      fresh: toolCount === 0 && memoryCount === 0 && runCount === 0,
    };
  } catch {
    return null;
  }
});

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
    latest: { displayId: string; status: RunStatus; at: Date } | null;
  };
};

/**
 * The real numbers the holding screens show while their bodies are unbuilt. One request-cached
 * read; `null` when the database cannot be opened (the shell banner explains why).
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
            status: t.runs.status,
            finishedAt: t.runs.finishedAt,
            createdAt: t.runs.createdAt,
          })
          .from(t.runs)
          .orderBy(desc(t.runs.createdAt))
          .limit(1),
      ]);
    return {
      agents: { count: agentRows.length, names: agentRows.map((a) => a.name) },
      tools: { count: tools?.n ?? 0, needsAuth: toolsNeedingAuth?.n ?? 0 },
      memory: { count: memory?.n ?? 0, namespaces: namespaces?.n ?? 0 },
      runs: {
        count: runs?.n ?? 0,
        latest: latest
          ? {
              displayId: latest.displayId,
              status: latest.status,
              at: latest.finishedAt ?? latest.createdAt,
            }
          : null,
      },
    };
  } catch {
    return null;
  }
});

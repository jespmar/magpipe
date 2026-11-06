import 'server-only';
import { getDb } from './db';
import * as t from './db/schema';

const TABLES = { agents: t.agents, tools: t.tools, memory: t.memory, runs: t.runs } as const;

/** Row count for a scaffold placeholder; null when the database is not available. */
export async function safeCount(table: keyof typeof TABLES): Promise<number | null> {
  try {
    return await (await getDb()).$count(TABLES[table]);
  } catch {
    return null;
  }
}

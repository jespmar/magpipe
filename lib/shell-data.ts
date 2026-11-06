import 'server-only';
import { eq } from 'drizzle-orm';
import { cache } from 'react';
import { getDb } from './db';
import { agents, settings } from './db/schema';
import { env } from './env';

export type ShellData = {
  activeAgents: number;
  region: string;
  workspaceName: string;
  dbError: string | null;
};

/**
 * What the app shell needs on every page: live-agent count for the nav pill and the footer
 * region. Never throws — a database that cannot be opened degrades to a banner.
 */
export const getShellData = cache(async (): Promise<ShellData> => {
  const fallbackRegion = env.MAGPIPE_REGION ?? env.VERCEL_REGION ?? 'local';
  try {
    const db = await getDb();
    const [activeAgents, [row]] = await Promise.all([
      db.$count(agents, eq(agents.status, 'running')),
      db.select().from(settings).limit(1),
    ]);
    return {
      activeAgents,
      region: env.MAGPIPE_REGION ?? row?.region ?? fallbackRegion,
      workspaceName: row?.workspaceName ?? 'Magpipe',
      dbError: null,
    };
  } catch (err) {
    console.error('[shell] database unavailable:', err);
    return {
      activeAgents: 0,
      region: fallbackRegion,
      workspaceName: 'Magpipe',
      dbError: err instanceof Error ? err.message : String(err),
    };
  }
});

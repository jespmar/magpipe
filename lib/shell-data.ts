import 'server-only';
import { eq } from 'drizzle-orm';
import { cache } from 'react';
import { DbLockedError, getDb } from './db';
import { agents, settings } from './db/schema';
import { env } from './env';

export type DbError = { kind: 'locked' | 'other'; message: string };

export type ShellData = {
  /** null when the database is unavailable — the pill must not claim "0 active". */
  activeAgents: number | null;
  region: string;
  workspaceName: string;
  dbError: DbError | null;
};

/**
 * What the app shell needs on every page: the live-agent count for the nav pill and the footer
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
      activeAgents: null,
      region: fallbackRegion,
      workspaceName: 'Magpipe',
      dbError:
        err instanceof DbLockedError
          ? { kind: 'locked', message: err.message }
          : { kind: 'other', message: err instanceof Error ? err.message : String(err) },
    };
  }
});

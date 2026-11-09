/**
 * The nightly memory job (spec §7.3) as the desktop app can run it (D5, D14): mark facts stale
 * once verification is older than 30 days. Expired facts stay and are labelled on read, so the
 * operator decides what to forget. Runs at start-up and every 24 h while the app is open.
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db';
import * as t from '../db/schema';
import { STALE_AFTER_MS } from '../memory-util';

export async function runHousekeeping(db: Db, now = new Date()): Promise<{ staleMarked: number }> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  const rows = await db
    .update(t.memory)
    .set({ stale: true })
    .where(and(eq(t.memory.stale, false), lt(t.memory.verifiedAt, cutoff)))
    .returning({ id: t.memory.id });
  void sql; // drizzle import kept explicit for the raw-SQL escape hatch if counts ever need it
  return { staleMarked: rows.length };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function scheduleHousekeeping(getDb: () => Promise<Db>): () => void {
  const timer = setInterval(() => {
    getDb()
      .then((db) => runHousekeeping(db))
      .catch((err) => console.error('[housekeeping] failed:', err));
  }, DAY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

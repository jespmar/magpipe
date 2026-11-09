/**
 * Server start-up (D5): open the database, run the memory job if it is due, resume interrupted
 * runs, and keep the job on a timer while the app is open. Called from `instrumentation.ts`.
 */
import { DbLockedError, getDb } from '../db';
import { getEngine } from './index';
import { runHousekeeping, scheduleHousekeeping } from './housekeeping';

const g = globalThis as unknown as { __magpipeBooted?: boolean };

export async function bootEngine(): Promise<void> {
  if (g.__magpipeBooted) return;
  g.__magpipeBooted = true;
  try {
    const db = await getDb();
    const { staleMarked } = await runHousekeeping(db);
    if (staleMarked) console.log(`[housekeeping] marked ${staleMarked} memories stale`);
    scheduleHousekeeping(getDb);
    const resumed = await getEngine().resumeInterrupted(db);
    if (resumed) console.log(`[engine] resumed ${resumed} run(s)`);
  } catch (err) {
    if (err instanceof DbLockedError) {
      console.warn(
        '[engine] database locked by another Magpipe process; runs will not execute here.',
      );
      return;
    }
    console.error('[engine] boot failed:', err);
  }
}

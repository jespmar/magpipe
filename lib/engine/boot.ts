/**
 * Server start-up (D5): open the database, run the memory job if it is due, resume interrupted
 * runs, and keep the job and the Linear watcher (D38) on timers while the app is open. Called from `instrumentation.ts`.
 */
import { DbLockedError, getDb } from '../db';
import { env } from '../env';
import { findClaudeCli } from './claude-code';
import { getEngine } from './index';
import { runHousekeeping, scheduleHousekeeping } from './housekeeping';
import { scheduleWatcher } from '../tracker/issues';

const g = globalThis as unknown as { __magpipeBooted?: boolean };

export async function bootEngine(): Promise<void> {
  if (g.__magpipeBooted) return;
  g.__magpipeBooted = true;
  // Find the claude command now (a login shell and `claude --version` can take a few seconds),
  // so the first flight and the Settings screen read the cached answer.
  if (env.MAGPIPE_MODEL_BACKEND !== 'api' && env.MAGPIPE_MODEL_STUB !== 'scripted') {
    void findClaudeCli().catch(() => null);
  }
  try {
    const db = await getDb();
    const { staleMarked } = await runHousekeeping(db);
    if (staleMarked) console.log(`[housekeeping] marked ${staleMarked} memories stale`);
    scheduleHousekeeping(getDb);
    // The factory's watcher (D38): checks Linear while the app is open, catching up first.
    scheduleWatcher(getDb);
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

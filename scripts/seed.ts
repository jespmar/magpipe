/**
 * Load the design's demo data (agents with tool grants, tools, memory, finished runs) into
 * the local database. Same as Settings → Load demo data, for when the app is not running.
 *
 *   npm run seed          upsert the demo rows (idempotent)
 *   npm run seed:reset    delete every agent, tool, memory entry and run first
 *
 * Uses MAGPIPE_DATA_DIR from .env.local like the app (default ./.magpipe).
 */
import { loadEnvConfig } from '@next/env';
import { dbDir, DbLockedError, openDb } from '../lib/db';
import { loadDemo } from '../lib/db/seed';

loadEnvConfig(process.cwd());

async function main() {
  const reset = process.argv.includes('--reset');
  const dir = dbDir();
  console.log(`→ seeding ${dir}${reset ? ' (reset)' : ''}`);

  let handle;
  try {
    handle = await openDb(dir);
  } catch (err) {
    if (err instanceof DbLockedError) {
      console.error(
        `✗ ${err.message}\n  Stop the app (or dev server) first, or use Settings → Load demo data.`,
      );
      process.exit(1);
    }
    throw err;
  }

  try {
    const n = await loadDemo(handle.db, { reset });
    console.log(
      `✓ ${n.agents} agents · ${n.tools} tools · ${n.memory} memory entries · ` +
        `${n.runs} runs (${n.runEvents} events)`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error('✗ seed failed:', err);
  process.exitCode = 1;
});

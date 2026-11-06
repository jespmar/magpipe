/**
 * Embedded Postgres (PGlite) + Drizzle. See docs/decisions.md D1.
 *
 * The database lives in `<MAGPIPE_DATA_DIR>/db` (desktop: the app's userData folder; dev:
 * `./.magpipe`). PGlite is single-process, so a lock file next to the data directory stops a
 * second process (e.g. `npm run seed` while the app runs) from opening — and corrupting — it.
 *
 * Opening the database applies pending migrations from `drizzle/` and, on an empty database,
 * creates the default workspace (settings, namespaces, starter agents).
 *
 * Deliberately free of Next.js imports so scripts and tests can use it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { toDisplayId } from '../ids';
import * as schema from './schema';
import { bootstrap } from './seed';

export { schema };
export type Db = PgliteDatabase<typeof schema> & { $client: PGlite };

export class DbLockedError extends Error {
  constructor(
    readonly dir: string,
    readonly pid: number,
  ) {
    super(`The database at ${dir} is in use by another Magpipe process (pid ${pid}).`);
    this.name = 'DbLockedError';
  }
}

/** Root for everything Magpipe stores locally (database, uploads, run sandboxes). */
export function dataDir(): string {
  return path.resolve(process.env.MAGPIPE_DATA_DIR || path.join(process.cwd(), '.magpipe'));
}

export function dbDir(): string {
  return path.join(dataDir(), 'db');
}

function migrationsDir(): string {
  return path.resolve(process.env.MAGPIPE_MIGRATIONS_DIR || path.join(process.cwd(), 'drizzle'));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireLock(dir: string): () => void {
  const lockFile = `${dir}.lock`;
  try {
    const holder = Number(fs.readFileSync(lockFile, 'utf8'));
    if (holder && holder !== process.pid && isAlive(holder)) throw new DbLockedError(dir, holder);
  } catch (err) {
    if (err instanceof DbLockedError) throw err;
    // No lock file (or unreadable) — free to take it.
  }
  fs.writeFileSync(lockFile, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(lockFile);
    } catch {
      /* already gone */
    }
  };
  process.once('exit', release);
  return release;
}

/**
 * Open a database. `location` is a directory, or `memory://` for an ephemeral one (tests).
 * Prefer `getDb()` in app code — it shares one connection per process.
 */
export async function openDb(
  location = dbDir(),
  opts: { bootstrap?: boolean } = {},
): Promise<{ db: Db; close: () => Promise<void> }> {
  let release = () => {};
  if (!location.startsWith('memory://')) {
    fs.mkdirSync(path.dirname(location), { recursive: true });
    release = acquireLock(location);
  }
  try {
    const client = await PGlite.create(location);
    const db = drizzle({ client, schema, casing: 'snake_case' });
    await migrate(db, { migrationsFolder: migrationsDir() });
    if (opts.bootstrap !== false) await bootstrap(db);
    return {
      db,
      close: async () => {
        await client.close();
        release();
      },
    };
  } catch (err) {
    release();
    throw err;
  }
}

type Handle = Awaited<ReturnType<typeof openDb>>;
const g = globalThis as unknown as { __magpipeDb?: Promise<Handle> };

/** The process-wide database (survives dev hot reloads). */
export async function getDb(): Promise<Db> {
  g.__magpipeDb ??= openDb().catch((err) => {
    g.__magpipeDb = undefined; // let the next request retry
    throw err;
  });
  return (await g.__magpipeDb).db;
}

/** Flush and close the process-wide database (desktop shutdown). */
export async function closeDb(): Promise<void> {
  const handle = g.__magpipeDb;
  g.__magpipeDb = undefined;
  if (handle) await (await handle).close();
}

/** Reserve the next human-readable run id, e.g. `flight_8f3a22`. */
export async function nextRunDisplayId(db: Db): Promise<string> {
  const { rows } = await db.execute<{ n: string }>(sql`select nextval('run_seq')::text as n`);
  return toDisplayId(Number(rows[0]!.n));
}

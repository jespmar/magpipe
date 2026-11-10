/**
 * Write locks for bound repositories (D28). One step at a time may change a git work tree: a
 * step whose agent can write, run scripts or move branches in a repository holds that work tree
 * from its first tool call to its last, across every run in the engine. Readers never lock.
 *
 * Locks live in memory. Only one process may open the data folder (D1), so the engine is the only
 * writer; on a restart every lock is gone and resumed steps take them again.
 */
import { realpath } from 'node:fs/promises';
import type { Agent, Tool } from '../schemas';
import { inspectRepository, type RepoToolName } from '../repo';

/** Operations that change the work tree: files, branches, or whatever a script writes. */
export const MUTATING_OPS: ReadonlySet<RepoToolName> = new Set([
  'write',
  'run',
  'git_branch',
  'git_commit',
]);

type Waiter = { owner: string; resolve: () => void };
type Lock = { owner: string; waiters: Waiter[] };

// On globalThis, like the engine, so a dev reload never forgets a lock a running step holds.
const g = globalThis as unknown as { __magpipeLocks?: Map<string, Lock> };
const locks = (g.__magpipeLocks ??= new Map<string, Lock>());

function abortError(): Error {
  return Object.assign(new Error('Cancelled'), { name: 'AbortError' });
}

function acquireOne(key: string, owner: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  const lock = locks.get(key);
  if (!lock) {
    locks.set(key, { owner, waiters: [] });
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      owner,
      resolve: () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
    };
    const onAbort = () => {
      const i = lock.waiters.indexOf(waiter);
      if (i !== -1) lock.waiters.splice(i, 1);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    lock.waiters.push(waiter);
  });
}

function releaseOne(key: string): void {
  const lock = locks.get(key);
  if (!lock) return;
  const next = lock.waiters.shift();
  if (!next) {
    locks.delete(key);
    return;
  }
  lock.owner = next.owner;
  next.resolve();
}

/** Who holds a key right now, or null. */
export function lockHolder(key: string): string | null {
  return locks.get(key)?.owner ?? null;
}

/**
 * Takes every key, first come first served, and resolves with the function that releases them.
 * Keys are taken in sorted order, so two steps that need the same pair can never deadlock.
 * `onWait` is called for each key that is held by someone else when it is reached. A cancelled
 * signal stops the wait, releases what was already taken, and rejects.
 */
export async function acquireWriteLocks(
  keys: readonly string[],
  owner: string,
  signal: AbortSignal,
  onWait?: (key: string, holder: string) => void | Promise<void>,
): Promise<() => void> {
  const sorted = Array.from(new Set(keys)).sort();
  const taken: string[] = [];
  const release = () => {
    for (const key of taken.splice(0).reverse()) releaseOne(key);
  };
  try {
    for (const key of sorted) {
      const holder = lockHolder(key);
      if (holder !== null) await onWait?.(key, holder);
      await acquireOne(key, owner, signal);
      taken.push(key);
    }
  } catch (err) {
    release();
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

/** A repository's lock key: the real path of the git work tree it belongs to. */
async function workTreeKey(folder: string): Promise<string | null> {
  const found = await inspectRepository(folder);
  if (!found.ok) return null;
  return realpath(found.root).catch(() => found.root);
}

/** A write target: the work tree to lock and the repository name to say in the trail. */
export type WriteTarget = { key: string; name: string };

/**
 * The work trees an agent's step may change: every bound repository it holds a mutating
 * operation on (`run` only when the repository allows a script). Two repository tools bound to
 * the same work tree (the app and its plans folder) share one key.
 */
export async function writeTargets(
  agent: Pick<Agent, 'tools'>,
  repositories: readonly Pick<Tool, 'id' | 'name' | 'repository'>[],
  cache: Map<string, string | null> = new Map(),
): Promise<WriteTarget[]> {
  const out = new Map<string, WriteTarget>();
  for (const grant of agent.tools) {
    const tool = repositories.find((r) => r.id === grant.toolId);
    const config = tool?.repository;
    if (!tool || !config) continue;
    const mutates = grant.scopes.some(
      (s) => MUTATING_OPS.has(s as RepoToolName) && (s !== 'run' || config.scripts.length > 0),
    );
    if (!mutates) continue;
    if (!cache.has(config.path)) cache.set(config.path, await workTreeKey(config.path));
    const key = cache.get(config.path);
    if (key && !out.has(key)) out.set(key, { key, name: tool.name });
  }
  return [...out.values()];
}

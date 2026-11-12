/**
 * GitHub access for the factory (D42): the settings row, the sealed token, and the forge built
 * from them, like Linear's (D38). The token is checked with GitHub before it is stored, stored
 * sealed (D13), and never read back out to a screen; the repository is checked when it is saved.
 */
import 'server-only';
import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import * as t from '../db/schema';
import { env } from '../env';
import { deleteSecret, readSecret, storeSecret } from '../secrets';
import type { ForgeSettings } from '../schemas';
import { githubForge } from './github';
import { scriptedForge } from './scripted';
import { ForgeError, type Forge } from './types';

export { ForgeError } from './types';
export type { Forge, PullRequest } from './types';

const DEFAULTS: Omit<ForgeSettings, 'updatedAt'> = {
  id: 'github',
  keyRef: null,
  keyHint: null,
  viewer: null,
  repo: null,
  mergeMethod: 'squash',
  autoMerge: false,
  autoMergeLabel: 'auto-merge',
  autoMergeFirstPass: true,
  autoMergeChecks: true,
};

type ForgeFactory = (token: string) => Forge;
const g = globalThis as unknown as { __magpipeForgeFactory?: ForgeFactory };

function defaultFactory(token: string): Forge {
  if (env.MAGPIPE_FORGE_STUB === 'scripted' && process.env.NODE_ENV !== 'production') {
    return scriptedForge(token);
  }
  return githubForge(token);
}

/** Tests swap the forge; `undefined` puts GitHub back. */
export function useForgeFactory(factory: ForgeFactory | undefined): void {
  g.__magpipeForgeFactory = factory;
}

export function forgeFor(token: string): Forge {
  return (g.__magpipeForgeFactory ?? defaultFactory)(token);
}

/** GitHub is set up when it has a token and a repository. */
export function forgeReady(s: Pick<ForgeSettings, 'keyRef' | 'repo'>): boolean {
  return Boolean(s.keyRef && s.repo);
}

export class ForgeNotReadyError extends Error {
  readonly code = 'forge_not_ready';
}

export async function getForgeSettings(db: Db): Promise<ForgeSettings> {
  const [row] = await db.select().from(t.forgeSettings).where(eq(t.forgeSettings.id, 'github'));
  return row ?? { ...DEFAULTS, updatedAt: new Date(0) };
}

/** The forge for the saved token, and the repository it works on. */
export async function getForge(
  db: Db,
  settings?: ForgeSettings,
): Promise<{ forge: Forge; repo: string; settings: ForgeSettings }> {
  const s = settings ?? (await getForgeSettings(db));
  const token = s.keyRef ? await readSecret(db, s.keyRef) : null;
  if (!token || !s.repo) {
    throw new ForgeNotReadyError(
      'GitHub is not set up for this project. Save a token in Settings and give the project its repository.',
    );
  }
  return { forge: forgeFor(token), repo: s.repo, settings: s };
}

async function writeForge(
  db: Db,
  patch: Partial<Omit<ForgeSettings, 'id'>>,
): Promise<ForgeSettings> {
  const now = new Date();
  const [row] = await db
    .insert(t.forgeSettings)
    .values({ ...DEFAULTS, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: t.forgeSettings.id, set: { ...patch, updatedAt: now } })
    .returning();
  return row!;
}

/** What Settings shows: everything but the token. */
export type ForgeView = Omit<ForgeSettings, 'keyRef'> & { hasKey: boolean; ready: boolean };

export function forgeView(s: ForgeSettings): ForgeView {
  const { keyRef, ...rest } = s;
  return { ...rest, hasKey: keyRef !== null, ready: forgeReady(s) };
}

/** Saves a pasted token once GitHub accepts it, replacing any token before it. */
export async function saveForgeKey(db: Db, token: string): Promise<ForgeSettings> {
  const key = token.trim();
  const viewer = await forgeFor(key).viewer();
  const before = await getForgeSettings(db);
  const keyRef = await storeSecret(db, key);
  const settings = await writeForge(db, { keyRef, keyHint: key.slice(-4), viewer: viewer.login });
  if (before.keyRef) await deleteSecret(db, before.keyRef);
  return settings;
}

export async function removeForgeKey(db: Db): Promise<ForgeSettings> {
  const before = await getForgeSettings(db);
  const settings = await writeForge(db, { keyRef: null, keyHint: null, viewer: null });
  if (before.keyRef) await deleteSecret(db, before.keyRef);
  return settings;
}

/** `owner/name` from a remote URL: https, ssh or scp-style GitHub remotes. */
export function repoFromRemote(url: string): string | null {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** A forge failure in the operator's words. */
export function forgeMessage(err: unknown): string {
  if (err instanceof ForgeError || err instanceof ForgeNotReadyError) return err.message;
  return `GitHub could not be reached: ${err instanceof Error ? err.message : String(err)}`;
}

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
import { forgetGh, GhCliError, ghToken } from './gh-cli';
import { githubForge } from './github';
import { scriptedForge } from './scripted';
import { ForgeError, type Forge } from './types';

export { ForgeError } from './types';
export { GhCliError, findGh } from './gh-cli';
export type { Forge, PullRequest } from './types';

const DEFAULTS: Omit<ForgeSettings, 'updatedAt'> = {
  id: 'github',
  keySource: 'token',
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

/** A token is there to use: one pasted and sealed, or the GitHub CLI's sign-in (D47). */
export function hasForgeToken(s: Pick<ForgeSettings, 'keyRef' | 'keySource'>): boolean {
  return s.keyRef !== null || s.keySource === 'gh';
}

/** GitHub is set up when it has a token and a repository. */
export function forgeReady(s: Pick<ForgeSettings, 'keyRef' | 'keySource' | 'repo'>): boolean {
  return hasForgeToken(s) && Boolean(s.repo);
}

/**
 * The token GitHub is called with (D47): a sealed one (a project's own, or the one Settings
 * holds) first, else the GitHub CLI's sign-in when Settings chose it. Null when there is none.
 */
export async function forgeToken(
  db: Db,
  s: Pick<ForgeSettings, 'keyRef' | 'keySource'>,
): Promise<string | null> {
  if (s.keyRef) return readSecret(db, s.keyRef);
  if (s.keySource === 'gh') return ghToken();
  return null;
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
  const token = s.repo ? await forgeToken(db, s) : null;
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

/** What Settings shows: everything but the token. `hasKey` counts the GitHub CLI's sign-in. */
export type ForgeView = Omit<ForgeSettings, 'keyRef'> & { hasKey: boolean; ready: boolean };

export function forgeView(s: ForgeSettings): ForgeView {
  const { keyRef: _keyRef, ...rest } = s;
  return { ...rest, hasKey: hasForgeToken(s), ready: forgeReady(s) };
}

/** Saves a pasted token once GitHub accepts it, replacing any token before it. */
export async function saveForgeKey(db: Db, token: string): Promise<ForgeSettings> {
  const key = token.trim();
  const viewer = await forgeFor(key).viewer();
  const before = await getForgeSettings(db);
  const keyRef = await storeSecret(db, key);
  const settings = await writeForge(db, {
    keySource: 'token',
    keyRef,
    keyHint: key.slice(-4),
    viewer: viewer.login,
  });
  if (before.keyRef) await deleteSecret(db, before.keyRef);
  return settings;
}

/**
 * Uses the GitHub CLI's sign-in from now on (D47), once GitHub accepts the token `gh` gives:
 * a pasted token before it is removed, and nothing is stored.
 */
export async function chooseGhCli(db: Db): Promise<ForgeSettings> {
  const token = await ghToken(true);
  const viewer = await forgeFor(token).viewer();
  const before = await getForgeSettings(db);
  const settings = await writeForge(db, {
    keySource: 'gh',
    keyRef: null,
    keyHint: null,
    viewer: viewer.login,
  });
  if (before.keyRef) await deleteSecret(db, before.keyRef);
  return settings;
}

/** Forgets the token, or stops using the GitHub CLI's sign-in. */
export async function removeForgeKey(db: Db): Promise<ForgeSettings> {
  const before = await getForgeSettings(db);
  forgetGh();
  const settings = await writeForge(db, {
    keySource: 'token',
    keyRef: null,
    keyHint: null,
    viewer: null,
  });
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
  if (err instanceof ForgeError || err instanceof ForgeNotReadyError || err instanceof GhCliError) {
    return err.message;
  }
  return `GitHub could not be reached: ${err instanceof Error ? err.message : String(err)}`;
}

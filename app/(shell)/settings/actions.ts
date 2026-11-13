'use server';

import { headers } from 'next/headers';
import { accessMode } from '@/lib/auth-mode';
import { originFrom } from '@/lib/request-origin';
import { DbLockedError, getDb } from '@/lib/db';
import { loadDemo } from '@/lib/db/seed';
import { loadFactory, summarizeFactory } from '@/lib/factory';
import { loadFlock, summarizeFlock } from '@/lib/flock';
import { parseScripts, RosterValidationError, type RosterLine } from '@/lib/roster';
import { plural } from '@/lib/format';
import {
  forgeKeyInput,
  type ForgeKeyInput,
  flockLoadInput,
  linearKeyInput,
  watcherInput,
  type FlockLoadInput,
  type LinearKeyInput,
  type LinearSettings,
  type TrackerTeam,
  type WatcherInput,
} from '@/lib/schemas';
import {
  anyProjectLinearKey,
  getLinearSettings,
  LinearMappingError,
  LinearNotReadyError,
  linearView,
  cancelLinearSignIn,
  linearSignInOutcome,
  LinearSignInError,
  type SignInOutcome,
  removeLinearKey,
  saveLinearClientId,
  saveLinearKey,
  startLinearSignIn,
  saveWatcher,
  TrackerError,
  trackerMessage,
  type LinearView,
} from '@/lib/tracker';
import { checkLinear, type CheckResult } from '@/lib/tracker/issues';
import {
  ForgeError,
  forgeMessage,
  ForgeNotReadyError,
  forgeView,
  GhCliError,
  removeForgeKey,
  saveForgeKey,
  chooseGhCli,
  type ForgeView,
} from '@/lib/forge';

export type DemoState = { status: 'idle' | 'done' | 'error'; message?: string };

const LOCKED = 'Another Magpipe window is using the data folder. Close it, then try again.';

/**
 * Loads the demo data. Never throws — the form shows the outcome either way.
 *
 * No `revalidatePath` here: every screen is `force-dynamic`, and revalidating the root layout
 * from an action makes the production router fall back to a hard navigation that leaves the
 * form stuck in its pending state. The form refreshes the current route itself when done.
 */
export async function loadDemoAction(_prev: DemoState, _formData: FormData): Promise<DemoState> {
  try {
    const n = await loadDemo(await getDb());
    return {
      status: 'done',
      message: `Loaded ${plural(n.tools, 'tool')}, ${plural(n.memory, 'memory', 'memories')} and ${plural(
        n.runs,
        'finished run',
      )}.`,
    };
  } catch (err) {
    console.error('[settings] load demo data failed:', err);
    return {
      status: 'error',
      message:
        err instanceof DbLockedError
          ? LOCKED
          : `The demo data could not be loaded. ${err instanceof Error ? err.message : ''}`.trim(),
    };
  }
}

export type RosterState =
  | { status: 'idle' }
  | { status: 'done'; path: string; lines: RosterLine[] }
  | { status: 'error'; message: string; field?: 'path' | 'scripts' };
export type FlockState = RosterState;

/**
 * Loads the development flock onto a repository folder (D35). Never throws: a folder or script
 * the flock cannot use comes back with the field to fix. Like the demo data, no revalidation;
 * the form refreshes the route.
 */
export async function loadFlockAction(
  _prev: FlockState,
  input: FlockLoadInput,
): Promise<FlockState> {
  const parsed = flockLoadInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      status: 'error',
      message: issue?.message ?? 'Check the folder and the scripts.',
      field: issue?.path[0] === 'scripts' ? 'scripts' : 'path',
    };
  }
  try {
    const result = await loadFlock(await getDb(), {
      path: parsed.data.path,
      scripts: parseScripts(parsed.data.scripts),
    });
    return { status: 'done', path: result.path, lines: summarizeFlock(result) };
  } catch (err) {
    if (err instanceof RosterValidationError) {
      return { status: 'error', message: err.message, field: err.field };
    }
    console.error('[settings] load the development flock failed:', err);
    return {
      status: 'error',
      message:
        err instanceof DbLockedError
          ? LOCKED
          : `The flock could not be loaded. ${err instanceof Error ? err.message : ''}`.trim(),
    };
  }
}

/**
 * Loads the software factory's nine agents onto a repository folder (D37), the way the flock
 * loads: never throws, and a folder or script it cannot use comes back with the field to fix.
 */
export async function loadFactoryAction(
  _prev: RosterState,
  input: FlockLoadInput,
): Promise<RosterState> {
  const parsed = flockLoadInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      status: 'error',
      message: issue?.message ?? 'Check the folder and the scripts.',
      field: issue?.path[0] === 'scripts' ? 'scripts' : 'path',
    };
  }
  try {
    const result = await loadFactory(await getDb(), {
      path: parsed.data.path,
      scripts: parseScripts(parsed.data.scripts),
    });
    return { status: 'done', path: result.path, lines: summarizeFactory(result) };
  } catch (err) {
    if (err instanceof RosterValidationError) {
      return { status: 'error', message: err.message, field: err.field };
    }
    console.error('[settings] load the software factory failed:', err);
    return {
      status: 'error',
      message:
        err instanceof DbLockedError
          ? LOCKED
          : `The factory could not be loaded. ${err instanceof Error ? err.message : ''}`.trim(),
    };
  }
}

// ─── Linear (D38) ──────────────────────────────────────────────────────────

/** What Settings shows of Linear: Check now also runs on projects' own keys (D46). */
async function viewOf(settings: LinearSettings): Promise<LinearView> {
  const view = linearView(settings);
  return { ...view, ready: view.ready || (await anyProjectLinearKey(await getDb())) };
}

export type LinearResult<T = object> =
  ({ ok: true; view: LinearView } & T) | { ok: false; message: string; field?: string };

async function linearFailure(err: unknown, what: string): Promise<{ ok: false; message: string }> {
  if (err instanceof DbLockedError) return { ok: false, message: LOCKED };
  if (err instanceof TrackerError || err instanceof LinearNotReadyError) {
    return { ok: false, message: err.message };
  }
  if (err instanceof LinearMappingError || err instanceof LinearSignInError) {
    return { ok: false, message: err.message };
  }
  console.error(`[settings] ${what} failed:`, err);
  return { ok: false, message: trackerMessage(err) };
}

/** Saves a pasted key once Linear accepts it; answers with the teams it can see. */
export async function saveLinearKeyAction(
  input: LinearKeyInput,
): Promise<LinearResult<{ teams: TrackerTeam[] }>> {
  const parsed = linearKeyInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]!.message, field: 'key' };
  }
  try {
    const { settings, teams } = await saveLinearKey(await getDb(), parsed.data.key);
    return { ok: true, view: await viewOf(settings), teams };
  } catch (err) {
    const failed = await linearFailure(err, 'save the Linear key');
    return { ...failed, field: 'key' };
  }
}

/**
 * Starts Sign in with Linear (D47): the address the browser opens, with this app's own origin
 * for Linear to come back to, and the state the window asks about with `linearStatusAction`.
 */
export async function startLinearSignInAction(): Promise<
  LinearResult<{ url: string; redirectUri: string; state: string }>
> {
  try {
    const db = await getDb();
    const started = await startLinearSignIn(db, await ownOrigin());
    return { ok: true, view: await viewOf(await getLinearSettings(db)), ...started };
  } catch (err) {
    return linearFailure(err, 'start Sign in with Linear');
  }
}

/** Linear as Settings shows it now, and how the sign-in this window started has gone. */
export async function linearStatusAction(
  state?: string,
): Promise<LinearResult<{ outcome: SignInOutcome | null }>> {
  try {
    return {
      ok: true,
      view: await viewOf(await getLinearSettings(await getDb())),
      outcome: state ? linearSignInOutcome(state) : null,
    };
  } catch (err) {
    return linearFailure(err, 'read the Linear sign-in');
  }
}

/** Ends a sign-in this window started, so a tab left open in the browser cannot finish it. */
export async function cancelLinearSignInAction(state: string): Promise<{ ok: true }> {
  cancelLinearSignIn(state);
  return { ok: true };
}

/** Saves the OAuth app's client ID Sign in with Linear uses; empty forgets it. */
export async function saveLinearClientIdAction(clientId: string): Promise<LinearResult> {
  const clean = clientId.trim();
  if (clean && !/^[\w-]{8,128}$/.test(clean)) {
    return {
      ok: false,
      message: 'That does not look like a client ID: copy it from Linear.',
      field: 'clientId',
    };
  }
  try {
    return { ok: true, view: await viewOf(await saveLinearClientId(await getDb(), clean || null)) };
  } catch (err) {
    return linearFailure(err, 'save the client ID');
  }
}

/** This app's own origin, as the browser reached it: Linear sends the browser back here. */
async function ownOrigin(): Promise<string> {
  return originFrom(await headers(), { desktop: accessMode() === 'desktop' });
}

export async function removeLinearKeyAction(): Promise<LinearResult> {
  try {
    return { ok: true, view: await viewOf(await removeLinearKey(await getDb())) };
  } catch (err) {
    return linearFailure(err, 'remove the Linear key');
  }
}

export async function saveWatcherAction(input: WatcherInput): Promise<LinearResult> {
  const parsed = watcherInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]!.message, field: 'pollSeconds' };
  }
  try {
    return { ok: true, view: await viewOf(await saveWatcher(await getDb(), parsed.data)) };
  } catch (err) {
    return linearFailure(err, 'save the watcher');
  }
}

/** Check now: one check, even while the watcher is paused. */
export async function checkLinearAction(): Promise<LinearResult<{ check: CheckResult }>> {
  try {
    const db = await getDb();
    // Loaded here, not at the top: the engine is large, and every other Settings action would
    // otherwise wait for it to compile on a cold development server.
    const [{ getEngine }, { factoryTick }] = await Promise.all([
      import('@/lib/engine'),
      import('@/lib/factory'),
    ]);
    const check = await checkLinear(db, {
      force: true,
      afterCheck: (d) => factoryTick(d, (id) => getEngine().enqueue(id)),
    });
    return { ok: true, view: await viewOf(await getLinearSettings(db)), check };
  } catch (err) {
    return linearFailure(err, 'check Linear');
  }
}

// ─── GitHub (D42) ──────────────────────────────────────────────────────────

export type ForgeResult<T = object> =
  ({ ok: true; view: ForgeView } & T) | { ok: false; message: string; field?: string };

async function forgeFailure(err: unknown, what: string): Promise<{ ok: false; message: string }> {
  if (err instanceof DbLockedError) return { ok: false, message: LOCKED };
  if (err instanceof ForgeError || err instanceof ForgeNotReadyError || err instanceof GhCliError) {
    return { ok: false, message: err.message };
  }
  console.error(`[settings] ${what} failed:`, err);
  return { ok: false, message: forgeMessage(err) };
}

/** Saves a pasted GitHub token once GitHub accepts it. */
export async function saveForgeKeyAction(input: ForgeKeyInput): Promise<ForgeResult> {
  const parsed = forgeKeyInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]!.message, field: 'key' };
  try {
    return { ok: true, view: forgeView(await saveForgeKey(await getDb(), parsed.data.key)) };
  } catch (err) {
    return { ...(await forgeFailure(err, 'save the GitHub token')), field: 'key' };
  }
}

/** Uses the GitHub CLI's sign-in from now on, once GitHub accepts its token (D47). */
export async function chooseGhCliAction(): Promise<ForgeResult> {
  try {
    return { ok: true, view: forgeView(await chooseGhCli(await getDb())) };
  } catch (err) {
    return forgeFailure(err, 'use the GitHub CLI');
  }
}

export async function removeForgeKeyAction(): Promise<ForgeResult> {
  try {
    return { ok: true, view: forgeView(await removeForgeKey(await getDb())) };
  } catch (err) {
    return forgeFailure(err, 'remove the GitHub token');
  }
}

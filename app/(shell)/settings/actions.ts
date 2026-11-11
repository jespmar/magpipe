'use server';

import { DbLockedError, getDb } from '@/lib/db';
import { loadDemo } from '@/lib/db/seed';
import { loadFactory, summarizeFactory } from '@/lib/factory';
import { loadFlock, summarizeFlock } from '@/lib/flock';
import { parseScripts, RosterValidationError, type RosterLine } from '@/lib/roster';
import { plural } from '@/lib/format';
import {
  flockLoadInput,
  linearKeyInput,
  linearMappingInput,
  watcherInput,
  type FlockLoadInput,
  type LinearKeyInput,
  type LinearMappingInput,
  type PipelineState,
  type TrackerTeam,
  type WatcherInput,
} from '@/lib/schemas';
import {
  getLinearSettings,
  LinearMappingError,
  LinearNotReadyError,
  linearOptions,
  linearView,
  removeLinearKey,
  saveLinearKey,
  saveLinearMapping,
  saveWatcher,
  TrackerError,
  trackerMessage,
  type LinearView,
  type TrackerState,
} from '@/lib/tracker';
import { checkLinear, type CheckResult } from '@/lib/tracker/issues';

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

/** What every Linear action answers: the settings as Settings shows them, or what went wrong. */
export type LinearResult<T = object> =
  ({ ok: true; view: LinearView } & T) | { ok: false; message: string; field?: string };

async function linearFailure(err: unknown, what: string): Promise<{ ok: false; message: string }> {
  if (err instanceof DbLockedError) return { ok: false, message: LOCKED };
  if (err instanceof TrackerError || err instanceof LinearNotReadyError) {
    return { ok: false, message: err.message };
  }
  if (err instanceof LinearMappingError) return { ok: false, message: err.message };
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
    return { ok: true, view: linearView(settings), teams };
  } catch (err) {
    const failed = await linearFailure(err, 'save the Linear key');
    return { ...failed, field: 'key' };
  }
}

export async function removeLinearKeyAction(): Promise<LinearResult> {
  try {
    return { ok: true, view: linearView(await removeLinearKey(await getDb())) };
  } catch (err) {
    return linearFailure(err, 'remove the Linear key');
  }
}

/** The teams the key can see and, for one team, its statuses with a first guess at the mapping. */
export async function linearOptionsAction(teamId?: string): Promise<
  LinearResult<{
    teams: TrackerTeam[];
    states: TrackerState[];
    suggested: Record<PipelineState, string> | null;
  }>
> {
  try {
    const db = await getDb();
    const options = await linearOptions(db, teamId);
    return { ok: true, view: linearView(await getLinearSettings(db)), ...options };
  } catch (err) {
    return linearFailure(err, 'read the Linear teams');
  }
}

/** Saves the team, label and statuses after reading them back from Linear. */
export async function saveLinearMappingAction(
  input: LinearMappingInput,
): Promise<LinearResult<{ labelCreated: boolean; statuses: number }>> {
  const parsed = linearMappingInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]!.message };
  try {
    const { settings, labelCreated, statuses } = await saveLinearMapping(
      await getDb(),
      parsed.data,
    );
    return { ok: true, view: linearView(settings), labelCreated, statuses };
  } catch (err) {
    return linearFailure(err, 'save the Linear mapping');
  }
}

export async function saveWatcherAction(input: WatcherInput): Promise<LinearResult> {
  const parsed = watcherInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]!.message, field: 'pollSeconds' };
  }
  try {
    return { ok: true, view: linearView(await saveWatcher(await getDb(), parsed.data)) };
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
    return { ok: true, view: linearView(await getLinearSettings(db)), check };
  } catch (err) {
    return linearFailure(err, 'check Linear');
  }
}

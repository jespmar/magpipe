'use server';

import { DbLockedError, getDb } from '@/lib/db';
import { loadDemo } from '@/lib/db/seed';
import { loadFactory, summarizeFactory } from '@/lib/factory';
import { loadFlock, summarizeFlock } from '@/lib/flock';
import { parseScripts, RosterValidationError, type RosterLine } from '@/lib/roster';
import { plural } from '@/lib/format';
import { flockLoadInput, type FlockLoadInput } from '@/lib/schemas';

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

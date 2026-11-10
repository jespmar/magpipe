'use server';

import { DbLockedError, getDb } from '@/lib/db';
import { loadDemo } from '@/lib/db/seed';
import { FlockValidationError, loadFlock, parseScripts, summarizeFlock } from '@/lib/flock';
import type { FlockLine } from '@/lib/flock';
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

export type FlockState =
  | { status: 'idle' }
  | { status: 'done'; path: string; lines: FlockLine[] }
  | { status: 'error'; message: string; field?: 'path' | 'scripts' };

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
    if (err instanceof FlockValidationError) {
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

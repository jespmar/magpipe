'use server';

import { DbLockedError, getDb } from '@/lib/db';
import { loadDemo } from '@/lib/db/seed';
import { plural } from '@/lib/format';

export type DemoState = { status: 'idle' | 'done' | 'error'; message?: string };

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
        'finished flight',
      )}.`,
    };
  } catch (err) {
    console.error('[settings] load demo data failed:', err);
    return {
      status: 'error',
      message:
        err instanceof DbLockedError
          ? 'Another Magpipe window is using the data folder. Close it, then try again.'
          : `The demo data could not be loaded. ${err instanceof Error ? err.message : ''}`.trim(),
    };
  }
}

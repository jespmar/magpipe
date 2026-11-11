'use server';

import { DbLockedError, getDb } from '@/lib/db';
import { ForgeError, forgeMessage } from '@/lib/forge';
import {
  deleteProject,
  projectLinearOptions,
  ProjectError,
  projectView,
  saveProject,
  setProjectKey,
  type ProjectView,
} from '@/lib/projects';
import {
  projectInput,
  type PipelineState,
  type ProjectInput,
  type TrackerRef,
  type TrackerTeam,
} from '@/lib/schemas';
import {
  LinearNotReadyError,
  TrackerError,
  trackerMessage,
  type TrackerState,
} from '@/lib/tracker';

export type ProjectResult<T = object> =
  ({ ok: true } & T) | { ok: false; message: string; field?: string };

const LOCKED = 'Another Magpipe window is using the data folder. Close it, then try again.';

function failure(err: unknown, what: string): { ok: false; message: string; field?: string } {
  if (err instanceof DbLockedError) return { ok: false, message: LOCKED };
  if (err instanceof ProjectError) return { ok: false, message: err.message, field: err.field };
  if (err instanceof TrackerError || err instanceof LinearNotReadyError) {
    return { ok: false, message: trackerMessage(err), field: 'linear' };
  }
  if (err instanceof ForgeError) return { ok: false, message: forgeMessage(err), field: 'github' };
  console.error(`[projects] ${what} failed:`, err);
  return { ok: false, message: `Could not ${what}. Try again.` };
}

/** Creates (`id` null) or updates a project after reading back what it names (D45). */
export async function saveProjectAction(
  id: string | null,
  input: ProjectInput,
): Promise<ProjectResult<{ project: ProjectView; notes: string[] }>> {
  const parsed = projectInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { ok: false, message: issue.message, field: String(issue.path[0] ?? '') };
  }
  try {
    const db = await getDb();
    const { project, notes } = await saveProject(db, id, parsed.data);
    return { ok: true, project: await projectView(db, project), notes };
  } catch (err) {
    return failure(err, 'save the project');
  }
}

/** The teams, and for one team its statuses, first guess and Linear projects. */
export async function projectLinearOptionsAction(
  id: string | null,
  teamId?: string,
): Promise<
  ProjectResult<{
    teams: TrackerTeam[];
    states: TrackerState[];
    projects: TrackerRef[];
    suggested: Record<PipelineState, string> | null;
  }>
> {
  try {
    return { ok: true, ...(await projectLinearOptions(await getDb(), id, teamId || undefined)) };
  } catch (err) {
    return failure(err, 'read the Linear teams');
  }
}

/** A project's own Linear key or GitHub token, checked first; null goes back to the workspace's. */
export async function setProjectKeyAction(
  id: string,
  kind: 'linear' | 'github',
  key: string | null,
): Promise<ProjectResult<{ project: ProjectView; who: string | null }>> {
  if (key !== null && !key.trim()) {
    return {
      ok: false,
      message:
        kind === 'linear' ? 'Paste the API key from Linear.' : 'Paste the token from GitHub.',
      field: kind,
    };
  }
  try {
    const db = await getDb();
    const { project, who } = await setProjectKey(db, id, kind, key);
    return { ok: true, project: await projectView(db, project), who };
  } catch (err) {
    return {
      ...failure(err, `save the ${kind === 'linear' ? 'Linear key' : 'GitHub token'}`),
      field: kind,
    };
  }
}

export async function deleteProjectAction(id: string): Promise<ProjectResult> {
  try {
    const gone = await deleteProject(await getDb(), id);
    return gone ? { ok: true } : { ok: false, message: 'That project no longer exists.' };
  } catch (err) {
    return failure(err, 'delete the project');
  }
}

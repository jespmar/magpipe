'use server';

import { DbLockedError, getDb } from '@/lib/db';
import { factoryInstalled, installFactory } from '@/lib/factory';
import { ForgeError, forgeMessage, GhCliError, type ForgeOwner, type ForgeRepo } from '@/lib/forge';
import {
  wizardCheckFolder,
  wizardEnsureClone,
  wizardEnsureLinearProject,
  wizardEnsureRepository,
  wizardGitHub,
  wizardRepoScripts,
  type FolderCheck,
} from '@/lib/project-wizard';
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
  if (err instanceof ForgeError || err instanceof GhCliError) {
    return { ok: false, message: forgeMessage(err), field: 'github' };
  }
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
    // The factory's agents come with the first project (D50). The project stands either way:
    // a failed install says so, and Settings can install them later.
    if (!id && !(await factoryInstalled(db))) {
      try {
        await installFactory(db);
        notes.push('Installed the factory’s nine agents.');
      } catch (err) {
        console.error('[projects] install the factory failed:', err);
        notes.push(
          `The factory’s agents could not be installed (${err instanceof Error ? err.message : String(err)}). Install them in Settings.`,
        );
      }
    }
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

// ─── the New project wizard (D49) ──────────────────────────────────────────

/** The GitHub account, the owners a repository can be made under, and its repositories. */
export async function wizardGitHubAction(): Promise<
  ProjectResult<{ login: string; owners: ForgeOwner[]; repos: ForgeRepo[] }>
> {
  try {
    return { ok: true, ...(await wizardGitHub(await getDb())) };
  } catch (err) {
    return failure(err, 'read the repositories from GitHub');
  }
}

/** The scripts in a repository's package.json on GitHub; null when it has none. */
export async function wizardRepoScriptsAction(
  repo: string,
): Promise<ProjectResult<{ scripts: string[] | null }>> {
  try {
    return { ok: true, scripts: await wizardRepoScripts(await getDb(), repo) };
  } catch (err) {
    return failure(err, 'read the repository’s package.json');
  }
}

/** Checks where the project's folder will be, before anything is made. */
export async function wizardCheckFolderAction(
  input:
    | { mode: 'clone'; repo: string; parent: string; folder: string }
    | { mode: 'existing'; repo: string; path: string },
): Promise<ProjectResult<{ folder: FolderCheck }>> {
  try {
    return { ok: true, folder: await wizardCheckFolder(input) };
  } catch (err) {
    return failure(err, 'check the folder');
  }
}

/** Makes the GitHub repository, or uses the one already there by that name. */
export async function wizardEnsureRepositoryAction(input: {
  owner: string;
  name: string;
  private: boolean;
  description: string;
}): Promise<ProjectResult<{ repo: string; created: boolean }>> {
  try {
    return { ok: true, ...(await wizardEnsureRepository(await getDb(), input)) };
  } catch (err) {
    return failure(err, 'make the repository on GitHub');
  }
}

/** Clones the repository into the folder picked, or uses the folder when it already holds it. */
export async function wizardEnsureCloneAction(input: {
  repo: string;
  parent: string;
  folder: string;
}): Promise<ProjectResult<{ path: string; reused: boolean }>> {
  try {
    return { ok: true, ...(await wizardEnsureClone(await getDb(), input)) };
  } catch (err) {
    return failure(err, 'clone the repository');
  }
}

/** Makes the Linear project, or uses the free one already there by that name. */
export async function wizardEnsureLinearProjectAction(input: {
  teamId: string;
  name: string;
}): Promise<ProjectResult<{ project: TrackerRef; created: boolean }>> {
  try {
    return { ok: true, ...(await wizardEnsureLinearProject(await getDb(), input)) };
  } catch (err) {
    return failure(err, 'make the Linear project');
  }
}

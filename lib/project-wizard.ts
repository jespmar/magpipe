/**
 * The New project wizard's steps (D49): what it lists from GitHub, where a clone would go, and
 * the three things it may make before the project is saved — a GitHub repository, a clone of it
 * on this computer, a Linear project. Each is safe to run again: a repository, clone or Linear
 * project that is already there by the name asked for is used as it is, so a wizard that stopped
 * half-way picks up where it stopped. Saving the project is `saveProject`'s, which reads back
 * everything as it does for any project.
 */
import 'server-only';
import { homeDir } from './runtime-path';
import path from 'node:path';
import { checkCloneTarget, cloneRepository, CloneError } from './clone';
import type { Db } from './db';
import {
  accountForge,
  ForgeError,
  repoFromRemote,
  type Forge,
  type ForgeOwner,
  type ForgeRepo,
} from './forge';
import { editorTracker, listProjects, ProjectError } from './projects';
import { inspectRepository } from './repo';
import type { TrackerRef } from './schemas';
import { originUrl } from './worktrees';

/** A repository name GitHub takes. */
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const OWNER = /^[A-Za-z0-9-]{1,39}$/;

async function forgeOrRefuse(db: Db): Promise<{ forge: Forge; token: string }> {
  const found = await accountForge(db);
  if (!found) {
    throw new ProjectError(
      'Connect GitHub in Settings first: use the GitHub CLI’s sign-in or paste a token.',
      'github',
    );
  }
  return found;
}

/** The account, the owners a repository can be made under, and every repository it can push to. */
export async function wizardGitHub(
  db: Db,
): Promise<{ login: string; owners: ForgeOwner[]; repos: ForgeRepo[] }> {
  const { forge } = await forgeOrRefuse(db);
  const [owners, repos] = await Promise.all([forge.owners(), forge.repositories()]);
  return { login: owners[0]?.login ?? '', owners, repos };
}

/** The scripts in a repository's package.json on GitHub, before it is cloned; null for none. */
export async function wizardRepoScripts(db: Db, repo: string): Promise<string[] | null> {
  checkFullName(repo);
  const { forge } = await forgeOrRefuse(db);
  return forge.packageScripts(repo);
}

/** Where the wizard first offers to clone: beside the latest project, else the home folder. */
export async function wizardParentFolder(db: Db): Promise<string> {
  const projects = await listProjects(db);
  const latest = projects.at(-1);
  return latest ? path.dirname(latest.repoPath) : homeDir();
}

function checkFullName(repo: string): void {
  const [owner, name, ...rest] = repo.split('/');
  if (rest.length || !owner || !name || !OWNER.test(owner) || !REPO_NAME.test(name)) {
    throw new ProjectError('Give the GitHub repository as owner/name.', 'github');
  }
}

export type FolderCheck = {
  path: string;
  /** For a clone: a new folder, an empty one, or one that already holds the repository. */
  state: 'new' | 'empty' | 'same' | 'existing';
  /** The scripts in the folder's package.json, when the folder is there already. */
  scripts: string[] | null;
};

/**
 * Checks the folder step before anything is made: a clone's new folder inside the parent, or a
 * folder that already holds the repository (its origin, when it is on GitHub, must be it).
 */
export async function wizardCheckFolder(
  input:
    | { mode: 'clone'; repo: string; parent: string; folder: string }
    | { mode: 'existing'; repo: string; path: string },
): Promise<FolderCheck> {
  checkFullName(input.repo);
  if (input.mode === 'clone') {
    try {
      const target = await checkCloneTarget(input);
      return { path: target.path, state: target.state, scripts: null };
    } catch (err) {
      if (err instanceof CloneError) throw new ProjectError(err.message, 'folder');
      throw err;
    }
  }
  const found = await inspectRepository(input.path.trim());
  if (!found.ok) {
    throw new ProjectError(found.error.endsWith('.') ? found.error : `${found.error}.`, 'folder');
  }
  const origin = await originUrl(found.path);
  const fromOrigin = origin ? repoFromRemote(origin) : null;
  if (fromOrigin && fromOrigin.toLowerCase() !== input.repo.toLowerCase()) {
    throw new ProjectError(
      `The folder’s origin is ${fromOrigin}, not ${input.repo}. Pick the folder that holds ${input.repo}, or clone it.`,
      'folder',
    );
  }
  return { path: found.path, state: 'existing', scripts: found.scripts };
}

/**
 * Makes the GitHub repository, or uses the one already there by that name when the token can
 * push to it and no other project lands in it: one made by an earlier try of this wizard.
 */
export async function wizardEnsureRepository(
  db: Db,
  input: { owner: string; name: string; private: boolean; description: string },
): Promise<{ repo: string; created: boolean }> {
  const repo = `${input.owner}/${input.name}`;
  if (!OWNER.test(input.owner)) throw new ProjectError('Pick who owns the repository.', 'github');
  if (!REPO_NAME.test(input.name) || input.name === '.' || input.name === '..') {
    throw new ProjectError(
      'Name the repository with letters, digits, dots, dashes or underscores.',
      'github',
    );
  }
  const taken = (await listProjects(db)).find(
    (p) => p.github.repo?.toLowerCase() === repo.toLowerCase(),
  );
  if (taken) {
    throw new ProjectError(
      `${taken.name} already lands in ${taken.github.repo}. Name the new repository differently.`,
      'github',
    );
  }
  const { forge } = await forgeOrRefuse(db);
  try {
    const made = await forge.createRepository({
      owner: input.owner,
      name: input.name,
      private: input.private,
      description: input.description.trim() || undefined,
    });
    return { repo: made.fullName, created: true };
  } catch (err) {
    // GitHub refuses a name that is taken: the repository an earlier try made is used as it is.
    if (!(err instanceof ForgeError && err.code === 'invalid')) throw err;
    const there = await forge.repository(repo).catch(() => null);
    if (!there) throw err;
    if (!there.canPush) {
      throw new ProjectError(
        `${repo} is already on GitHub, and the token cannot push to it. Name the new repository differently.`,
        'github',
      );
    }
    return { repo, created: false };
  }
}

/** Clones the repository into `parent/folder`, or uses that folder when it already holds it. */
export async function wizardEnsureClone(
  db: Db,
  input: { repo: string; parent: string; folder: string },
): Promise<{ path: string; reused: boolean }> {
  checkFullName(input.repo);
  const { forge, token } = await forgeOrRefuse(db);
  const source = await forge.cloneSource(input.repo);
  try {
    return await cloneRepository({ ...input, source, token });
  } catch (err) {
    if (err instanceof CloneError) throw new ProjectError(err.message, 'folder');
    throw err;
  }
}

/**
 * Makes the Linear project in the team, or uses the one by that name no other project files
 * into: one made by an earlier try of this wizard.
 */
export async function wizardEnsureLinearProject(
  db: Db,
  input: { teamId: string; name: string },
): Promise<{ project: TrackerRef; created: boolean }> {
  const name = input.name.trim();
  if (!name) throw new ProjectError('Name the new Linear project.', 'linear');
  if (name.length > 80) {
    throw new ProjectError('Keep the Linear project’s name under 80 characters.', 'linear');
  }
  const tracker = await editorTracker(db, null);
  const same = (await tracker.projects(input.teamId)).filter(
    (p) => p.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (same.length) {
    const taken = new Map(
      (await listProjects(db))
        .filter((p) => p.linear.project)
        .map((p) => [p.linear.project!.id, p.name]),
    );
    const free = same.find((p) => !taken.has(p.id));
    if (free) return { project: free, created: false };
    throw new ProjectError(
      `${taken.get(same[0]!.id)} already files into the Linear project ${same[0]!.name}. Name the new one differently.`,
      'linear',
    );
  }
  return { project: await tracker.createProject(input.teamId, name), created: true };
}

/**
 * Factory projects (D45): each one a repository and where its work is tracked and lands. A
 * project's Linear group (team, label, statuses) and GitHub group (repository, merge method,
 * unattended rule) override the workspace's when the project sets them, and inherit them when it
 * does not; its Linear key and GitHub token do the same. So the factory as it was set up before
 * projects is simply the Default project, inheriting everything.
 */
import 'server-only';
import { asc, eq, isNull } from 'drizzle-orm';
import type { Db } from './db';
import * as t from './db/schema';
import { newId } from './ids';
import { checkRepository, parseScripts, RosterValidationError } from './roster';
import { deleteSecret, storeSecret } from './secrets';
import {
  pipelineStates,
  type FactoryProject,
  type ForgeSettings,
  type LinearSettings,
  type ProjectInput,
} from './schemas';
import {
  getLinearSettings,
  linearReady,
  LinearMappingError,
  LinearNotReadyError,
  readBackMapping,
  suggestStates,
  trackerFor,
  type Tracker,
  type TrackerState,
} from './tracker';
import type { PipelineState, TrackerRef, TrackerTeam } from './schemas';
import { forgeFor, forgeReady, getForgeSettings } from './forge';
import { readSecret } from './secrets';

export class ProjectError extends Error {
  readonly code = 'validation';
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export async function listProjects(db: Db): Promise<FactoryProject[]> {
  return db.select().from(t.factoryProjects).orderBy(asc(t.factoryProjects.createdAt));
}

export async function getProject(db: Db, id: string): Promise<FactoryProject | undefined> {
  const [row] = await db.select().from(t.factoryProjects).where(eq(t.factoryProjects.id, id));
  return row;
}

/** The project a run or issue names, else the only project there is, else none. */
export async function resolveProject(
  db: Db,
  id?: string | null,
): Promise<FactoryProject | undefined> {
  if (id) return getProject(db, id);
  const all = await listProjects(db);
  return all.length === 1 ? all[0] : undefined;
}

/** The Linear settings a project works with: its own team and key where set, else the workspace's. */
export async function projectLinear(
  db: Db,
  project: FactoryProject | undefined,
): Promise<LinearSettings> {
  const ws = await getLinearSettings(db);
  if (!project) return ws;
  const own = project.linear.team !== null;
  return {
    ...ws,
    keyRef: project.linearKeyRef ?? ws.keyRef,
    team: own ? project.linear.team : ws.team,
    label: own ? project.linear.label : ws.label,
    states: own ? project.linear.states : ws.states,
  };
}

/** The Linear project a project files into and reads from, if it names one. */
export function linearProjectOf(project: FactoryProject | undefined): string | undefined {
  return project?.linear.project?.id ?? undefined;
}

/** The GitHub settings a project works with: its own repository and token where set. */
export async function projectForge(
  db: Db,
  project: FactoryProject | undefined,
): Promise<ForgeSettings> {
  const ws = await getForgeSettings(db);
  if (!project) return ws;
  const own = project.github.repo !== null;
  return {
    ...ws,
    keyRef: project.githubKeyRef ?? ws.keyRef,
    ...(own
      ? {
          repo: project.github.repo,
          mergeMethod: project.github.mergeMethod,
          autoMerge: project.github.autoMerge,
          autoMergeLabel: project.github.autoMergeLabel,
          autoMergeFirstPass: project.github.autoMergeFirstPass,
          autoMergeChecks: project.github.autoMergeChecks,
        }
      : {}),
  };
}

/** What a screen shows of a project: no key refs, and what it ends up using. */
export type ProjectView = Omit<FactoryProject, 'linearKeyRef' | 'githubKeyRef'> & {
  hasLinearKey: boolean;
  hasGithubKey: boolean;
  /** The team, label and statuses in effect, and whether they are the project's own. */
  effectiveLinear: Pick<LinearSettings, 'team' | 'label' | 'states'> & { own: boolean };
  effectiveGithub: Pick<ForgeSettings, 'repo' | 'mergeMethod' | 'autoMerge' | 'autoMergeLabel'> & {
    own: boolean;
  };
  linearReady: boolean;
  githubReady: boolean;
};

export async function projectView(db: Db, project: FactoryProject): Promise<ProjectView> {
  const [linear, forge] = await Promise.all([
    projectLinear(db, project),
    projectForge(db, project),
  ]);
  const { linearKeyRef, githubKeyRef, ...rest } = project;
  return {
    ...rest,
    hasLinearKey: linearKeyRef !== null,
    hasGithubKey: githubKeyRef !== null,
    effectiveLinear: {
      team: linear.team,
      label: linear.label,
      states: linear.states,
      own: project.linear.team !== null,
    },
    effectiveGithub: {
      repo: forge.repo,
      mergeMethod: forge.mergeMethod,
      autoMerge: forge.autoMerge,
      autoMergeLabel: forge.autoMergeLabel,
      own: project.github.repo !== null,
    },
    linearReady: linearReady(linear),
    githubReady: forgeReady(forge),
  };
}

const EMPTY_GITHUB: FactoryProject['github'] = {
  repo: null,
  mergeMethod: 'squash',
  autoMerge: false,
  autoMergeLabel: 'auto-merge',
  autoMergeFirstPass: true,
  autoMergeChecks: true,
};

/**
 * The factory as it was before projects (D45): when the factory is loaded and no project exists,
 * a Default project is made on its repository, inheriting the workspace's Linear and GitHub
 * settings, and every issue without a project joins it. Safe to call often.
 */
export async function ensureDefaultProject(db: Db): Promise<FactoryProject | undefined> {
  const existing = await listProjects(db);
  if (existing.length > 0) return undefined;
  const { factoryRepository } = await import('./factory');
  const repo = await factoryRepository(db).catch(() => null);
  if (!repo) return undefined;
  const [tool] = await db
    .select({ repository: t.tools.repository })
    .from(t.tools)
    .where(eq(t.tools.id, repo.id));
  const now = new Date();
  const project: FactoryProject = {
    id: newId('proj'),
    name: 'Default',
    repoPath: repo.path,
    scripts: tool?.repository?.scripts ?? [],
    context: '',
    linear: { team: null, project: null, label: null, states: {} },
    github: { ...EMPTY_GITHUB },
    linearKeyRef: null,
    linearKeyHint: null,
    githubKeyRef: null,
    githubKeyHint: null,
    maxRuns: null,
    spendCapUsd: null,
    models: {},
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(t.factoryProjects).values(project);
  await db
    .update(t.trackerIssues)
    .set({ projectId: project.id })
    .where(isNull(t.trackerIssues.projectId));
  return project;
}

/**
 * Creates or updates a project from the editor, after checking what can be checked: the folder
 * and its scripts; the team, statuses and label read back from Linear with the key the project
 * will use; the Linear project in that team; the repository read back from GitHub. A part left
 * empty inherits the workspace's. Nothing is written when a check fails.
 */
export async function saveProject(
  db: Db,
  id: string | null,
  input: ProjectInput,
): Promise<{ project: FactoryProject; notes: string[] }> {
  const current = id ? await getProject(db, id) : undefined;
  if (id && !current) throw new ProjectError('That project no longer exists.');
  // The factory as it was comes first, so a new project never takes its place (D45).
  if (!id) await ensureDefaultProject(db);
  const notes: string[] = [];

  let found: { path: string; scripts: string[] };
  try {
    found = await checkRepository({
      path: input.repoPath,
      scripts: parseScripts(input.scripts),
      noScripts: 'Name at least one script, such as test: the Test Agent runs the checks.',
    });
  } catch (err) {
    if (err instanceof RosterValidationError) {
      throw new ProjectError(err.message, err.field === 'path' ? 'repoPath' : 'scripts');
    }
    throw err;
  }

  // Linear: the project's own team, read back with the key it will use.
  let linear: FactoryProject['linear'] = { team: null, project: null, label: null, states: {} };
  const ws = await getLinearSettings(db);
  const linearKey = current?.linearKeyRef ?? ws.keyRef;
  if (input.linear.teamId) {
    const key = linearKey ? await readSecret(db, linearKey) : null;
    if (!key)
      throw new ProjectError('Save a Linear key first, in Settings or on this project.', 'linear');
    const tracker = trackerFor(key);
    try {
      const read = await readBackMapping(tracker, {
        teamId: input.linear.teamId,
        label: input.linear.label || 'magpipe',
        states: input.linear.states,
      });
      let project: FactoryProject['linear']['project'] = null;
      if (input.linear.projectId) {
        const projects = await tracker.projects(read.team.id);
        const p = projects.find((x) => x.id === input.linear.projectId);
        if (!p)
          throw new ProjectError(
            `${read.team.name} has no such Linear project any more.`,
            'linear',
          );
        project = p;
      }
      linear = {
        team: read.team,
        project,
        label: { id: read.label.id, name: read.label.name },
        states: read.states,
      };
      notes.push(
        `Read back from Linear: ${read.statuses} statuses in ${read.team.name}${project ? `, project ${project.name}` : ''}, and the label ${read.label.name}${read.label.created ? ', made just now' : ''}.`,
      );
    } catch (err) {
      if (err instanceof LinearMappingError) throw new ProjectError(err.message, 'linear');
      throw err;
    }
  }

  // GitHub: the project's own repository, read back with the token it will use.
  let github: FactoryProject['github'] = { ...EMPTY_GITHUB };
  if (input.github.repo) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.github.repo)) {
      throw new ProjectError('Give the repository as owner/name.', 'github');
    }
    const fs = await getForgeSettings(db);
    const ref = current?.githubKeyRef ?? fs.keyRef;
    const token = ref ? await readSecret(db, ref) : null;
    if (!token)
      throw new ProjectError(
        'Save a GitHub token first, in Settings or on this project.',
        'github',
      );
    const { defaultBranch } = await forgeFor(token).repository(input.github.repo);
    github = { ...input.github, repo: input.github.repo };
    notes.push(`Read back from GitHub: ${input.github.repo}, default branch ${defaultBranch}.`);
  }

  const now = new Date();
  const fields = {
    name: input.name,
    repoPath: found.path,
    scripts: found.scripts,
    context: input.context.trim(),
    linear,
    github,
    maxRuns: input.maxRuns,
    spendCapUsd: input.spendCapUsd,
    models: Object.fromEntries(Object.entries(input.models).filter(([, m]) => m)),
    updatedAt: now,
  };
  if (current) {
    const [row] = await db
      .update(t.factoryProjects)
      .set(fields)
      .where(eq(t.factoryProjects.id, current.id))
      .returning();
    // A new mapping: the next check reads every labelled issue again.
    if (current.linear.team?.id !== linear.team?.id) {
      await db.update(t.linearSettings).set({ lastCheckAt: null });
    }
    return { project: row!, notes };
  }
  const project: FactoryProject = {
    id: newId('proj'),
    ...fields,
    linearKeyRef: null,
    linearKeyHint: null,
    githubKeyRef: null,
    githubKeyHint: null,
    createdAt: now,
  };
  await db.insert(t.factoryProjects).values(project);
  await db.update(t.linearSettings).set({ lastCheckAt: null });
  return { project, notes };
}

/**
 * A project's own Linear key or GitHub token (D45), checked with the service before it is sealed;
 * null removes it, so the project uses the workspace's again.
 */
export async function setProjectKey(
  db: Db,
  id: string,
  kind: 'linear' | 'github',
  key: string | null,
): Promise<{ project: FactoryProject; who: string | null }> {
  const project = await getProject(db, id);
  if (!project) throw new ProjectError('That project no longer exists.');
  const before = kind === 'linear' ? project.linearKeyRef : project.githubKeyRef;
  let ref: string | null = null;
  let hint: string | null = null;
  let who: string | null = null;
  if (key) {
    const clean = key.trim();
    who =
      kind === 'linear'
        ? (await trackerFor(clean).viewer()).name
        : (await forgeFor(clean).viewer()).login;
    ref = await storeSecret(db, clean);
    hint = clean.slice(-4);
  }
  const [row] = await db
    .update(t.factoryProjects)
    .set(
      kind === 'linear'
        ? { linearKeyRef: ref, linearKeyHint: hint, updatedAt: new Date() }
        : { githubKeyRef: ref, githubKeyHint: hint, updatedAt: new Date() },
    )
    .where(eq(t.factoryProjects.id, id))
    .returning();
  if (before) await deleteSecret(db, before);
  return { project: row!, who };
}

/** Deletes a project. Its issues stay, without a project; its keys are removed. */
export async function deleteProject(db: Db, id: string): Promise<boolean> {
  const project = await getProject(db, id);
  if (!project) return false;
  await db.delete(t.factoryProjects).where(eq(t.factoryProjects.id, id));
  for (const ref of [project.linearKeyRef, project.githubKeyRef]) {
    if (ref) await deleteSecret(db, ref);
  }
  return true;
}

/** The six statuses as the editor sends them, for a project inheriting the workspace's. */
export function emptyStates(): Record<string, string> {
  return Object.fromEntries(pipelineStates.map((p) => [p, '']));
}

/** The project an issue or run belongs to and the Linear settings it works with. */
export async function linearOf(
  db: Db,
  projectId?: string | null,
): Promise<{ project: FactoryProject | undefined; settings: LinearSettings }> {
  const project = await resolveProject(db, projectId);
  return { project, settings: await projectLinear(db, project) };
}

/** The project an issue or run belongs to and the GitHub settings it works with. */
export async function forgeOf(
  db: Db,
  projectId?: string | null,
): Promise<{ project: FactoryProject | undefined; settings: ForgeSettings }> {
  const project = await resolveProject(db, projectId);
  return { project, settings: await projectForge(db, project) };
}

/** The tracker a project's editor reads Linear with: its own key, else the workspace's. */
async function editorTracker(db: Db, id: string | null): Promise<Tracker> {
  const project = id ? await getProject(db, id) : undefined;
  const ref = project?.linearKeyRef ?? (await getLinearSettings(db)).keyRef;
  const key = ref ? await readSecret(db, ref) : null;
  if (!key)
    throw new LinearNotReadyError('Save a Linear key first, in Settings or on this project.');
  return trackerFor(key);
}

/**
 * What the editor offers for a project's own Linear (D45): the teams the key sees and, for one
 * team, its statuses with a first guess and its Linear projects.
 */
export async function projectLinearOptions(
  db: Db,
  id: string | null,
  teamId?: string,
): Promise<{
  teams: TrackerTeam[];
  states: TrackerState[];
  projects: TrackerRef[];
  suggested: Record<PipelineState, string> | null;
}> {
  const tracker = await editorTracker(db, id);
  const teams = await tracker.teams();
  if (!teamId) return { teams, states: [], projects: [], suggested: null };
  const [states, projects] = await Promise.all([tracker.states(teamId), tracker.projects(teamId)]);
  return { teams, states, projects, suggested: suggestStates(states) };
}

/** What a project inherits, in the editor's words (D45). */
export async function workspaceDefaults(db: Db): Promise<{
  linear: string;
  github: string;
  maxRuns: number;
  hasLinearKey: boolean;
  hasGithubKey: boolean;
}> {
  const [linear, forge, [settings]] = await Promise.all([
    getLinearSettings(db),
    getForgeSettings(db),
    db.select({ maxRuns: t.settings.maxRuns }).from(t.settings),
  ]);
  return {
    linear: linear.team
      ? `the workspace’s team, ${linear.team.name} (${linear.team.key}), with its label and statuses`
      : 'the workspace’s, which Settings has not mapped yet',
    github: forge.repo
      ? `the workspace’s, ${forge.repo}`
      : 'the workspace’s, which Settings has not set yet',
    maxRuns: settings?.maxRuns ?? 2,
    hasLinearKey: linear.keyRef !== null,
    hasGithubKey: forge.keyRef !== null,
  };
}

/** Specs and goals per project, for the list. */
export async function projectCounts(
  db: Db,
): Promise<Map<string, { specs: number; goals: number }>> {
  const rows = await db
    .select({ projectId: t.trackerIssues.projectId, goal: t.trackerIssues.goal })
    .from(t.trackerIssues);
  const out = new Map<string, { specs: number; goals: number }>();
  for (const r of rows) {
    if (!r.projectId) continue;
    const c = out.get(r.projectId) ?? { specs: 0, goals: 0 };
    if (r.goal) c.goals++;
    else c.specs++;
    out.set(r.projectId, c);
  }
  return out;
}

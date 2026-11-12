/**
 * Factory projects (D45, D46): each one a repository with its own GitHub repository and its own
 * Linear project, where its specs and goals are filed and its pull requests land. Only the keys
 * are shared: Settings holds one Linear key and one GitHub token for every project, and a project
 * may carry its own. The factory as it was set up before projects is the Default project, which
 * takes the workspace's old team, statuses and repository once and then owns them.
 */
import 'server-only';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './db';
import * as t from './db/schema';
import { newId } from './ids';
import { checkRepository, parseScripts, RosterValidationError } from './roster';
import { deleteSecret, storeSecret } from './secrets';
import {
  type FactoryProject,
  type Run,
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
import { ForgeError, forgeFor, forgeReady, getForgeSettings, repoFromRemote } from './forge';
import { originUrl } from './worktrees';
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

const EMPTY_GITHUB: FactoryProject['github'] = {
  repo: null,
  mergeMethod: 'squash',
  autoMerge: false,
  autoMergeLabel: 'auto-merge',
  autoMergeFirstPass: true,
  autoMergeChecks: true,
};

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

/**
 * The Linear settings a project works with (D46): its own team, label and statuses, and its own
 * key or the shared one. A project without its Linear project has no Linear yet: the team is left
 * out, so nothing is filed or watched for it until the operator picks one. No project, no Linear.
 */
export async function projectLinear(
  db: Db,
  project: FactoryProject | undefined,
): Promise<LinearSettings> {
  const ws = await getLinearSettings(db);
  const own = project?.linear.project ? project.linear : null;
  return {
    ...ws,
    keyRef: project?.linearKeyRef ?? ws.keyRef,
    team: own?.team ?? null,
    label: own?.label ?? null,
    states: own?.states ?? {},
  };
}

/** The Linear project a project files into and reads from, if it names one. */
export function linearProjectOf(project: FactoryProject | undefined): string | undefined {
  return project?.linear.project?.id ?? undefined;
}

/**
 * The GitHub settings a project works with (D46): its own repository, merge method and rule, and
 * its own token or the shared one. No project, no repository.
 */
export async function projectForge(
  db: Db,
  project: FactoryProject | undefined,
): Promise<ForgeSettings> {
  const ws = await getForgeSettings(db);
  const gh = project?.github ?? EMPTY_GITHUB;
  return {
    ...ws,
    keyRef: project?.githubKeyRef ?? ws.keyRef,
    repo: gh.repo,
    mergeMethod: gh.mergeMethod,
    autoMerge: gh.autoMerge,
    autoMergeLabel: gh.autoMergeLabel,
    autoMergeFirstPass: gh.autoMergeFirstPass,
    autoMergeChecks: gh.autoMergeChecks,
  };
}

/** What is still missing before a project's factory runs end to end, in the operator's words. */
export type ProjectGap = 'linear_key' | 'linear_project' | 'github_token' | 'github_repo';

/** What a screen shows of a project: no key refs, and what it still needs. */
export type ProjectView = Omit<FactoryProject, 'linearKeyRef' | 'githubKeyRef'> & {
  hasLinearKey: boolean;
  hasGithubKey: boolean;
  linearReady: boolean;
  githubReady: boolean;
  gaps: ProjectGap[];
};

export async function projectView(db: Db, project: FactoryProject): Promise<ProjectView> {
  const [linear, forge] = await Promise.all([
    projectLinear(db, project),
    projectForge(db, project),
  ]);
  const { linearKeyRef, githubKeyRef, ...rest } = project;
  const gaps: ProjectGap[] = [];
  if (!linear.keyRef) gaps.push('linear_key');
  // The Linear project and its mapping, whatever the key: a missing key is its own gap.
  if (!linearReady({ ...linear, keyRef: linear.keyRef ?? 'any' })) gaps.push('linear_project');
  if (!forge.keyRef) gaps.push('github_token');
  if (!forge.repo) gaps.push('github_repo');
  return {
    ...rest,
    hasLinearKey: linearKeyRef !== null,
    hasGithubKey: githubKeyRef !== null,
    linearReady: linearReady(linear),
    githubReady: forgeReady(forge),
    gaps,
  };
}

/**
 * The factory as it was before projects (D45, D46): when the factory is loaded and no project
 * exists, a Default project is made on its repository with the team, label, statuses, repository
 * and rule Settings held before projects, and every issue without a project joins it. It still
 * needs its Linear project before it files or watches anything. Safe to call often.
 */
export async function ensureDefaultProject(db: Db): Promise<FactoryProject | undefined> {
  const existing = await listProjects(db);
  if (existing.length > 0) {
    await adoptWorkspace(db, existing);
    return undefined;
  }
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
    ...(await workspaceSeed(db)),
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

/** What Settings held before projects owned their Linear and GitHub (D46). */
async function workspaceSeed(db: Db): Promise<Pick<FactoryProject, 'linear' | 'github'>> {
  const [ws, fs] = await Promise.all([getLinearSettings(db), getForgeSettings(db)]);
  return {
    linear: { team: ws.team, project: null, label: ws.label, states: ws.states },
    github: {
      repo: fs.repo,
      mergeMethod: fs.mergeMethod,
      autoMerge: fs.autoMerge,
      autoMergeLabel: fs.autoMergeLabel,
      autoMergeFirstPass: fs.autoMergeFirstPass,
      autoMergeChecks: fs.autoMergeChecks,
    },
  };
}

/**
 * A Default project made under D45 inherited the workspace's team and repository instead of
 * holding them. Under D46 it holds them: the only project, still empty on a side, takes what
 * Settings held, once.
 */
async function adoptWorkspace(db: Db, projects: FactoryProject[]): Promise<void> {
  if (projects.length !== 1) return;
  const [only] = projects as [FactoryProject];
  if (only.linear.team && only.github.repo) return;
  const seed = await workspaceSeed(db);
  const linear = only.linear.team || !seed.linear.team ? null : seed.linear;
  const github = only.github.repo || !seed.github.repo ? null : seed.github;
  if (!linear && !github) return;
  await db
    .update(t.factoryProjects)
    .set({ ...(linear ? { linear } : {}), ...(github ? { github } : {}), updatedAt: new Date() })
    .where(eq(t.factoryProjects.id, only.id));
}

/**
 * Creates or updates a project from the editor, after checking what can be checked: the folder
 * and its scripts; the team, statuses and label read back from Linear with the key the project
 * will use; the Linear project in that team, which no other project holds; the repository read
 * back from GitHub, which no other project holds and the folder's origin does not contradict.
 * Both are required (D46). Nothing is written when a check fails.
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

  const others = (await listProjects(db)).filter((p) => p.id !== current?.id);

  // Linear: the project's own team and Linear project, read back with the key it will use.
  let linear: FactoryProject['linear'];
  let tracker: Tracker;
  const ws = await getLinearSettings(db);
  const linearKey = current?.linearKeyRef ?? ws.keyRef;
  {
    const clash = others.find((p) => p.linear.project?.id === input.linear.projectId);
    if (clash) {
      throw new ProjectError(
        `${clash.name} already files into that Linear project. Each project needs its own.`,
        'linear',
      );
    }
    const key = linearKey ? await readSecret(db, linearKey) : null;
    if (!key) throw new ProjectError(noKey('Linear key', current), 'linear');
    tracker = trackerFor(key);
    try {
      const read = await readBackMapping(tracker, {
        teamId: input.linear.teamId,
        label: input.linear.label || 'magpipe',
        states: input.linear.states,
      });
      const projects = await tracker.projects(read.team.id);
      const project = projects.find((x) => x.id === input.linear.projectId);
      if (!project) {
        throw new ProjectError(`${read.team.name} has no such Linear project any more.`, 'linear');
      }
      linear = {
        team: read.team,
        project,
        label: { id: read.label.id, name: read.label.name },
        states: read.states,
      };
      notes.push(
        `Read back from Linear: ${read.statuses} statuses in ${read.team.name}, project ${project.name}, and the label ${read.label.name}${read.label.created ? ', made just now' : ''}.`,
      );
    } catch (err) {
      if (err instanceof LinearMappingError) throw new ProjectError(err.message, 'linear');
      throw err;
    }
  }

  // GitHub: the project's own repository, read back with the token it will use.
  let github: FactoryProject['github'];
  {
    // The action's schema checks this too; the library keeps its own guard.
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.github.repo)) {
      throw new ProjectError('Give the GitHub repository as owner/name.', 'github');
    }
    const same = (a: string | null) => a?.toLowerCase() === input.github.repo.toLowerCase();
    const clash = others.find((p) => same(p.github.repo));
    if (clash) {
      throw new ProjectError(
        `${clash.name} already lands in ${input.github.repo}. Each project needs its own repository.`,
        'github',
      );
    }
    // Goals are pushed to the folder's origin, so it must be this repository when it is GitHub.
    const origin = await originUrl(found.path);
    const fromOrigin = origin ? repoFromRemote(origin) : null;
    if (fromOrigin && !same(fromOrigin)) {
      throw new ProjectError(
        `The folder’s origin is ${fromOrigin}, not ${input.github.repo}. Pick the repository the folder pushes to.`,
        'github',
      );
    }
    const fs = await getForgeSettings(db);
    const ref = current?.githubKeyRef ?? fs.keyRef;
    const token = ref ? await readSecret(db, ref) : null;
    if (!token) throw new ProjectError(noKey('GitHub token', current), 'github');
    const { defaultBranch } = await forgeFor(token)
      .repository(input.github.repo)
      .catch((err: unknown) => {
        throw err instanceof ForgeError ? new ProjectError(err.message, 'github') : err;
      });
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
    // Any change to the mapping: the next check reads every labelled issue again, so each takes
    // its stage from the new statuses and label.
    if (mappingKey(current.linear) !== mappingKey(linear)) {
      await db.update(t.linearSettings).set({ lastCheckAt: null });
    }
    // A new Linear project: the project's open issues follow it, so the watcher, which reads
    // only that Linear project, still sees them (D46).
    if (current.linear.project?.id !== linear.project!.id) {
      notes.push(...(await moveOpenIssues(db, tracker!, current.id, linear.project!)));
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

/** Ids that say whether two mappings differ: team, Linear project, label and each status. */
function mappingKey(l: FactoryProject['linear']): string {
  return JSON.stringify([
    l.team?.id ?? null,
    l.project?.id ?? null,
    l.label?.id ?? null,
    Object.entries(l.states)
      .map(([k, v]) => `${k}:${v?.id ?? ''}`)
      .sort(),
  ]);
}

/** The message for a missing key: a new project can only use the shared one in Settings. */
function noKey(what: string, current: FactoryProject | undefined): string {
  return current
    ? `Save a ${what} first, in Settings or on this project.`
    : `Save the shared ${what} in Settings first.`;
}

/**
 * A project's issues that are still in flight: waiting, approved, building, at the merge
 * question, needing the operator, or done in Linear with a pull request not merged yet.
 */
async function openIssues(db: Db, projectId: string) {
  const rows = await db
    .select()
    .from(t.trackerIssues)
    .where(eq(t.trackerIssues.projectId, projectId));
  return rows.filter(
    (i) =>
      (i.stage !== 'done' && i.stage !== 'other') || (i.prNumber !== null && i.mergedAt === null),
  );
}

/** Moves a project's open issues into its Linear project, saying what moved and what did not. */
async function moveOpenIssues(
  db: Db,
  tracker: Tracker,
  projectId: string,
  to: TrackerRef,
): Promise<string[]> {
  const open = await openIssues(db, projectId);
  if (open.length === 0) return [];
  const moved: string[] = [];
  const failed: string[] = [];
  for (const issue of open) {
    try {
      await tracker.setProject(issue.externalId, to.id);
      moved.push(issue.identifier);
    } catch (err) {
      failed.push(`${issue.identifier} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return [
    ...(moved.length
      ? [`Moved ${moved.join(', ')} into ${to.name}, so they are still watched.`]
      : []),
    ...(failed.length
      ? [`Could not move ${failed.join('; ')} into ${to.name}: move them there in Linear.`]
      : []),
  ];
}

/**
 * Deletes a project (D46): never the last one, the factory needs a project to build in, and
 * never one with work in flight, which would be left with no repository or Linear. Its finished
 * issues stay, without a project; its keys are removed.
 */
export async function deleteProject(db: Db, id: string): Promise<boolean> {
  const project = await getProject(db, id);
  if (!project) return false;
  if ((await listProjects(db)).length === 1) {
    throw new ProjectError(
      'This is the only project. Add another before deleting it: the factory needs one to build in.',
    );
  }
  const open = await openIssues(db, id);
  const [{ going } = { going: 0 }] = await db
    .select({ going: sql<number>`count(*)::int` })
    .from(t.runs)
    .where(
      and(
        sql`${t.runs.input}->>'projectId' = ${id}`,
        inArray(t.runs.status, ['queued', 'running', 'waiting']),
      ),
    );
  if (open.length || going) {
    const parts = [
      open.length
        ? `${open.length === 1 ? 'an open issue' : `${open.length} open issues`} (${open
            .slice(0, 5)
            .map((i) => i.identifier)
            .join(', ')}${open.length > 5 ? '…' : ''})`
        : '',
      going ? `${going === 1 ? 'a run going' : `${going} runs going`}` : '',
    ].filter(Boolean);
    throw new ProjectError(
      `${project.name} still has ${parts.join(' and ')}. Finish or close them first: a deleted project's work would be left with no repository or Linear.`,
    );
  }
  await db.delete(t.factoryProjects).where(eq(t.factoryProjects.id, id));
  for (const ref of [project.linearKeyRef, project.githubKeyRef]) {
    if (ref) await deleteSecret(db, ref);
  }
  return true;
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

/** The shared keys and the workspace limit, for the editor (D46). */
export async function workspaceDefaults(db: Db): Promise<{
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
    maxRuns: settings?.maxRuns ?? 2,
    hasLinearKey: linear.keyRef !== null,
    hasGithubKey: forge.keyRef !== null,
  };
}

/** What the Factory list says about each project (D46). */
export type ProjectCounts = {
  specs: number;
  goals: number;
  /** Specs waiting for approval and goals waiting at the question to merge. */
  waiting: number;
  /** Goals approved and not done yet. */
  open: number;
};

/** Specs, goals and what waits for the operator, per project. */
export async function projectCounts(db: Db): Promise<Map<string, ProjectCounts>> {
  const rows = await db
    .select({
      projectId: t.trackerIssues.projectId,
      goal: t.trackerIssues.goal,
      stage: t.trackerIssues.stage,
      prNumber: t.trackerIssues.prNumber,
      mergeRequestedAt: t.trackerIssues.mergeRequestedAt,
    })
    .from(t.trackerIssues);
  const out = new Map<string, ProjectCounts>();
  for (const r of rows) {
    if (!r.projectId) continue;
    const c = out.get(r.projectId) ?? { specs: 0, goals: 0, waiting: 0, open: 0 };
    if (r.goal) {
      c.goals++;
      if (r.stage === 'merge_question' && r.prNumber !== null && !r.mergeRequestedAt) c.waiting++;
      if (r.stage === 'approved' || r.stage === 'building' || r.stage === 'merge_question')
        c.open++;
    } else {
      c.specs++;
      if (r.stage === 'spec_ready') c.waiting++;
    }
    out.set(r.projectId, c);
  }
  return out;
}

/** A project's factory runs, latest first: the specs, goals, builds and lands it started. */
export async function projectRuns(
  db: Db,
  id: string,
  limit = 8,
): Promise<Pick<Run, 'id' | 'displayId' | 'status' | 'input' | 'createdAt'>[]> {
  return db
    .select({
      id: t.runs.id,
      displayId: t.runs.displayId,
      status: t.runs.status,
      input: t.runs.input,
      createdAt: t.runs.createdAt,
    })
    .from(t.runs)
    .where(sql`${t.runs.input}->>'projectId' = ${id}`)
    .orderBy(desc(t.runs.createdAt))
    .limit(limit);
}

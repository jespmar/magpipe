/**
 * Factory projects (D45, D46) against the scripted tracker and forge: the factory as it was is
 * the Default project, which takes the workspace's old team, statuses and repository once and
 * then owns them; nothing is inherited, so a project files and watches only once it names its
 * own Linear project. A project with its own Linear project and repository files there and
 * claims its issues; a spec run carries its project's folder, context, models and spend cap;
 * builds keep to a project's own limit.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { Engine } from '@/lib/engine';
import type { ModelClient, ModelMessage } from '@/lib/engine/model';
import { loadFactory, readyGoals, templatePlan } from '@/lib/factory';
import { getForgeSettings, saveForgeKey, useForgeFactory } from '@/lib/forge';
import { scriptedForge, scriptedForgeStore } from '@/lib/forge/scripted';
import {
  deleteProject,
  ensureDefaultProject,
  getProject,
  linearOf,
  listProjects,
  projectForge,
  projectLinear,
  projectLinearOptions,
  projectView,
  ProjectError,
  saveProject,
  setProjectKey,
} from '@/lib/projects';
import { listEvents } from '@/lib/engine/events';
import { createRun, getRun } from '@/lib/runs';
import { projectInput, type FactoryProject, type ProjectInput } from '@/lib/schemas';
import { spendToday } from '@/lib/spend';
import {
  getLinearSettings,
  getTracker,
  readBackMapping,
  saveLinearKey,
  useTrackerFactory,
} from '@/lib/tracker';
import { checkLinear, getIssue, issueForRun, recordFiledIssue } from '@/lib/tracker/issues';
import {
  SCRIPTED_PROJECTS,
  SCRIPTED_TEAM,
  scriptedStore,
  scriptedTracker,
} from '@/lib/tracker/scripted';
import { setUpProject, SCRIPTED_MAPPING as STATES } from './stubs/project';

const SECRET = Buffer.from('unit-test-key-unit-test-key-0123').toString('base64url');

/** The Default project files into API; the project the tests add files into Web app. */
const API = SCRIPTED_PROJECTS[1]!;

/** The rule and repository Settings held before projects owned their GitHub (D46). */
const WORKSPACE_GITHUB = {
  repo: 'o/default',
  mergeMethod: 'rebase' as const,
  autoMerge: true,
  autoMergeLabel: 'ship-it',
  autoMergeFirstPass: false,
  autoMergeChecks: true,
};

function text(s: string): ModelMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text: s, citations: null }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as ModelMessage;
}

const SPEC = '# Export runs as CSV\n\n## Problem\n\nCopying by hand.\n\n## Outcome\n\nA CSV.';

function repo(prefix: string, origin?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e 0', lint: 'node -e 0' } }),
  );
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
  return dir;
}

/** A complete project for the editor: Web app's Linear project and repository o/web. */
function input(over: Partial<ProjectInput> & Pick<ProjectInput, 'repoPath'>): ProjectInput {
  return {
    name: 'Web app',
    scripts: 'test',
    context: '',
    linear: { teamId: SCRIPTED_TEAM.id, projectId: 'lp_web', label: 'magpipe', states: STATES },
    github: {
      repo: 'o/web',
      mergeMethod: 'squash',
      autoMerge: false,
      autoMergeLabel: 'auto-merge',
      autoMergeFirstPass: true,
      autoMergeChecks: true,
    },
    maxRuns: null,
    spendCapUsd: null,
    models: {},
    ...over,
  };
}

/** A project's own settings as the editor sends them back unchanged. */
function editOf(p: FactoryProject): ProjectInput {
  return {
    name: p.name,
    repoPath: p.repoPath,
    scripts: p.scripts.join(', '),
    context: p.context,
    linear: {
      teamId: p.linear.team!.id,
      projectId: p.linear.project!.id,
      label: p.linear.label!.name,
      states: Object.fromEntries(Object.entries(p.linear.states).map(([k, v]) => [k, v!.id])),
    },
    github: { ...p.github, repo: p.github.repo! },
    maxRuns: p.maxRuns,
    spendCapUsd: p.spendCapUsd,
    models: p.models,
  };
}

describe('factory projects', () => {
  let db: Db;
  let close: () => Promise<void>;
  let first: string;
  let second: string;
  let elsewhere: string;
  const store = scriptedStore(true);
  const forgeStore = scriptedForgeStore(true);
  const previous = process.env.MAGPIPE_SECRET_KEY;
  let def: FactoryProject;
  let web: FactoryProject;

  beforeAll(async () => {
    process.env.MAGPIPE_SECRET_KEY = SECRET;
    useTrackerFactory((key) => scriptedTracker(key, store));
    useForgeFactory((token) => scriptedForge(token, forgeStore));
    ({ db, close } = await openDb('memory://'));
    first = repo('magpipe-proj-a-');
    second = repo('magpipe-proj-b-');
    elsewhere = repo('magpipe-proj-c-', 'https://github.com/someone/else.git');
    await loadFactory(db, { path: first, scripts: ['test'] });
    await saveLinearKey(db, 'lin_api_projects');
    await saveForgeKey(db, 'ghp_projects_shared');
  }, 30_000);
  afterAll(async () => {
    useTrackerFactory(undefined);
    useForgeFactory(undefined);
    await close();
    for (const d of [first, second, elsewhere]) fs.rmSync(d, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MAGPIPE_SECRET_KEY;
    else process.env.MAGPIPE_SECRET_KEY = previous;
  });

  it('makes the factory as it was the Default project, once, with what Settings held, and gives it the orphan issues', async () => {
    // Loading the factory made it already.
    const loaded = await listProjects(db);
    expect(loaded.map((p) => p.name)).toEqual(['Default']);
    expect(await ensureDefaultProject(db)).toBeUndefined();

    // A factory from before projects: Settings held the team, statuses, label, repository and
    // rule (written directly: the save functions for them are gone), no project, and an issue
    // without one.
    const read = await readBackMapping(await getTracker(db), {
      teamId: SCRIPTED_TEAM.id,
      label: 'magpipe',
      states: STATES,
    });
    await db.update(t.linearSettings).set({
      team: read.team,
      label: { id: read.label.id, name: read.label.name },
      states: read.states,
    });
    await db.update(t.forgeSettings).set(WORKSPACE_GITHUB);
    await db.delete(t.factoryProjects);
    const tracker = scriptedTracker('k', store);
    const remote = await tracker.createIssue({
      teamId: SCRIPTED_TEAM.id,
      title: 'Before projects',
      description: '',
      labelIds: [],
      stateId: 'st_spec',
    });
    const run = await createRun(db, { text: 'old', attachments: [] });
    const orphan = await recordFiledIssue(db, remote, {
      runId: run.id,
      settings: await getLinearSettings(db),
    });
    expect(orphan.projectId).toBeNull();

    def = (await ensureDefaultProject(db))!;
    expect(def).toMatchObject({ name: 'Default', repoPath: fs.realpathSync(first) });
    expect(def.scripts).toEqual(['test']);
    expect(await ensureDefaultProject(db)).toBeUndefined();
    expect(await listProjects(db)).toHaveLength(1);
    expect((await getIssue(db, orphan.id))!.projectId).toBe(def.id);

    // It takes over what Settings held (D46), all but a Linear project, which Settings never had.
    expect(def.linear).toEqual({
      team: SCRIPTED_TEAM,
      project: null,
      label: { id: read.label.id, name: 'magpipe' },
      states: read.states,
    });
    expect(def.github).toEqual(WORKSPACE_GITHUB);
    // Without its Linear project it files and watches nothing yet.
    const view = await projectView(db, def);
    expect(view.linearReady).toBe(false);
    expect(view.gaps).toContain('linear_project');
    expect(view.gaps).not.toContain('github_repo');
    expect(view.githubReady).toBe(true);
    expect(view).not.toHaveProperty('linearKeyRef');
  });

  it('inherits nothing from Settings: no Linear project, no team; no repository, no repository', async () => {
    // The workspace row still holds a team and a repository.
    expect((await getLinearSettings(db)).team).toEqual(SCRIPTED_TEAM);
    const linear = await projectLinear(db, def);
    expect(linear.team).toBeNull();
    expect(linear.label).toBeNull();
    expect(linear.states).toEqual({});
    // The keys are the only thing shared: the workspace's own key and token.
    expect(linear.keyRef).toBe((await getLinearSettings(db)).keyRef);
    expect(linear.keyRef).not.toBeNull();
    const bare = { ...def, github: { ...def.github, repo: null } };
    const forge = await projectForge(db, bare);
    expect(forge.repo).toBeNull();
    expect(forge.keyRef).toBe((await getForgeSettings(db)).keyRef);
    expect(forge.keyRef).not.toBeNull();
    expect((await projectView(db, bare)).gaps).toEqual(['linear_project', 'github_repo']);
    // No project, no Linear and no repository at all.
    expect((await projectLinear(db, undefined)).team).toBeNull();
    expect((await projectForge(db, undefined)).repo).toBeNull();
  });

  it('a lone project made under D45, empty on both sides, takes what Settings held', async () => {
    await db
      .update(t.factoryProjects)
      .set({
        linear: { team: null, project: null, label: null, states: {} },
        github: { ...WORKSPACE_GITHUB, repo: null, mergeMethod: 'squash', autoMerge: false },
      })
      .where(eq(t.factoryProjects.id, def.id));
    expect(await ensureDefaultProject(db)).toBeUndefined();
    const adopted = (await getProject(db, def.id))!;
    expect(adopted.linear).toEqual(def.linear);
    expect(adopted.github).toEqual(WORKSPACE_GITHUB);

    // Once it holds them, Settings no longer reaches it, on either side.
    const before = await getLinearSettings(db);
    await db.update(t.forgeSettings).set({ repo: 'o/changed' });
    await db
      .update(t.linearSettings)
      .set({ label: { id: 'lbl_other', name: 'other' }, states: {} });
    await ensureDefaultProject(db);
    const kept = (await getProject(db, def.id))!;
    expect(kept.github.repo).toBe('o/default');
    expect(kept.linear).toEqual(def.linear);
    await db.update(t.forgeSettings).set({ repo: WORKSPACE_GITHUB.repo });
    await db.update(t.linearSettings).set({ label: before.label, states: before.states });

    // The Default project gets its Linear project (API) and files and watches from now on.
    def = await setUpProject(db, { linearProject: API });
    expect(def.linear.project).toEqual(API);
    expect(def.github).toEqual(WORKSPACE_GITHUB);
    expect((await projectView(db, def)).linearReady).toBe(true);
    expect((await projectLinear(db, def)).team).toEqual(SCRIPTED_TEAM);
  });

  it('checks what a project names before saving it', async () => {
    // What the action's schema refuses before the library sees it.
    const blank = projectInput.safeParse(
      input({
        repoPath: second,
        linear: { teamId: SCRIPTED_TEAM.id, projectId: '', label: 'magpipe', states: STATES },
        github: { ...input({ repoPath: '' }).github, repo: 'not a repo' },
      }),
    );
    expect(blank.success).toBe(false);
    const messages = blank.error!.issues.map((i) => i.message);
    expect(messages).toContain('Pick the Linear project this project files into.');
    expect(messages).toContain('Give the GitHub repository as owner/name.');

    await expect(saveProject(db, null, input({ repoPath: '/no/such/folder' }))).rejects.toThrow(
      ProjectError,
    );
    await expect(
      saveProject(db, null, input({ repoPath: second, scripts: 'deploy' })),
    ).rejects.toMatchObject({ field: 'scripts' });
    await expect(
      saveProject(
        db,
        null,
        input({
          repoPath: second,
          linear: {
            teamId: SCRIPTED_TEAM.id,
            projectId: 'lp_gone',
            label: 'magpipe',
            states: STATES,
          },
        }),
      ),
    ).rejects.toThrow('Magpipe has no such Linear project any more.');
    // Each Linear project belongs to one project.
    await expect(
      saveProject(
        db,
        null,
        input({
          repoPath: second,
          linear: { teamId: SCRIPTED_TEAM.id, projectId: API.id, label: 'magpipe', states: STATES },
        }),
      ),
    ).rejects.toMatchObject({
      field: 'linear',
      message: expect.stringContaining('Default already files into that Linear project'),
    });
    // The statuses are read back as the Settings mapping was: one status per state.
    await expect(
      saveProject(
        db,
        null,
        input({
          repoPath: second,
          linear: {
            teamId: SCRIPTED_TEAM.id,
            projectId: 'lp_web',
            label: 'magpipe',
            states: { ...STATES, approved: STATES.spec_ready },
          },
        }),
      ),
    ).rejects.toMatchObject({ field: 'linear', message: expect.stringContaining('both use') });
    // Each repository belongs to one project.
    await expect(
      saveProject(
        db,
        null,
        input({
          repoPath: second,
          github: { ...input({ repoPath: '' }).github, repo: 'O/Default' },
        }),
      ),
    ).rejects.toMatchObject({
      field: 'github',
      message: expect.stringContaining('Default already lands in O/Default'),
    });
    // The folder pushes to its origin, so a GitHub origin must be the repository.
    await expect(saveProject(db, null, input({ repoPath: elsewhere }))).rejects.toMatchObject({
      field: 'github',
      message: expect.stringContaining('The folder’s origin is someone/else, not o/web.'),
    });
    // The repository is read back from GitHub.
    await expect(
      saveProject(
        db,
        null,
        input({
          repoPath: second,
          github: { ...input({ repoPath: '' }).github, repo: 'nobody/x' },
        }),
      ),
    ).rejects.toMatchObject({
      field: 'github',
      message: 'GitHub found nothing at /repos/nobody/x.',
    });
    // The library keeps its own owner/name guard behind the action's schema.
    await expect(
      saveProject(
        db,
        null,
        input({
          repoPath: second,
          github: { ...input({ repoPath: '' }).github, repo: 'not a repo' },
        }),
      ),
    ).rejects.toMatchObject({
      field: 'github',
      message: 'Give the GitHub repository as owner/name.',
    });
    expect(await listProjects(db)).toHaveLength(1);
  });

  it('saves a project with its own Linear project and repository, read back from both', async () => {
    // A new project means a new Linear project to read: the next check reads every issue.
    await db.update(t.linearSettings).set({ lastCheckAt: new Date() });
    const options = await projectLinearOptions(db, null, SCRIPTED_TEAM.id);
    expect(options.projects.map((p) => p.name)).toEqual(['Web app', 'API', 'Mobile']);
    const saved = await saveProject(
      db,
      null,
      input({
        repoPath: second,
        scripts: 'test, lint',
        context: 'A web app for clinics. Dates are always in the clinic’s time zone.',
        maxRuns: 1,
        spendCapUsd: 0.0001,
        models: { 'spec-builder': 'claude-haiku-5-5', 'spec-review': '' },
      }),
    );
    web = saved.project;
    expect(saved.notes[0]).toContain('project Web app');
    expect(saved.notes[1]).toBe('Read back from GitHub: o/web, default branch main.');
    expect(web.linear.project).toEqual({ id: 'lp_web', name: 'Web app' });
    expect(web.linear.team).toEqual(SCRIPTED_TEAM);
    expect(web.github).toMatchObject({ repo: 'o/web', mergeMethod: 'squash', autoMerge: false });
    expect(web.scripts).toEqual(['test', 'lint']);
    // An empty pick means the agent's own model.
    expect(web.models).toEqual({ 'spec-builder': 'claude-haiku-5-5' });
    expect((await projectForge(db, web)).repo).toBe('o/web');
    expect((await projectForge(db, def)).repo).toBe('o/default');
    expect((await getLinearSettings(db)).lastCheckAt).toBeNull();

    // Saved again on the same Linear project, the check goes on from where it was.
    const at = new Date();
    await db.update(t.linearSettings).set({ lastCheckAt: at });
    await saveProject(
      db,
      web.id,
      input({
        repoPath: second,
        scripts: 'test, lint',
        maxRuns: 1,
        spendCapUsd: 0.0001,
        models: web.models,
        context: web.context,
      }),
    );
    expect((await getLinearSettings(db)).lastCheckAt).toEqual(at);

    // With two projects, a run or issue that names none has no project, so no Linear.
    const none = await linearOf(db);
    expect(none.project).toBeUndefined();
    expect(none.settings.team).toBeNull();
  });

  it('files a spec into its project’s Linear project, with the project’s context, model and folder', async () => {
    const seen: { model: string; system: string }[] = [];
    const client: ModelClient = {
      async create(p) {
        seen.push({ model: p.model, system: String(p.system) });
        return String(p.system).startsWith('You write the spec')
          ? text(SPEC)
          : text('Verdict: pass');
      },
    };
    // A cap of a hundredth of a cent: lift it for this run, then put it back.
    await db
      .update(t.factoryProjects)
      .set({ spendCapUsd: null })
      .where(eq(t.factoryProjects.id, web.id));
    const engine = new Engine({ client, getDb: async () => db });
    const preset = await templatePlan(db, 'spec', { projectId: web.id });
    const run = await createRun(
      db,
      { text: 'CSV export', attachments: [], template: 'spec', projectId: web.id },
      null,
      preset,
    );
    engine.enqueue(run.id);
    await engine.whenIdle();
    expect((await getRun(db, run.id))!.status).toBe('done');

    const builder = seen.find((s) => s.system.startsWith('You write the spec'))!;
    expect(builder.model).toBe('claude-haiku-5-5');
    expect(builder.system).toContain(
      'About the project you are working on:\nA web app for clinics.',
    );
    expect(seen.find((s) => !s.system.startsWith('You write the spec'))!.model).not.toBe(
      'claude-haiku-5-5',
    );

    const issue = (await issueForRun(db, run.id))!;
    expect(issue.projectId).toBe(web.id);
    expect(store.issues.find((i) => i.id === issue.externalId)!.projectId).toBe('lp_web');
  }, 20_000);

  it('the watcher gives each project the issues of its own Linear project, and no others', async () => {
    const tracker = scriptedTracker('k', store);
    const label = store.labels.find((l) => l.name === 'magpipe')!.id;
    const inWeb = await tracker.createIssue({
      teamId: SCRIPTED_TEAM.id,
      title: 'Labelled in Web app',
      description: '',
      labelIds: [label],
      stateId: 'st_spec',
      projectId: 'lp_web',
    });
    const inApi = await tracker.createIssue({
      teamId: SCRIPTED_TEAM.id,
      title: 'Labelled in API',
      description: '',
      labelIds: [label],
      stateId: 'st_spec',
      projectId: API.id,
    });
    const unclaimed = await tracker.createIssue({
      teamId: SCRIPTED_TEAM.id,
      title: 'Labelled in the team',
      description: '',
      labelIds: [label],
      stateId: 'st_spec',
    });
    const check = await checkLinear(db, { force: true });
    expect(check.status).toBe('done');
    const byExternal = async (id: string) =>
      (await db.select().from(t.trackerIssues).where(eq(t.trackerIssues.externalId, id)))[0];
    expect((await byExternal(inWeb.id))!.projectId).toBe(web.id);
    expect((await byExternal(inApi.id))!.projectId).toBe(def.id);
    // D46: the Default project no longer holds the whole team; an issue in no project's Linear
    // project belongs to none, and the watcher leaves it alone.
    expect(await byExternal(unclaimed.id)).toBeUndefined();
  });

  it('keeps builds to a project’s own limit', async () => {
    const tracker = scriptedTracker('k', store);
    const { settings } = await linearOf(db, web.id);
    const run = await createRun(db, { text: 'Goals', attachments: [] });
    const spec = await recordFiledIssue(
      db,
      await tracker.createIssue({
        teamId: SCRIPTED_TEAM.id,
        title: 'Spec',
        description: '',
        labelIds: [],
        stateId: 'st_progress',
      }),
      { runId: run.id, settings, projectId: web.id },
    );
    for (const key of ['a', 'b']) {
      await recordFiledIssue(
        db,
        await tracker.createIssue({
          teamId: SCRIPTED_TEAM.id,
          title: key,
          description: '',
          labelIds: [],
          stateId: 'st_todo',
        }),
        {
          runId: run.id,
          settings,
          parentId: spec.id,
          projectId: web.id,
          goal: { key, title: key, summary: key, criteria: [1], files: [], dependsOn: [] },
        },
      );
    }
    // The workspace allows two at once; Web app allows one.
    expect(await readyGoals(db)).toHaveLength(1);
    await db
      .update(t.factoryProjects)
      .set({ maxRuns: null })
      .where(eq(t.factoryProjects.id, web.id));
    expect(await readyGoals(db)).toHaveLength(2);
  });

  it('counts a project’s spend against its own cap', async () => {
    const own = await spendToday(db, new Date(), { id: web.id, spendCapUsd: 0.0001 });
    expect(own.capUsd).toBe(0.0001);
    expect(own.spentUsd).toBeGreaterThan(0);
    const other = await spendToday(db, new Date(), { id: def.id, spendCapUsd: 5 });
    expect(other.spentUsd).toBe(0);

    await db
      .update(t.factoryProjects)
      .set({ spendCapUsd: 0.0001 })
      .where(eq(t.factoryProjects.id, web.id));
    const engine = new Engine({
      client: { create: async () => text('never') },
      getDb: async () => db,
    });
    const preset = await templatePlan(db, 'spec', { projectId: web.id });
    const run = await createRun(
      db,
      { text: 'Another', attachments: [], template: 'spec', projectId: web.id },
      null,
      preset,
    );
    engine.enqueue(run.id);
    await engine.whenIdle();
    const done = (await getRun(db, run.id))!;
    expect(done.status).toBe('failed');
    const events = await listEvents(db, run.id);
    expect(events[events.length - 1]).toMatchObject({
      kind: 'error',
      payload: { code: 'spend_cap' },
    });
    expect(events[events.length - 1]!.text).toContain('Today’s spend on Web app');
  }, 20_000);

  it('a missing key is its own gap, not a missing Linear project', async () => {
    const shared = (await getLinearSettings(db)).keyRef;
    await db.update(t.linearSettings).set({ keyRef: null });
    try {
      const view = await projectView(db, web);
      expect(view.gaps).toEqual(['linear_key']);
      expect(view.linearReady).toBe(false);
    } finally {
      await db.update(t.linearSettings).set({ keyRef: shared });
    }
    expect((await projectView(db, web)).gaps).toEqual([]);
  });

  it('any change to the mapping makes the next check read every issue again', async () => {
    const at = new Date();
    await db.update(t.linearSettings).set({ lastCheckAt: at });
    // The same mapping: the check goes on from where it was.
    await saveProject(db, web.id, editOf(web));
    expect((await getLinearSettings(db)).lastCheckAt).toEqual(at);
    // Only the label changes, on the same Linear project: everything is read again.
    const relabelled = await saveProject(db, web.id, {
      ...editOf(web),
      linear: { ...editOf(web).linear, label: 'factory' },
    });
    expect(relabelled.project.linear.label?.name).toBe('factory');
    expect((await getLinearSettings(db)).lastCheckAt).toBeNull();
    await db.update(t.linearSettings).set({ lastCheckAt: at });
    // One status moves: the same.
    await saveProject(db, web.id, {
      ...editOf(web),
      linear: {
        ...editOf(web).linear,
        label: 'factory',
        states: { ...STATES, needs_you: 'st_backlog' },
      },
    });
    expect((await getLinearSettings(db)).lastCheckAt).toBeNull();
    web = (await saveProject(db, web.id, editOf(web))).project;
  });

  it('a new Linear project takes the project’s open issues along, so they are still watched', async () => {
    const remoteOf = async (title: string) => {
      const [row] = await db.select().from(t.trackerIssues).where(eq(t.trackerIssues.title, title));
      return store.issues.find((i) => i.id === row!.externalId)!;
    };
    expect((await remoteOf('Labelled in Web app')).projectId).toBe('lp_web');
    const { project, notes } = await saveProject(db, web.id, {
      ...editOf(web),
      linear: { ...editOf(web).linear, projectId: 'lp_mobile' },
    });
    expect(project.linear.project).toEqual({ id: 'lp_mobile', name: 'Mobile' });
    expect(notes.join(' ')).toMatch(
      /Moved MAG-\d+(, MAG-\d+)* into Mobile, so they are still watched\./,
    );
    expect((await remoteOf('Labelled in Web app')).projectId).toBe('lp_mobile');
    // The watcher reads Mobile now, and the issue is still Web app's.
    await checkLinear(db, { force: true });
    const [row] = await db
      .select()
      .from(t.trackerIssues)
      .where(eq(t.trackerIssues.title, 'Labelled in Web app'));
    expect(row!.projectId).toBe(web.id);
    web = project;
  });

  it('keeps a key of its own only once Linear accepts it, and deletes cleanly', async () => {
    await expect(setProjectKey(db, web.id, 'linear', 'lin_api_bad_one')).rejects.toThrow(
      'Linear did not accept the API key',
    );
    const { project, who } = await setProjectKey(db, web.id, 'linear', 'lin_api_web_own');
    expect(who).toBe('Scripted Operator');
    expect(project.linearKeyHint).toBe('_own');
    expect((await projectView(db, project)).hasLinearKey).toBe(true);
    expect((await projectLinear(db, project)).keyRef).toBe(project.linearKeyRef);
    const back = await setProjectKey(db, web.id, 'linear', null);
    expect(back.project.linearKeyRef).toBeNull();
    expect((await projectLinear(db, back.project)).keyRef).toBe(
      (await getLinearSettings(db)).keyRef,
    );

    // Work in flight keeps a project: it would be left with no repository or Linear (D46).
    await expect(deleteProject(db, web.id)).rejects.toMatchObject({
      message: expect.stringMatching(/^Web app still has \d+ open issues \(MAG-\d+/),
    });
    expect(await getProject(db, web.id)).toBeDefined();
    // Finished, it can go; its issues stay, without a project.
    await db
      .update(t.trackerIssues)
      .set({ stage: 'done', mergedAt: new Date() })
      .where(eq(t.trackerIssues.projectId, web.id));
    expect(await deleteProject(db, web.id)).toBe(true);
    expect(await getProject(db, web.id)).toBeUndefined();
    // The last project stays: the factory needs one to build in.
    await expect(deleteProject(db, def.id)).rejects.toThrow('This is the only project.');
    const left = await db
      .select()
      .from(t.trackerIssues)
      .where(eq(t.trackerIssues.title, 'Labelled in Web app'));
    expect(left[0]!.projectId).toBeNull();
  });
});

/**
 * Factory projects (D45) against the scripted tracker: the factory as it was is the Default
 * project, inheriting the workspace's Linear; a project with its own team and Linear project
 * files there and claims its issues; a spec run carries its project's folder, context, models
 * and spend cap; builds keep to a project's own limit.
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
import {
  deleteProject,
  ensureDefaultProject,
  getProject,
  linearOf,
  listProjects,
  projectLinearOptions,
  projectView,
  ProjectError,
  saveProject,
  setProjectKey,
} from '@/lib/projects';
import { listEvents } from '@/lib/engine/events';
import { createRun, getRun } from '@/lib/runs';
import type { FactoryProject, ProjectInput } from '@/lib/schemas';
import { spendToday } from '@/lib/spend';
import { saveLinearKey, saveLinearMapping, useTrackerFactory } from '@/lib/tracker';
import { checkLinear, getIssue, issueForRun, recordFiledIssue } from '@/lib/tracker/issues';
import { SCRIPTED_TEAM, scriptedStore, scriptedTracker } from '@/lib/tracker/scripted';

const SECRET = Buffer.from('unit-test-key-unit-test-key-0123').toString('base64url');

const STATES = {
  spec_ready: 'st_spec',
  approved: 'st_todo',
  building: 'st_progress',
  merge_question: 'st_review',
  done: 'st_done',
  needs_you: 'st_blocked',
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

function repo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e 0', lint: 'node -e 0' } }),
  );
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}

function input(over: Partial<ProjectInput> & Pick<ProjectInput, 'repoPath'>): ProjectInput {
  return {
    name: 'Web app',
    scripts: 'test',
    context: '',
    linear: { teamId: '', projectId: '', label: '', states: {} },
    github: {
      repo: '',
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

describe('factory projects', () => {
  let db: Db;
  let close: () => Promise<void>;
  let first: string;
  let second: string;
  const store = scriptedStore(true);
  const previous = process.env.MAGPIPE_SECRET_KEY;
  let def: FactoryProject;
  let web: FactoryProject;

  beforeAll(async () => {
    process.env.MAGPIPE_SECRET_KEY = SECRET;
    useTrackerFactory((key) => scriptedTracker(key, store));
    ({ db, close } = await openDb('memory://'));
    first = repo('magpipe-proj-a-');
    second = repo('magpipe-proj-b-');
    await loadFactory(db, { path: first, scripts: ['test'] });
    await saveLinearKey(db, 'lin_api_projects');
    await saveLinearMapping(db, { teamId: SCRIPTED_TEAM.id, label: 'magpipe', states: STATES });
  }, 30_000);
  afterAll(async () => {
    useTrackerFactory(undefined);
    await close();
    for (const d of [first, second]) fs.rmSync(d, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MAGPIPE_SECRET_KEY;
    else process.env.MAGPIPE_SECRET_KEY = previous;
  });

  it('makes the factory as it was the Default project, once, and gives it the orphan issues', async () => {
    // Loading the factory made it already.
    const loaded = await listProjects(db);
    expect(loaded.map((p) => p.name)).toEqual(['Default']);
    expect(await ensureDefaultProject(db)).toBeUndefined();

    // A factory from before projects: no project, and an issue without one.
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
    const { settings } = await linearOf(db);
    const orphan = await recordFiledIssue(db, remote, { runId: run.id, settings });
    expect(orphan.projectId).toBeNull();

    def = (await ensureDefaultProject(db))!;
    expect(def).toMatchObject({ name: 'Default', repoPath: fs.realpathSync(first) });
    expect(def.scripts).toEqual(['test']);
    expect(await ensureDefaultProject(db)).toBeUndefined();
    expect(await listProjects(db)).toHaveLength(1);
    expect((await getIssue(db, orphan.id))!.projectId).toBe(def.id);

    // It inherits the workspace's Linear: the same team, label and statuses.
    const view = await projectView(db, def);
    expect(view.effectiveLinear).toMatchObject({ team: SCRIPTED_TEAM, own: false });
    expect(view.linearReady).toBe(true);
    expect(view).not.toHaveProperty('linearKeyRef');
  });

  it('checks what a project names before saving it', async () => {
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
    await expect(
      saveProject(
        db,
        null,
        input({
          repoPath: second,
          github: { ...input({ repoPath: '' }).github, repo: 'not a repo' },
        }),
      ),
    ).rejects.toMatchObject({ field: 'github' });
    expect(await listProjects(db)).toHaveLength(1);
  });

  it('saves a project with its own Linear project, read back from Linear', async () => {
    const options = await projectLinearOptions(db, null, SCRIPTED_TEAM.id);
    expect(options.projects.map((p) => p.name)).toEqual(['Web app', 'API']);
    const saved = await saveProject(
      db,
      null,
      input({
        repoPath: second,
        scripts: 'test, lint',
        context: 'A web app for clinics. Dates are always in the clinic’s time zone.',
        linear: { teamId: SCRIPTED_TEAM.id, projectId: 'lp_web', label: 'magpipe', states: STATES },
        maxRuns: 1,
        spendCapUsd: 0.0001,
        models: { 'spec-builder': 'claude-haiku-5-5', 'spec-review': '' },
      }),
    );
    web = saved.project;
    expect(saved.notes[0]).toContain('project Web app');
    expect(web.linear.project).toEqual({ id: 'lp_web', name: 'Web app' });
    expect(web.scripts).toEqual(['test', 'lint']);
    // An empty pick means the agent's own model.
    expect(web.models).toEqual({ 'spec-builder': 'claude-haiku-5-5' });
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

  it('the watcher gives each project its own issues', async () => {
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
    const elsewhere = await tracker.createIssue({
      teamId: SCRIPTED_TEAM.id,
      title: 'Labelled in the team',
      description: '',
      labelIds: [label],
      stateId: 'st_spec',
    });
    const check = await checkLinear(db, { force: true });
    expect(check.status).toBe('done');
    const byExternal = async (id: string) =>
      (await db.select().from(t.trackerIssues).where(eq(t.trackerIssues.externalId, id)))[0]!;
    expect((await byExternal(inWeb.id)).projectId).toBe(web.id);
    // The Default project inherits the whole team, so it holds what no other project claims.
    expect((await byExternal(elsewhere.id)).projectId).toBe(def.id);
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

  it('keeps a key of its own only once Linear accepts it, and deletes cleanly', async () => {
    await expect(setProjectKey(db, web.id, 'linear', 'lin_api_bad_one')).rejects.toThrow(
      'Linear did not accept the API key',
    );
    const { project, who } = await setProjectKey(db, web.id, 'linear', 'lin_api_web_own');
    expect(who).toBe('Scripted Operator');
    expect(project.linearKeyHint).toBe('_own');
    expect((await projectView(db, project)).hasLinearKey).toBe(true);
    const back = await setProjectKey(db, web.id, 'linear', null);
    expect(back.project.linearKeyRef).toBeNull();

    expect(await deleteProject(db, web.id)).toBe(true);
    expect(await getProject(db, web.id)).toBeUndefined();
    const left = await db
      .select()
      .from(t.trackerIssues)
      .where(eq(t.trackerIssues.title, 'Labelled in Web app'));
    expect(left[0]!.projectId).toBeNull();
  });
});

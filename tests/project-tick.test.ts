/**
 * The factory tick and the watcher with projects that are not all set up (D46): a project with no
 * Linear project is left alone without stopping any other project's work, and the watcher says
 * why nothing in Linear is watched while it still runs the factory's other work.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { factoryTick, loadFactory } from '@/lib/factory';
import { newId } from '@/lib/ids';
import { linearOf, listProjects } from '@/lib/projects';
import { createRun } from '@/lib/runs';
import type { FactoryProject, Goal, TrackerIssue } from '@/lib/schemas';
import { getLinearSettings, saveLinearKey, useTrackerFactory } from '@/lib/tracker';
import { checkLinear, getIssue, recordFiledIssue } from '@/lib/tracker/issues';
import { SCRIPTED_TEAM, scriptedStore, scriptedTracker } from '@/lib/tracker/scripted';
import { setUpProject, TEST_LINEAR_PROJECT } from './stubs/project';

const SECRET = Buffer.from('unit-test-key-unit-test-key-0123').toString('base64url');

const goal = (key: string): Goal => ({
  key,
  title: `Goal ${key}`,
  summary: `Build ${key}.`,
  criteria: [1],
  files: [`src/${key}.ts`],
  dependsOn: [],
});

describe('projects not all set up', () => {
  let db: Db;
  let close: () => Promise<void>;
  let dir: string;
  const store = scriptedStore(true);
  const previous = process.env.MAGPIPE_SECRET_KEY;
  let def: FactoryProject;
  let bare: FactoryProject;

  /** An approved goal of `project` whose build ended without reporting. */
  async function endedBuild(project: FactoryProject, key: string): Promise<TrackerIssue> {
    const tracker = scriptedTracker('k', store);
    const run = await createRun(db, { text: `Build ${key}`, attachments: [] });
    await db
      .update(t.runs)
      .set({ status: 'failed', finishedAt: new Date() })
      .where(eq(t.runs.id, run.id));
    // A goal is always filed under its spec (D39).
    const spec = await tracker.createIssue({
      teamId: SCRIPTED_TEAM.id,
      title: `Spec for ${key}`,
      description: '',
      labelIds: [],
      stateId: 'st_progress',
      projectId: TEST_LINEAR_PROJECT.id,
    });
    const remote = await tracker.createIssue({
      parentId: spec.id,
      teamId: SCRIPTED_TEAM.id,
      title: `Goal ${key}`,
      description: '',
      labelIds: [],
      stateId: 'st_todo',
      projectId: TEST_LINEAR_PROJECT.id,
    });
    const { settings } = await linearOf(db, project.id);
    const issue = await recordFiledIssue(db, remote, {
      runId: run.id,
      settings,
      goal: goal(key),
      projectId: project.id,
    });
    await db
      .update(t.trackerIssues)
      .set({ stage: 'approved', buildRunId: run.id })
      .where(eq(t.trackerIssues.id, issue.id));
    return (await getIssue(db, issue.id))!;
  }

  beforeAll(async () => {
    process.env.MAGPIPE_SECRET_KEY = SECRET;
    useTrackerFactory((key) => scriptedTracker(key, store));
    ({ db, close } = await openDb('memory://'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-tick-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e 0' } }),
    );
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await loadFactory(db, { path: dir, scripts: ['test'] });
    await saveLinearKey(db, 'lin_api_tick');
    def = await setUpProject(db);
    // A second project made before it had its Linear project: written as D45 left it.
    const now = new Date();
    bare = {
      ...def,
      id: newId('proj'),
      name: 'Bare',
      linear: { ...def.linear, project: null },
      github: { ...def.github, repo: null },
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(t.factoryProjects).values(bare);
  }, 30_000);
  afterAll(async () => {
    useTrackerFactory(undefined);
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MAGPIPE_SECRET_KEY;
    else process.env.MAGPIPE_SECRET_KEY = previous;
  });

  it('leaves a goal of a project with no Linear alone, and still reconciles the others', async () => {
    const ready = await endedBuild(def, 'ready');
    const waiting = await endedBuild(bare, 'waiting');
    const { problems } = await factoryTick(db, () => undefined);
    expect(problems).toEqual([]);
    // The set-up project's goal moved to needs you, as before (D40).
    const moved = (await getIssue(db, ready.id))!;
    expect(moved.stage).toBe('needs_you');
    expect(moved.buildRunId).toBeNull();
    // The other waits, untouched, until its project has its Linear project.
    const kept = (await getIssue(db, waiting.id))!;
    expect(kept.stage).toBe('approved');
    expect(kept.buildRunId).toBe(waiting.buildRunId);
  });

  it('with no project ready in Linear, the watcher says so and the factory’s other work goes on', async () => {
    await db
      .update(t.factoryProjects)
      .set({ linear: { ...def.linear, project: null } })
      .where(eq(t.factoryProjects.id, def.id));
    const before = await getLinearSettings(db);
    let ran = 0;
    const check = await checkLinear(db, {
      force: true,
      afterCheck: async () => {
        ran++;
        return { started: [], problems: [] };
      },
    });
    expect(check).toEqual({ status: 'skipped', reason: 'not_ready' });
    expect(ran).toBe(1);
    const after = await getLinearSettings(db);
    expect(after.lastError).toMatch(/^No project has its Linear project and a key yet/);
    // Nothing was read, so the last good check stays where it was.
    expect(after.lastCheckAt).toEqual(before.lastCheckAt);
  });

  it('with no project at all, the workspace’s old mapping is not watched; without a key, nothing is said', async () => {
    // The workspace row still holds a team, as before projects; it is not used (D46).
    await db.update(t.linearSettings).set({ team: SCRIPTED_TEAM, lastError: null });
    await db.delete(t.factoryProjects);
    expect(await listProjects(db)).toHaveLength(0);
    const known = (await db.select().from(t.trackerIssues)).length;
    expect(await checkLinear(db, { force: true })).toEqual({
      status: 'skipped',
      reason: 'not_ready',
    });
    expect((await getLinearSettings(db)).lastError).toBe(
      'There is no factory project yet, so nothing in Linear is watched.',
    );
    expect(await db.select().from(t.trackerIssues)).toHaveLength(known);

    // No key and no project: Linear was never set up, so the check is quiet.
    await db.update(t.linearSettings).set({ keyRef: null, lastError: null });
    expect((await checkLinear(db, { force: true })).status).toBe('skipped');
    expect((await getLinearSettings(db)).lastError).toBeNull();
  });
});

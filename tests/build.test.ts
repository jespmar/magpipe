/**
 * Building one goal (D40) against the scripted tracker: the factory picks the goal whose turn it
 * is, one build at a time in dependency order; the build template writes the tests first, builds,
 * runs, reviews and tries to break it on the goal's branch; judges send work back to the build
 * only; the finish reports on the issue however the run went; a spec closes when its goals are
 * done.
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
import type { ModelClient, ModelMessage, ModelParams } from '@/lib/engine/model';
import { factoryTick, loadFactory, nextGoal, startBuildRun } from '@/lib/factory';
import { createRun, getRun } from '@/lib/runs';
import { sendBackSet } from '@/lib/runs-util';
import type { Goal, Step, TrackerIssue } from '@/lib/schemas';
import {
  getLinearSettings,
  saveLinearKey,
  saveLinearMapping,
  useTrackerFactory,
} from '@/lib/tracker';
import { checkLinear, getIssue, recordFiledIssue } from '@/lib/tracker/issues';
import { SCRIPTED_TEAM, scriptedStore, scriptedTracker } from '@/lib/tracker/scripted';

const SECRET = Buffer.from('unit-test-key-unit-test-key-0123').toString('base64url');

function message(content: ModelMessage['content'], stop = 'end_turn'): ModelMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: stop,
    stop_sequence: null,
    content,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as ModelMessage;
}
const text = (s: string) => message([{ type: 'text', text: s, citations: null }]);
const sendBack = (findings: string) =>
  message([{ type: 'tool_use', id: 'tu_sb', name: 'send_back', input: { findings } }], 'tool_use');
const sawResult = (p: ModelParams) =>
  p.messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((b) => (b as { type: string }).type === 'tool_result'),
  );
const userOf = (p: ModelParams) => JSON.stringify(p.messages[0]!.content);

type Calls = Record<'tests' | 'build' | 'run' | 'review' | 'skeptic', string[]>;

/** The build's agents, scripted. `review` may send back once; `run`, `review` and `skeptic` give verdicts. */
function buildModel(opts: {
  run?: string;
  review?: string;
  reviewSendsBack?: boolean;
  skeptic?: string;
  buildThrows?: boolean;
  calls: Calls;
}): ModelClient {
  return {
    async create(p) {
      const system = String(p.system);
      const user = userOf(p);
      if (system.startsWith('You write the tests for one goal')) {
        if (user.includes('Your step is to run the tests')) {
          opts.calls.run.push(user);
          return text(opts.run ?? 'Verdict: pass\n\nRuns: test exited 0.');
        }
        opts.calls.tests.push(user);
        return text('Wrote and committed the failing tests.');
      }
      if (system.startsWith('You build one goal')) {
        opts.calls.build.push(user);
        if (opts.buildThrows) throw new Error('The code agent fell over.');
        return text('Built it; the tests pass.');
      }
      if (system.startsWith('You review the code built for one goal')) {
        opts.calls.review.push(user);
        // Round 1 sends the build back and says fail; round 2 (with its own findings) passes.
        if (opts.reviewSendsBack && !user.includes('Your findings last round')) {
          return sawResult(p)
            ? text('Verdict: fail')
            : sendBack('Blocking: src/a.ts:3 drops the header.');
        }
        return text(opts.review ?? 'Verdict: pass');
      }
      if (system.startsWith('You try to break the code')) {
        opts.calls.skeptic.push(user);
        return text(opts.skeptic ?? 'Verdict: pass\n\nWhat I tried: empty input.');
      }
      return text('Answered.');
    },
  };
}

const freshCalls = (): Calls => ({ tests: [], build: [], run: [], review: [], skeptic: [] });

describe('sendBackSet with targets', () => {
  it('reopens the targets and what lies between them and the judge, never the tests', () => {
    const plan = [
      { id: 'read', dependsOn: [] },
      { id: 'tests', dependsOn: ['read'] },
      { id: 'build', dependsOn: ['read', 'tests'] },
      { id: 'run', dependsOn: ['build'], sendBackTo: ['build'] },
      { id: 'review', dependsOn: ['read', 'build', 'run'], sendBackTo: ['build'] },
      { id: 'skeptic', dependsOn: ['read', 'build', 'run', 'review'], sendBackTo: ['build'] },
    ];
    expect([...sendBackSet(plan, 'run')].sort()).toEqual(['build', 'run']);
    expect([...sendBackSet(plan, 'review')].sort()).toEqual(['build', 'review', 'run']);
    expect([...sendBackSet(plan, 'skeptic')].sort()).toEqual(['build', 'review', 'run', 'skeptic']);
    // Without targets the old rule holds: everything it reviews, the tests included.
    expect(
      [
        ...sendBackSet(
          plan.map(({ sendBackTo: _s, ...s }) => s),
          'review',
        ),
      ].sort(),
    ).toContain('tests');
  });
});

describe('building one goal', () => {
  let db: Db;
  let close: () => Promise<void>;
  let dir: string;
  const store = scriptedStore(true);
  const previous = process.env.MAGPIPE_SECRET_KEY;
  let spec: TrackerIssue;
  const goals: Record<string, TrackerIssue> = {};

  const goal = (key: string, dependsOn: string[] = []): Goal => ({
    key,
    title: `Goal ${key}`,
    summary: `Build ${key}.`,
    criteria: [1],
    files: [`src/${key}.ts`],
    dependsOn,
  });

  /** A spec in building and its goals in approved, as the goals run leaves them. */
  async function fileGoals(keys: [string, string[]][]) {
    const settings = await getLinearSettings(db);
    const tracker = scriptedTracker('k', store);
    const run = await createRun(db, { text: 'Goals', attachments: [] });
    const remoteSpec = await tracker.createIssue({
      teamId: SCRIPTED_TEAM.id,
      title: 'Export runs as CSV',
      description: '# Export',
      labelIds: [store.labels[0]!.id],
      stateId: 'st_progress',
    });
    spec = await recordFiledIssue(db, remoteSpec, { runId: run.id, settings });
    for (const [key, deps] of keys) {
      const remote = await tracker.createIssue({
        teamId: SCRIPTED_TEAM.id,
        title: `Goal ${key}`,
        description: `Goal \`${key}\`.\n\n## Acceptance criteria\n\n1. It works (a test).`,
        labelIds: [store.labels[0]!.id],
        stateId: 'st_todo',
        parentId: remoteSpec.id,
      });
      goals[key] = await recordFiledIssue(db, remote, {
        runId: run.id,
        settings,
        parentId: spec.id,
        goal: goal(key, deps),
      });
      // Distinct creation times, so the oldest goal is the first filed.
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  const remoteOf = (issue: TrackerIssue) => store.issues.find((i) => i.id === issue.externalId)!;

  beforeAll(async () => {
    process.env.MAGPIPE_SECRET_KEY = SECRET;
    useTrackerFactory((key) => scriptedTracker(key, store));
    ({ db, close } = await openDb('memory://'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-build-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e 0' } }),
    );
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await loadFactory(db, { path: dir, scripts: ['test'] });
    await saveLinearKey(db, 'lin_api_build');
    await saveLinearMapping(db, {
      teamId: SCRIPTED_TEAM.id,
      label: 'magpipe',
      states: {
        spec_ready: 'st_spec',
        approved: 'st_todo',
        building: 'st_progress',
        merge_question: 'st_review',
        done: 'st_done',
        needs_you: 'st_blocked',
      },
    });
    await fileGoals([
      ['header', []],
      ['filters', ['header']],
      ['button', []],
    ]);
  }, 30_000);
  afterAll(async () => {
    useTrackerFactory(undefined);
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MAGPIPE_SECRET_KEY;
    else process.env.MAGPIPE_SECRET_KEY = previous;
  });

  it('picks the oldest goal with its dependencies done, one build at a time', async () => {
    expect((await nextGoal(db))!.id).toBe(goals.header!.id);
    const run = (await startBuildRun(db, goals.header!, () => undefined))!;
    expect(run.input).toMatchObject({ template: 'build', issueId: goals.header!.id });
    expect(run.plan.find((s) => s.id === 'tests')!.instructions).toContain(
      "The goal's branch is magpipe/header",
    );
    // While that build is queued, nothing else starts.
    expect(await nextGoal(db)).toBeNull();
    expect(await startBuildRun(db, goals.header!, () => undefined)).toBeNull();
    // Hand it back for the next test: cancelled and released, as a reconcile would.
    await db.update(t.runs).set({ status: 'cancelled' }).where(eq(t.runs.id, run.id));
    await db
      .update(t.trackerIssues)
      .set({ buildRunId: null })
      .where(eq(t.trackerIssues.id, goals.header!.id));
  });

  it('builds a goal: tests first, a review that sends the build back once, then ready to merge', async () => {
    const calls = freshCalls();
    const engine = new Engine({
      client: buildModel({ reviewSendsBack: true, calls }),
      getDb: async () => db,
    });
    const run = (await startBuildRun(db, goals.header!, (id) => engine.enqueue(id)))!;
    await engine.whenIdle();
    const done = (await getRun(db, run.id))!;
    expect(done.status).toBe('done');
    const step = (id: string) => done.plan.find((s) => s.id === id) as Step;

    // The tests were written once; the build and the run went twice; the review twice.
    expect(calls.tests).toHaveLength(1);
    expect(calls.build).toHaveLength(2);
    expect(calls.run).toHaveLength(2);
    // Round 1 is two model calls (send_back, then the verdict); round 2 is one.
    expect(calls.review).toHaveLength(3);
    expect(step('tests').round).toBeUndefined();
    expect(step('build').round).toBe(2);
    expect(calls.build[1]).toContain('Code Review sent the work back after round 1');
    expect(calls.tests[0]).toContain('It works (a test).');
    expect(calls.review[0]).toContain('Document written by \\"Read the goal\\"');
    for (const id of ['run', 'review', 'skeptic']) expect(step(id).verdict).toBe('pass');

    expect(step('finish')).toMatchObject({ status: 'done', always: true });
    expect(step('finish').result!.summary).toBe(
      `${goals.header!.identifier} is ready to merge on magpipe/header. Moved to In Review.`,
    );
    // The answer leads with the report; the goal read from Linear comes last, for reference.
    expect(done.output!.markdown).toMatch(/^## Report on the goal\n\nMagpipe: MAG-\d+ is ready/);
    expect(done.output!.markdown).toMatch(/## Read the goal\n\nGoal `header`\.[\s\S]*$/);
    const remote = remoteOf(goals.header!);
    expect(remote.state.id).toBe('st_review');
    expect(remote.comments.at(-1)).toMatch(/^Ready to merge: branch `magpipe\/header`/);
    expect(await getIssue(db, goals.header!.id)).toMatchObject({
      stage: 'merge_question',
      buildRunId: run.id,
    });
  }, 30_000);

  it('waits for a dependency to be done; an independent goal goes first', async () => {
    expect((await nextGoal(db))!.id).toBe(goals.button!.id);
  });

  it('a failing test run skips the review and the skeptic, and the goal needs you', async () => {
    const calls = freshCalls();
    const engine = new Engine({
      client: buildModel({ run: 'Verdict: fail\n\nRuns: test exited 1.', calls }),
      getDb: async () => db,
    });
    const run = (await startBuildRun(db, goals.button!, (id) => engine.enqueue(id)))!;
    await engine.whenIdle();
    const done = (await getRun(db, run.id))!;
    expect(done.status).toBe('done');
    expect(calls.review).toHaveLength(0);
    expect(calls.skeptic).toHaveLength(0);
    expect(done.plan.find((s) => s.id === 'review')!.status).toBe('skipped');
    const finish = done.plan.find((s) => s.id === 'finish')!;
    expect(finish.result!.summary).toContain('“Run the tests” said fail');
    expect(remoteOf(goals.button!).state.id).toBe('st_blocked');
    expect(remoteOf(goals.button!).comments.at(-1)).toContain('move this issue back to Approved');
    expect(await getIssue(db, goals.button!.id)).toMatchObject({
      stage: 'needs_you',
      buildRunId: null,
    });
  }, 30_000);

  it('a failed step is still reported: the finish runs after it, and the run fails', async () => {
    scriptedTracker('k', store).move(goals.button!.identifier, 'Approved');
    await checkLinear(db, { force: true });
    const calls = freshCalls();
    const engine = new Engine({
      client: buildModel({ buildThrows: true, calls }),
      getDb: async () => db,
    });
    const run = (await startBuildRun(db, goals.button!, (id) => engine.enqueue(id)))!;
    await engine.whenIdle();
    const done = (await getRun(db, run.id))!;
    expect(done.status).toBe('failed');
    expect(done.plan.find((s) => s.id === 'build')!.status).toBe('failed');
    expect(done.plan.find((s) => s.id === 'run')!.status).toBe('skipped');
    expect(done.plan.find((s) => s.id === 'finish')!.result!.summary).toContain(
      '“Build the goal” failed',
    );
    expect(await getIssue(db, goals.button!.id)).toMatchObject({
      stage: 'needs_you',
      buildRunId: null,
    });
  }, 30_000);

  it('a cancelled build is reconciled at the next check', async () => {
    scriptedTracker('k', store).move(goals.button!.identifier, 'Approved');
    await checkLinear(db, { force: true });
    const run = (await startBuildRun(db, goals.button!, () => undefined))!;
    await db.update(t.runs).set({ status: 'cancelled' }).where(eq(t.runs.id, run.id));
    const result = await checkLinear(db, {
      force: true,
      afterCheck: (d) => factoryTick(d, () => undefined),
    });
    expect(result).toMatchObject({ status: 'done' });
    expect(await getIssue(db, goals.button!.id)).toMatchObject({
      stage: 'needs_you',
      buildRunId: null,
    });
    expect(remoteOf(goals.button!).comments.at(-1)).toContain(`${run.displayId} was cancelled`);
  });

  it('a dependency moved to done lets the next goal start; the spec closes when all are done', async () => {
    scriptedTracker('k', store).move(goals.header!.identifier, 'Done');
    const started: string[] = [];
    await checkLinear(db, {
      force: true,
      afterCheck: async (d) => {
        const r = await factoryTick(d, () => undefined);
        started.push(...r.started);
        return r;
      },
    });
    expect(started).toEqual([
      expect.stringMatching(new RegExp(`^${goals.filters!.identifier} → `)),
    ]);

    for (const key of ['filters', 'button']) {
      scriptedTracker('k', store).move(goals[key]!.identifier, 'Done');
    }
    await db.update(t.runs).set({ status: 'done' }).where(eq(t.runs.status, 'queued'));
    await checkLinear(db, { force: true, afterCheck: (d) => factoryTick(d, () => undefined) });
    expect(await getIssue(db, spec.id)).toMatchObject({ stage: 'done' });
    expect(remoteOf(spec).comments.at(-1)).toContain('Every goal is done');
  });
});

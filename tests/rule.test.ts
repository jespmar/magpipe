/**
 * Unattended merges (D44): the operator's rule as a verdict, and the rule at work in the tick on a
 * real repository with a bare origin, against the scripted tracker and forge. Off by default; the
 * label, a first-pass build and green checks must all hold; checks still running mean wait; a yes
 * from the rule still lands the usual way.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import { Engine } from '@/lib/engine';
import type { ModelClient, ModelMessage } from '@/lib/engine/model';
import { factoryTick, loadFactory, ruleVerdict, startBuildRun } from '@/lib/factory';
import {
  getForgeSettings,
  saveAutoMerge,
  saveForgeKey,
  saveForgeRepo,
  useForgeFactory,
} from '@/lib/forge';
import { scriptedForge, scriptedForgeStore } from '@/lib/forge/scripted';
import { createRun } from '@/lib/runs';
import type { Goal, Step, TrackerIssue } from '@/lib/schemas';
import {
  getLinearSettings,
  saveLinearKey,
  saveLinearMapping,
  useTrackerFactory,
} from '@/lib/tracker';
import { checkLinear, getIssue, recordFiledIssue } from '@/lib/tracker/issues';
import {
  addScriptedLabel,
  SCRIPTED_TEAM,
  scriptedStore,
  scriptedTracker,
} from '@/lib/tracker/scripted';

const RULE = {
  autoMerge: true,
  autoMergeLabel: 'auto-merge',
  autoMergeFirstPass: true,
  autoMergeChecks: true,
};
const judge = (title: string, extra: Partial<Step> = {}): Step => ({
  id: title,
  agentId: null,
  title,
  dependsOn: [],
  status: 'done',
  judges: true,
  verdict: 'pass',
  ...extra,
});
const firstPass = {
  plan: [judge('Run the tests'), judge('Review the code'), judge('Try to break it')],
};

describe('the rule as a verdict', () => {
  it('holds when every condition holds, and says why', () => {
    expect(
      ruleVerdict({ rule: RULE, labels: ['Auto-Merge'], build: firstPass, checks: 'success' }),
    ).toEqual({
      holds: true,
      reasons: [
        'it carries auto-merge',
        'every judge passed on the first try',
        'its checks are green',
      ],
    });
  });

  it('is off until the operator turns it on', () => {
    expect(
      ruleVerdict({
        rule: { ...RULE, autoMerge: false },
        labels: ['auto-merge'],
        build: firstPass,
        checks: 'success',
      }),
    ).toMatchObject({ holds: false, reasons: ['the rule is off'] });
  });

  it('names each condition that does not hold', () => {
    const sentBack = { plan: [judge('Run the tests'), judge('Review the code', { round: 2 })] };
    expect(ruleVerdict({ rule: RULE, labels: [], build: sentBack, checks: 'failure' })).toEqual({
      holds: false,
      waiting: false,
      reasons: [
        'neither the goal nor its spec carries auto-merge',
        'a judge sent the work back',
        'its checks failed',
      ],
    });
    expect(
      ruleVerdict({
        rule: RULE,
        labels: ['auto-merge'],
        build: { plan: [judge('Run the tests', { verdict: 'fail' })] },
        checks: 'success',
      }),
    ).toMatchObject({ holds: false, reasons: ['its build’s judges did not all pass'] });
    expect(
      ruleVerdict({ rule: RULE, labels: ['auto-merge'], build: firstPass, checks: 'none' }),
    ).toMatchObject({
      holds: false,
      reasons: ['its pull request has no checks to read'],
    });
  });

  it('waits while the checks are still running, and only then', () => {
    expect(
      ruleVerdict({ rule: RULE, labels: ['auto-merge'], build: firstPass, checks: 'pending' }),
    ).toEqual({
      holds: false,
      waiting: true,
      reasons: ['its checks are still running'],
    });
    expect(
      ruleVerdict({ rule: RULE, labels: [], build: firstPass, checks: 'pending' }),
    ).toMatchObject({
      holds: false,
      waiting: false,
    });
  });

  it('lets the operator drop the first-pass and checks conditions', () => {
    const sentBack = { plan: [judge('Run the tests', { round: 2 })] };
    expect(
      ruleVerdict({
        rule: { ...RULE, autoMergeFirstPass: false, autoMergeChecks: false },
        labels: ['auto-merge'],
        build: sentBack,
        checks: 'none',
      }),
    ).toEqual({ holds: true, reasons: ['it carries auto-merge', 'every judge passed'] });
  });
});

// ─── the rule at work ──────────────────────────────────────────────────────

const SECRET = Buffer.from('unit-test-key-unit-test-key-0123').toString('base64url');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

function message(text: string): ModelMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text, citations: null }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as ModelMessage;
}
const passing: ModelClient = {
  async create(p) {
    return message(String(p.system).includes('"Verdict: pass"') ? 'Verdict: pass' : 'Done.');
  },
};

describe('unattended merges in the tick', () => {
  let db: Db;
  let close: () => Promise<void>;
  let dir: string;
  const store = scriptedStore(true);
  const forgeStore = scriptedForgeStore(true);
  const previous = { key: process.env.MAGPIPE_SECRET_KEY, data: process.env.MAGPIPE_DATA_DIR };
  let spec: TrackerIssue;

  async function goalAtQuestion(key: string): Promise<TrackerIssue> {
    const settings = await getLinearSettings(db);
    const remote = await scriptedTracker('k', store).createIssue({
      teamId: SCRIPTED_TEAM.id,
      title: `Goal ${key}`,
      description: `Goal \`${key}\`.`,
      labelIds: [store.labels[0]!.id],
      stateId: 'st_todo',
      parentId: spec.externalId,
    });
    const goal: Goal = {
      key,
      title: `Goal ${key}`,
      summary: 'x',
      criteria: [1],
      files: [`src/${key}.ts`],
      dependsOn: [],
    };
    const issue = await recordFiledIssue(db, remote, {
      runId: spec.runId!,
      settings,
      parentId: spec.id,
      goal,
    });
    const engine = new Engine({ client: passing, getDb: async () => db });
    const run = (await startBuildRun(db, issue, (id) => engine.enqueue(id)))!;
    const wt = run.input.worktree!.path;
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'src', `${key}.ts`), 'export {};\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', key);
    await engine.whenIdle();
    const after = (await getIssue(db, issue.id))!;
    expect(after.stage).toBe('merge_question');
    return after;
  }

  async function tick() {
    const engine = new Engine({ client: passing, getDb: async () => db });
    await checkLinear(db, {
      force: true,
      afterCheck: (d) => factoryTick(d, (id) => engine.enqueue(id)),
    });
    await engine.whenIdle();
  }

  beforeAll(async () => {
    process.env.MAGPIPE_SECRET_KEY = SECRET;
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-rule-')));
    process.env.MAGPIPE_DATA_DIR = path.join(dir, '.data');
    const origin = path.join(dir, 'origin.git');
    const repo = path.join(dir, 'app');
    fs.mkdirSync(repo);
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e 0' } }),
    );
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    useTrackerFactory((key) => scriptedTracker(key, store));
    useForgeFactory((token) => scriptedForge(token, forgeStore));
    ({ db, close } = await openDb('memory://'));
    await loadFactory(db, { path: repo, scripts: ['test'] });
    await saveLinearKey(db, 'lin_api_rule');
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
    await saveForgeKey(db, 'ghp_rule');
    await saveForgeRepo(db, { repo: 'o/app', mergeMethod: 'squash' });
    const settings = await getLinearSettings(db);
    const run = await createRun(db, { text: 'Goals', attachments: [] });
    spec = await recordFiledIssue(
      db,
      await scriptedTracker('k', store).createIssue({
        teamId: SCRIPTED_TEAM.id,
        title: 'Spec',
        description: '# Spec',
        labelIds: [store.labels[0]!.id],
        stateId: 'st_progress',
      }),
      { runId: run.id, settings },
    );
  }, 30_000);
  afterAll(async () => {
    useTrackerFactory(undefined);
    useForgeFactory(undefined);
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [
      ['MAGPIPE_SECRET_KEY', previous.key],
      ['MAGPIPE_DATA_DIR', previous.data],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is off by default: a labelled goal still waits for the operator', async () => {
    expect((await getForgeSettings(db)).autoMerge).toBe(false);
    const a = await goalAtQuestion('a');
    addScriptedLabel(store, a.identifier, 'auto-merge');
    await tick();
    expect(await getIssue(db, a.id)).toMatchObject({
      stage: 'merge_question',
      mergeRequestedAt: null,
    });
  }, 30_000);

  it('turned on, it merges the labelled goal, says why, and leaves the unlabelled one', async () => {
    await saveAutoMerge(db, RULE);
    const b = await goalAtQuestion('b');
    const [a] = (await Promise.all([getIssue(db, (await goalIssue('a')).id)])) as TrackerIssue[];
    await tick();
    const after = (await getIssue(db, a!.id))!;
    expect(after).toMatchObject({ mergeRequestedVia: 'rule', stage: 'done' });
    expect(after.mergedAt).toBeInstanceOf(Date);
    const comments = store.issues.find((i) => i.id === a!.externalId)!.comments;
    expect(
      comments.some((c) =>
        c.startsWith(
          'The question to merge answered itself under your rule: it carries auto-merge, every judge passed on the first try, its checks are green.',
        ),
      ),
    ).toBe(true);
    expect(await getIssue(db, b.id)).toMatchObject({
      stage: 'merge_question',
      mergeRequestedAt: null,
    });
  }, 30_000);

  it('a label on the spec covers its goals; checks still running mean wait', async () => {
    addScriptedLabel(store, spec.identifier, 'auto-merge');
    forgeStore.checks = 'pending';
    const [b] = [await goalIssue('b')];
    await tick();
    expect(await getIssue(db, b.id)).toMatchObject({
      stage: 'merge_question',
      mergeRequestedAt: null,
    });
    forgeStore.checks = 'success';
    await tick();
    expect(await getIssue(db, b.id)).toMatchObject({ mergeRequestedVia: 'rule', stage: 'done' });
  }, 30_000);

  async function goalIssue(key: string): Promise<TrackerIssue> {
    const all = await import('@/lib/tracker/issues').then((m) => m.listIssues(db));
    return all.find((i) => i.goal?.key === key)!;
  }
});

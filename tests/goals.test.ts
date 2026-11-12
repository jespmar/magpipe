/**
 * Goals (D39): Magpipe's checks on a split, and the goals template end to end against the
 * scripted tracker. Approval from either door starts the goals run once; it reads the spec as the
 * operator left it in Linear; the Goal Builder records goals through `record_goals` until they
 * pass the checks; a passing review files them as sub-issues blocked by their dependencies and
 * moves the spec to building; a failing one moves the spec to needs you and lets it start again.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import { Engine } from '@/lib/engine';
import type { ModelClient, ModelMessage, ModelParams } from '@/lib/engine/model';
import { factoryTick, loadFactory, startGoalsRun, templatePlan } from '@/lib/factory';
import { acceptanceCriteria, checkGoals, parallelGroups, renderGoals } from '@/lib/goals';
import { createRun, getRun } from '@/lib/runs';
import type { Goal, TrackerIssue } from '@/lib/schemas';
import { saveLinearKey, useTrackerFactory } from '@/lib/tracker';
import {
  approveIssue,
  checkLinear,
  getIssue,
  goalIssues,
  issueForRun,
  listIssues,
} from '@/lib/tracker/issues';
import { SCRIPTED_TEAM, scriptedStore, scriptedTracker } from '@/lib/tracker/scripted';
import { setUpProject, TEST_LINEAR_PROJECT } from '@/tests/stubs/project';

const goal = (
  key: string,
  criteria: number[],
  files: string[],
  dependsOn: string[] = [],
): Goal => ({
  key,
  title: `Goal ${key}`,
  summary: `Build ${key}.`,
  criteria,
  files,
  dependsOn,
});

// ─── the checks ────────────────────────────────────────────────────────────

describe('acceptanceCriteria', () => {
  it('reads the numbered items under the heading, continuation lines included', () => {
    const spec = [
      '# Export',
      '## Problem',
      '1. Not a criterion.',
      '## Acceptance criteria',
      '',
      '1. The export has a header row (a test).',
      '2) Filters apply to the export,',
      '   checked by an e2e test.',
      '- a bullet that is not numbered',
      '## Not in scope',
      '3. Not a criterion either.',
    ].join('\n');
    expect(acceptanceCriteria(spec)).toEqual([
      { n: 1, text: 'The export has a header row (a test).' },
      { n: 2, text: 'Filters apply to the export, checked by an e2e test.' },
    ]);
    expect(acceptanceCriteria('# No such section')).toEqual([]);
  });
});

describe('checkGoals', () => {
  it('accepts a set that covers every criterion once and orders shared files', () => {
    const goals = [
      goal('a', [1], ['src/a.ts', 'src/shared.ts']),
      goal('b', [2, 3], ['src/b.ts']),
      goal('c', [4], ['src/shared.ts'], ['a']),
    ];
    expect(checkGoals(goals, [1, 2, 3, 4])).toEqual([]);
    expect(parallelGroups(goals)).toEqual([['a', 'b'], ['c']]);
  });

  it('names a criterion with no goal, one with two, and one the spec does not have', () => {
    expect(checkGoals([goal('a', [1, 1, 3], ['x']), goal('b', [3, 9], ['y'])], [1, 2, 3])).toEqual([
      'Acceptance criterion 2 belongs to no goal.',
      'Acceptance criterion 3 belongs to a and b; give it to one.',
      'b name criterion 9, which the spec does not have.',
    ]);
  });

  it('names unknown dependencies, self-dependencies, cycles and unordered shared files', () => {
    expect(checkGoals([goal('a', [1], ['x'], ['a', 'zz'])], null)).toEqual([
      'a depends on itself.',
      'a depends on zz, which is not a goal.',
    ]);
    expect(
      checkGoals([goal('a', [1], ['x'], ['b']), goal('b', [2], ['y'], ['a'])], [1, 2]),
    ).toEqual(['The goals depend on each other in a cycle.']);
    expect(
      checkGoals([goal('a', [1], ['src/s.ts']), goal('b', [2], ['src/s.ts'])], [1, 2]),
    ).toEqual(['a and b both touch src/s.ts but neither depends on the other; order them.']);
    // Ordered through a third goal counts.
    expect(
      checkGoals(
        [goal('a', [1], ['s']), goal('m', [2], ['m'], ['a']), goal('b', [3], ['s'], ['m'])],
        [1, 2, 3],
      ),
    ).toEqual([]);
    expect(checkGoals([], [1])).toEqual(['Record at least one goal.']);
  });

  it('renders the goals with the spec’s own words and the order', () => {
    const md = renderGoals(
      [goal('a', [1], ['src/a.ts']), goal('b', [2], ['src/b.ts'], ['a'])],
      [
        { n: 1, text: 'Header row.' },
        { n: 2, text: 'Filters.' },
      ],
    );
    expect(md).toContain('## 1. Goal a (`a`)');
    expect(md).toContain('**Acceptance criteria:** 2. Filters.');
    expect(md).toContain('**Depends on:** `a`');
    expect(md).toContain('**Order:** `a`, then `b`. No two goals run at the same time.');
  });
});

// ─── the goals template ────────────────────────────────────────────────────

const SECRET = Buffer.from('unit-test-key-unit-test-key-0123').toString('base64url');
const SPEC =
  '# Export runs as CSV\n\n## Problem\n\nBy hand.\n\n## Acceptance criteria\n\n1. A header row (a test).\n\n## Not in scope\n\nPDF.';
const EDITED =
  '# Export runs as CSV\n\n## Problem\n\nBy hand.\n\n## Acceptance criteria\n\n1. A header row (a test).\n2. Filters apply (a test).\n3. A download button (an e2e test).\n\n## Not in scope\n\nPDF.';

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
const recordGoals = (goals: Goal[]) =>
  message(
    [{ type: 'tool_use', id: `tu_${Math.random()}`, name: 'record_goals', input: { goals } }],
    'tool_use',
  );

const lastToolResult = (p: ModelParams): string | null => {
  const last = p.messages[p.messages.length - 1]!;
  if (!Array.isArray(last.content)) return null;
  const block = last.content.find((b) => (b as { type: string }).type === 'tool_result') as
    { content: unknown } | undefined;
  return block ? JSON.stringify(block.content) : null;
};

/**
 * The factory's agents, scripted: the Spec Builder writes SPEC, the Spec Review passes, the Goal
 * Builder records `firstTry` and then `goals` when Magpipe names problems, the Goal Review says
 * `goalVerdict`.
 */
function factoryModel(opts: {
  goals: Goal[] | null;
  firstTry?: Goal[];
  goalVerdict: string;
  seen?: { builderUsers: string[]; toolResults: string[]; reviewUsers: string[] };
}): ModelClient {
  return {
    async create(p) {
      const system = String(p.system);
      if (system.startsWith('You write the spec')) return text(SPEC);
      if (system.startsWith('You review one spec')) return text('Verdict: pass');
      if (system.startsWith('You split one approved spec')) {
        const result = lastToolResult(p);
        if (result) opts.seen?.toolResults.push(result);
        else opts.seen?.builderUsers.push(JSON.stringify(p.messages[0]!.content));
        if (!opts.goals) return text('I could not split it.');
        if (!result && opts.firstTry) return recordGoals(opts.firstTry);
        if (result?.includes('Not recorded')) return recordGoals(opts.goals);
        if (!result) return recordGoals(opts.goals);
        return text('Three goals; b and c wait for a.');
      }
      if (system.startsWith('You review the goals')) {
        opts.seen?.reviewUsers.push(JSON.stringify(p.messages[0]!.content));
        // A failing reviewer sends the goals back while it may, then gives its verdict.
        const offered = (p.tools ?? []).some((t) => (t as { name?: string }).name === 'send_back');
        if (opts.goalVerdict.includes('fail') && offered && !lastToolResult(p)) {
          return message(
            [{ type: 'tool_use', id: 'tu_sb', name: 'send_back', input: { findings: 'Too big.' } }],
            'tool_use',
          );
        }
        return text(opts.goalVerdict);
      }
      return text('Answered.');
    },
  };
}

const GOALS: Goal[] = [
  goal('header', [1], ['lib/export.ts', 'tests/export.test.ts']),
  goal('filters', [2], ['lib/export.ts', 'lib/filters.ts'], ['header']),
  goal('button', [3], ['components/Export.tsx'], ['header']),
];

describe('the goals template', () => {
  let db: Db;
  let close: () => Promise<void>;
  let dir: string;
  const store = scriptedStore(true);
  const previous = process.env.MAGPIPE_SECRET_KEY;

  /** A spec run that files its issue, with the operator's edit applied in Linear. */
  async function filedSpec(engine: Engine): Promise<TrackerIssue> {
    const run = await createRun(
      db,
      { text: 'CSV export', attachments: [], template: 'spec' },
      null,
      await templatePlan(db, 'spec'),
    );
    engine.enqueue(run.id);
    await engine.whenIdle();
    const issue = (await issueForRun(db, run.id))!;
    store.issues.find((i) => i.id === issue.externalId)!.description = EDITED;
    return issue;
  }

  beforeAll(async () => {
    process.env.MAGPIPE_SECRET_KEY = SECRET;
    // Worktrees a tick may make stay in a temp folder, never the project's (D41).
    process.env.MAGPIPE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-goals-data-'));
    useTrackerFactory((key) => scriptedTracker(key, store));
    ({ db, close } = await openDb('memory://'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-goals-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e 0' } }),
    );
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await loadFactory(db, { path: dir, scripts: ['test'] });
    await saveLinearKey(db, 'lin_api_goals');
    await setUpProject(db, { label: 'magpipe' });
  }, 30_000);
  afterAll(async () => {
    useTrackerFactory(undefined);
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MAGPIPE_SECRET_KEY;
    else process.env.MAGPIPE_SECRET_KEY = previous;
    fs.rmSync(process.env.MAGPIPE_DATA_DIR!, { recursive: true, force: true });
    delete process.env.MAGPIPE_DATA_DIR;
  });

  it('approval in Magpipe starts it once; it files the goals as blocked sub-issues', async () => {
    const seen = {
      builderUsers: [] as string[],
      toolResults: [] as string[],
      reviewUsers: [] as string[],
    };
    const engine = new Engine({
      client: factoryModel({
        goals: GOALS,
        // First try misses criterion 2: Magpipe names it and the builder records again.
        firstTry: [
          goal('header', [1], ['lib/export.ts']),
          goal('button', [3], ['components/Export.tsx']),
        ],
        goalVerdict: 'Verdict: pass\n\n- Substance: pass',
        seen,
      }),
      getDb: async () => db,
    });
    const issue = await filedSpec(engine);
    await approveIssue(db, issue.id);
    const enqueue = (id: string) => engine.enqueue(id);
    const [run, again] = await Promise.all([
      startGoalsRun(db, issue, enqueue),
      startGoalsRun(db, issue, enqueue),
    ]);
    expect(run).not.toBeNull();
    expect(again).toBeNull();
    expect(run!.input).toMatchObject({ template: 'goals', issueId: issue.id });
    expect(run!.parentRunId).toBe(issue.runId);
    expect(run!.createdBy).toBe('factory');
    await engine.whenIdle();

    const done = (await getRun(db, run!.id))!;
    expect(done.status).toBe('done');
    const [read, split, review, file] = done.plan;
    // The spec as the operator left it in Linear, not as the spec run wrote it.
    expect(read).toMatchObject({ action: 'read_issue', status: 'done', document: EDITED });
    expect(read!.result!.summary).toBe(
      `Read ${issue.identifier}, Export runs as CSV: 3 acceptance criteria.`,
    );
    expect(seen.builderUsers[0]).toContain('2. Filters apply (a test).');
    expect(seen.toolResults[0]).toContain('Acceptance criterion 2 belongs to no goal.');
    expect(seen.toolResults[1]).toContain('Recorded 3 goals.');
    expect(split).toMatchObject({ status: 'done', goals: GOALS });
    expect(split!.document).toMatch(/^# Goals/);
    expect(seen.reviewUsers[0]).toContain('## 2. Goal filters (`filters`)');
    expect(seen.reviewUsers[0]).toContain('3. A download button (an e2e test).');
    expect(review).toMatchObject({ verdict: 'pass' });
    expect(file).toMatchObject({ action: 'file_goals', status: 'done' });

    const filed = await goalIssues(db, issue.id);
    expect(filed.map((g) => g.goal!.key)).toEqual(['header', 'filters', 'button']);
    const remote = (key: string) =>
      store.issues.find((i) => i.id === filed.find((g) => g.goal!.key === key)!.externalId)!;
    for (const key of ['header', 'filters', 'button']) {
      expect(remote(key)).toMatchObject({ parentId: issue.externalId, state: { id: 'st_todo' } });
    }
    expect(remote('filters').description).toContain('2. Filters apply (a test).');
    expect(remote('filters').description).toContain(
      `- ${remote('header').identifier} (\`header\`)`,
    );
    expect(store.relations).toEqual([
      { blocking: remote('header').id, blocked: remote('filters').id },
      { blocking: remote('header').id, blocked: remote('button').id },
    ]);
    const spec = store.issues.find((i) => i.id === issue.externalId)!;
    expect(spec.state.id).toBe('st_progress');
    expect(spec.comments.at(-1)).toContain('Split into 3 goals');
    expect(await getIssue(db, issue.id)).toMatchObject({ stage: 'building', goalsRunId: run!.id });
    expect(file!.result!.summary).toBe(
      `Filed 3 goals under ${issue.identifier}: ${filed.map((g) => g.identifier).join(', ')}. ${issue.identifier} is now In Progress.`,
    );
    expect(done.output!.markdown).toMatch(/^# Goals/);
    expect(done.output!.markdown).toContain('## File the goals');
  }, 30_000);

  it('approval seen in Linear starts it at the next check, and only once', async () => {
    const engine = new Engine({
      client: factoryModel({
        goals: [goal('all', [1, 2, 3], ['lib/export.ts'])],
        goalVerdict: 'Verdict: pass',
      }),
      getDb: async () => db,
    });
    const issue = await filedSpec(engine);
    scriptedTracker('k', store).move(issue.identifier, 'Approved');
    // A sub-issue labelled by hand under a parent Magpipe does not track is no spec.
    const stray = await scriptedTracker('k', store).createIssue({
      teamId: SCRIPTED_TEAM.id,
      projectId: TEST_LINEAR_PROJECT.id,
      title: 'A goal made by hand',
      description: '1. Something.',
      labelIds: [store.labels[0]!.id],
      stateId: 'st_todo',
      parentId: 'iss_remote_untracked',
    });
    const afterCheck = (d: Db) => factoryTick(d, (id) => engine.enqueue(id));
    const first = await checkLinear(db, { force: true, afterCheck });
    expect(first).toMatchObject({ status: 'done' });
    // Only this spec's goals run; the tick may also start a goal filed earlier in this file.
    const mine = (r: unknown) =>
      (r as { started: string[] }).started.filter((x) => x.startsWith(`${issue.identifier} `));
    expect(mine(first)).toEqual([
      expect.stringMatching(new RegExp(`^${issue.identifier} → flight_`)),
    ]);
    const strayRow = (await listIssues(db)).find((i) => i.externalId === stray.id)!;
    expect(strayRow).toMatchObject({
      stage: 'approved',
      externalParentId: 'iss_remote_untracked',
      goalsRunId: null,
    });
    const second = await checkLinear(db, { force: true, afterCheck });
    expect(mine(second)).toEqual([]);
    await engine.whenIdle();
    expect(await getIssue(db, issue.id)).toMatchObject({ stage: 'building' });
  }, 30_000);

  it('goals that fail review file nothing; the spec goes to needs you and can start again', async () => {
    const engine = new Engine({
      client: factoryModel({ goals: GOALS, goalVerdict: 'Verdict: fail\n\n- Sized: fail' }),
      getDb: async () => db,
    });
    const issue = await filedSpec(engine);
    await approveIssue(db, issue.id);
    const run = (await startGoalsRun(db, issue, (id) => engine.enqueue(id)))!;
    await engine.whenIdle();
    const done = (await getRun(db, run.id))!;
    expect(done.status).toBe('done');
    // Sent back once (the Goal Review's one round), then failed again.
    expect(done.plan.find((s) => s.id === 'goals')!.round).toBe(2);
    const file = done.plan.find((s) => s.id === 'file')!;
    expect(file).toMatchObject({ status: 'skipped' });
    expect(file.result!.summary).toBe(
      `Not filed: the goals did not pass review. ${issue.identifier} moved to Blocked with the findings.`,
    );
    expect(await goalIssues(db, issue.id)).toEqual([]);
    const spec = store.issues.find((i) => i.id === issue.externalId)!;
    expect(spec.comments.at(-1)).toContain('- Sized: fail');
    expect(await getIssue(db, issue.id)).toMatchObject({ stage: 'needs_you', goalsRunId: null });

    // Moved back to approved in Linear: the next check splits it again.
    scriptedTracker('k', store).move(issue.identifier, 'Approved');
    const started: string[] = [];
    const result = await checkLinear(db, {
      force: true,
      afterCheck: async (d) => {
        const r = await factoryTick(d, () => undefined);
        started.push(...r.started);
        return r;
      },
    });
    expect(result).toMatchObject({ status: 'done' });
    expect(started.filter((x) => x.startsWith(`${issue.identifier} `))).toHaveLength(1);
  }, 30_000);

  it('a Goal Builder that records nothing fails its step, and the run says why', async () => {
    const engine = new Engine({
      client: factoryModel({ goals: null, goalVerdict: 'Verdict: pass' }),
      getDb: async () => db,
    });
    const issue = await filedSpec(engine);
    await approveIssue(db, issue.id);
    const run = (await startGoalsRun(db, issue, (id) => engine.enqueue(id)))!;
    await engine.whenIdle();
    const done = (await getRun(db, run.id))!;
    expect(done.status).toBe('failed');
    expect(done.plan.find((s) => s.id === 'goals')).toMatchObject({
      status: 'failed',
      error: { code: 'no_goals' },
    });
  }, 30_000);

  it('refuses to start without the factory’s goal agents', async () => {
    const engine = new Engine({
      client: factoryModel({ goals: GOALS, goalVerdict: 'Verdict: pass' }),
      getDb: async () => db,
    });
    const issue = await filedSpec(engine);
    await approveIssue(db, issue.id);
    const { updateAgent, listAgents } = await import('@/lib/agents');
    const builder = (await listAgents(db)).find((a) => a.slug === 'goal-builder')!;
    await updateAgent(db, builder.id, { status: 'paused' });
    try {
      await expect(startGoalsRun(db, issue, () => undefined)).rejects.toThrow(
        'Goal Builder is paused. Resume it on Agents, then send it again.',
      );
      expect((await getIssue(db, issue.id))!.goalsRunId).toBeNull();
    } finally {
      await updateAgent(db, builder.id, { status: 'idle' });
    }
  }, 30_000);
});

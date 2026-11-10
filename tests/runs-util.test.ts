import { describe, expect, it } from 'vitest';
import {
  computeRunsStats,
  formatDurationWords,
  formatUsd,
  headTitle,
  lastErrorText,
  awaitingApproval,
  sendBackSet,
  matchesRunQuery,
  resultPlaceholder,
  runAgentIds,
  stepMeta,
  threadFor,
  threadText,
  threadTurn,
} from '@/lib/runs-util';
import type { Run, Step } from '@/lib/schemas';

const now = new Date('2026-11-09T12:00:00');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

const run = (
  over: Partial<Pick<Run, 'status' | 'createdAt' | 'finishedAt' | 'durationMs' | 'usage'>>,
) => ({
  status: 'done' as const,
  createdAt: hoursAgo(1),
  finishedAt: hoursAgo(1),
  durationMs: 60_000,
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  ...over,
});

describe('computeRunsStats', () => {
  it('counts and prices today, and judges the last seven days', () => {
    const stats = computeRunsStats(
      [
        run({ durationMs: 120_000, usage: { inputTokens: 0, outputTokens: 0, costUsd: 1.25 } }),
        run({
          status: 'failed',
          durationMs: 30_000,
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.5 },
        }),
        // Yesterday counts for the week, not for today.
        run({ createdAt: hoursAgo(30), finishedAt: hoursAgo(30), durationMs: 400_000 }),
        // Too old for anything.
        run({ createdAt: hoursAgo(24 * 9), finishedAt: hoursAgo(24 * 9), durationMs: 1 }),
        // Still running: no verdict, no duration.
        run({ status: 'running', finishedAt: null, durationMs: null }),
      ],
      now,
    );
    expect(stats.runsToday).toBe(3);
    expect(stats.spendToday).toBe(1.75);
    expect(stats.successPct7d).toBe(67);
    expect(stats.medianDurationMs).toBe(120_000);
  });

  it('says nothing it cannot compute', () => {
    const stats = computeRunsStats([], now);
    expect(stats.successPct7d).toBeNull();
    expect(stats.medianDurationMs).toBeNull();
    expect(stats.spendToday).toBe(0);
  });

  it('takes the mean of the middle pair for an even count', () => {
    const stats = computeRunsStats([run({ durationMs: 10_000 }), run({ durationMs: 30_000 })], now);
    expect(stats.medianDurationMs).toBe(20_000);
  });
});

describe('formatting', () => {
  it('writes durations in words and dollars with two decimals', () => {
    expect(formatDurationWords(400_000)).toBe('6m 40s');
    expect(formatDurationWords(48_000)).toBe('48s');
    expect(formatDurationWords(3_720_000)).toBe('1h 02m');
    expect(formatUsd(18.4)).toBe('$18.40');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('cuts a long task for the page title and keeps a short one whole', () => {
    expect(headTitle('Summarise the note')).toBe('Summarise the note');
    expect(headTitle('a'.repeat(200))).toHaveLength(140);
    expect(headTitle('a'.repeat(200)).endsWith('…')).toBe(true);
  });
});

describe('steps and queries', () => {
  const step = (over: Partial<Step>): Step => ({
    id: 's',
    agentId: 'agt_1',
    title: 'Read the docs',
    dependsOn: [],
    status: 'todo',
    ...over,
  });
  const agents = [
    { id: 'agt_1', name: 'Researcher', initials: 'RS', slug: 'researcher' },
    { id: 'agt_2', name: 'Coder', initials: 'CD', slug: 'coder' },
  ];

  it('describes a step by its state', () => {
    expect(
      stepMeta(
        step({
          status: 'done',
          startedAt: '2026-11-09T11:00:00Z',
          finishedAt: '2026-11-09T11:01:20Z',
          usage: { inputTokens: 11_000, outputTokens: 1_000, costUsd: 0 },
        }),
      ),
    ).toBe('01:20 · 12k tok');
    expect(
      stepMeta(
        step({
          agentId: null,
          status: 'done',
          startedAt: '2026-11-09T11:00:00Z',
          finishedAt: '2026-11-09T11:00:02Z',
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        }),
      ),
    ).toBe('00:02 · plan');
    expect(stepMeta(step({ status: 'done' }))).toBe('done');
    expect(stepMeta(step({ status: 'live', startedAt: '2026-11-09T11:59:18' }), now)).toBe(
      'running · 00:42',
    );
    expect(stepMeta(step({ status: 'failed', error: { code: 'limit_steps', message: '' } }))).toBe(
      'failed · limit_steps',
    );
    expect(stepMeta(step({ status: 'skipped' }))).toBe('skipped');
    expect(stepMeta(step({}))).toBe('waiting');
  });

  it('matches runs by task, flight id and the agents that flew', () => {
    const r = {
      displayId: 'flight_8f3a21',
      input: { text: 'Sync Shopify orders', attachments: [] },
      plan: [
        step({ agentId: 'agt_2' }),
        step({ id: 'm', agentId: null }),
        step({ agentId: 'agt_2' }),
      ],
    };
    expect(runAgentIds(r)).toEqual(['agt_2']);
    expect(matchesRunQuery(r, 'shopify', agents)).toBe(true);
    expect(matchesRunQuery(r, '8f3a', agents)).toBe(true);
    expect(matchesRunQuery(r, 'coder', agents)).toBe(true);
    expect(matchesRunQuery(r, 'researcher', agents)).toBe(false);
    expect(matchesRunQuery(r, '  ', agents)).toBe(true);
  });

  it('finds the last error in a trail', () => {
    expect(
      lastErrorText([
        { kind: 'error', text: 'first' },
        { kind: 'message', text: 'ok' },
        { kind: 'error', text: 'last' },
      ]),
    ).toBe('last');
    expect(lastErrorText([{ kind: 'done', text: 'Run finished' }])).toBeNull();
  });
});

describe('conversation threads', () => {
  const turn = (
    id: string,
    text: string,
    parentRunId: string | null,
    over: Partial<Pick<Run, 'status' | 'output'>> = {},
  ) =>
    ({
      id,
      displayId: `flight_${id}`,
      parentRunId,
      input: { text, attachments: [] },
      status: 'done',
      output: { markdown: `Answer to ${text}`, artifacts: [] },
      ...over,
    }) as unknown as Run;

  it('renders turns as operator and Magpipe lines, a missing answer as its placeholder', () => {
    const done = threadTurn(turn('a', 'How many birds?', null));
    const failed = threadTurn(turn('b', 'And now?', 'a', { status: 'failed', output: null }));
    expect(threadText([done, failed])).toBe(
      'Operator: How many birds?\nMagpipe: Answer to How many birds?\n\n' +
        `Operator: And now?\nMagpipe: ${resultPlaceholder('failed')}`,
    );
    expect(threadText([])).toBe('');
  });

  it('clips a long turn so a thread cannot grow a prompt without bound', () => {
    const long = threadTurn(turn('a', 'x'.repeat(5_000), null));
    const text = threadText([long]);
    expect(text.length).toBeLessThan(4_100);
    expect(text).toContain('…');
  });

  it('walks the ancestors oldest first, folds re-flies away and stops at the cap', () => {
    const first = turn('1', 'How many birds?', null);
    const retry = turn('2', 'How many birds?', '1'); // a re-fly: the same task again
    const second = turn('3', 'And tomorrow?', '2');
    const third = turn('4', 'Why?', '3');
    const runs = [third, second, retry, first];
    expect(threadFor(runs, third).map((r) => r.id)).toEqual(['2', '3', '4']);
    expect(threadFor(runs, retry).map((r) => r.id)).toEqual(['2']);
    expect(threadFor(runs, first).map((r) => r.id)).toEqual(['1']);
    expect(threadFor(runs, third, 1).map((r) => r.id)).toEqual(['3', '4']);
    // An ancestor no longer loaded ends the walk; a cycle cannot loop.
    expect(threadFor([third, second], third).map((r) => r.id)).toEqual(['3', '4']);
    const loopA = turn('a', 'a', 'b');
    const loopB = turn('b', 'b', 'a');
    expect(threadFor([loopA, loopB], loopA).map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('awaitingApproval', () => {
  it('names finished steps whose dependants have not started, never for the merge', () => {
    const step = (id: string, status: Step['status'], dependsOn: string[] = []) =>
      ({ id, status, dependsOn }) as Pick<Step, 'id' | 'status' | 'dependsOn'>;
    const plan = [
      step('s1', 'done'),
      step('s2', 'todo', ['s1']),
      step('s3', 'done'),
      step('merge', 'todo', ['s2', 's3']),
    ];
    expect(awaitingApproval(plan).map((s) => s.id)).toEqual(['s1']);
    expect(awaitingApproval([step('s1', 'done'), step('merge', 'todo', ['s1'])])).toEqual([]);
  });
});

describe('sendBackSet', () => {
  const step = (id: string, dependsOn: string[] = []) => ({ id, dependsOn });
  const plan = [
    step('research'),
    step('plan', ['research']),
    step('code', ['plan']),
    step('verify', ['code']),
    step('review', ['code', 'verify']),
    step('docs', ['plan']),
    step('merge', ['review', 'docs']),
  ];

  it('reopens what the reviewer judges and what lies between, never earlier work or the merge', () => {
    expect([...sendBackSet(plan, 'review')].sort()).toEqual(['code', 'review', 'verify']);
  });

  it('follows the reviewer’s direct dependencies only', () => {
    // A reviewer of the plan alone reopens the plan, not the code built on it.
    const planReview = [...plan, step('plan-review', ['plan'])];
    expect([...sendBackSet(planReview, 'plan-review')].sort()).toEqual(['plan', 'plan-review']);
    expect(sendBackSet(plan, 'missing').size).toBe(0);
  });
});

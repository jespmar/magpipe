import { describe, expect, it } from 'vitest';
import {
  computeRunsStats,
  formatDurationWords,
  formatUsd,
  headTitle,
  lastErrorText,
  matchesRunQuery,
  runAgentIds,
  stepMeta,
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

import { describe, expect, it } from 'vitest';
import {
  agentCard,
  cardFooter,
  clockTime,
  formatBytes,
  mergeEvents,
  toFlightEvent,
  type FlightEvent,
} from '@/lib/home-util';
import type { Agent, Run, Step } from '@/lib/schemas';

const now = new Date('2026-11-09T12:00:00Z');

const agent = {
  id: 'agt_1',
  slug: 'researcher',
  name: 'Researcher',
  role: 'Gathers context',
  initials: 'RE',
  model: 'claude-sonnet-5-5',
  status: 'idle',
} as Agent;

const step = (over: Partial<Step>): Step => ({
  id: 's',
  agentId: 'agt_1',
  title: 'A step',
  dependsOn: [],
  status: 'todo',
  ...over,
});

const run = (status: Run['status'], plan: Step[]): Pick<Run, 'id' | 'status' | 'plan'> => ({
  id: `run_${status}`,
  status,
  plan,
});

describe('agentCard', () => {
  it('shows the live step, the run’s progress and tokens so far while running', () => {
    const card = agentCard({ ...agent, status: 'running' }, [
      run('running', [
        step({
          id: 'a',
          status: 'done',
          usage: { inputTokens: 900, outputTokens: 100, costUsd: 0 },
        }),
        step({
          id: 'b',
          title: 'Read the docs',
          status: 'live',
          startedAt: '2026-11-09T11:59:18Z',
        }),
        step({ id: 'c', agentId: 'agt_2', status: 'todo' }),
        step({ id: 'merge', agentId: null, status: 'todo' }),
      ]),
    ]);
    expect(card.live).toBe(true);
    expect(card.task).toBe('Read the docs');
    expect(card.progress).toBe(0.25);
    expect(card.tokens).toBe(1000);
    expect(cardFooter(card, now)).toBe('1k tok · 00:42');
  });

  it('falls back to the most recently finished step, newest first', () => {
    const card = agentCard(agent, [
      run('done', [step({ title: 'Older', status: 'done', finishedAt: '2026-11-08T10:00:00Z' })]),
      run('failed', [
        step({
          title: 'Newer',
          status: 'failed',
          finishedAt: '2026-11-09T10:00:00Z',
          usage: { inputTokens: 4200, outputTokens: 0, costUsd: 0 },
        }),
      ]),
    ]);
    expect(card.live).toBe(false);
    expect(card.task).toBe('Newer');
    expect(card.progress).toBeNull();
    expect(cardFooter(card, now)).toBe('4k tok · 2 hours ago');
  });

  it('says so when the agent has never flown', () => {
    const card = agentCard(agent, []);
    expect(card.task).toBeNull();
    expect(cardFooter(card, now)).toBe('no runs yet');
  });
});

describe('formatBytes', () => {
  it('rounds to one decimal above a kilobyte', () => {
    expect(formatBytes(24)).toBe('24 B');
    expect(formatBytes(1234)).toBe('1.2 kB');
    expect(formatBytes(3_400_000)).toBe('3.4 MB');
  });
});

describe('flight events', () => {
  const ev = (seq: number, agentId: string | null = 'agt_1'): FlightEvent =>
    toFlightEvent(
      {
        id: `e${seq}`,
        seq,
        runId: 'r',
        ts: now,
        stepId: null,
        agentId,
        kind: 'message',
        text: 't',
        payload: null,
      },
      { agt_1: 'Researcher' },
    );
  it('resolves names, with the orchestrator as Magpipe', () => {
    expect(ev(1).agent).toBe('Researcher');
    expect(ev(2, null).agent).toBe('Magpipe');
    expect(ev(3, 'agt_x').agent).toBe('agent');
    expect(ev(1).ts).toBe('2026-11-09T12:00:00.000Z');
  });
  it('merges replay and stream by sequence, without duplicates, capped', () => {
    const merged = mergeEvents([ev(1), ev(2)], [ev(2), ev(3)]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(mergeEvents([ev(1), ev(2), ev(3)], [], 2).map((e) => e.seq)).toEqual([2, 3]);
  });
  it('shows a 24-hour clock with seconds', () => {
    expect(clockTime(new Date('2026-11-09T14:02:17'))).toBe('14:02:17');
  });
});

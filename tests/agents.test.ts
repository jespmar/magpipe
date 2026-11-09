import { describe, expect, it } from 'vitest';
import {
  computeAgentStats,
  describeMemoryScope,
  initialsOf,
  matchesFilter,
  matchesQuery,
  slugify,
} from '@/lib/agents-util';
import { modelOptions } from '@/lib/models';
import { agentInput, agentPatch, type Step } from '@/lib/schemas';

describe('slugify / initials', () => {
  it('makes url-safe unique-ish slugs', () => {
    expect(slugify('Researcher')).toBe('researcher');
    expect(slugify('  Data Scout 2 ')).toBe('data-scout-2');
    expect(slugify('Åsa & Co.')).toBe('asa-co');
    expect(slugify('!!!')).toBe('agent');
    expect(slugify('x'.repeat(80))).toHaveLength(48);
  });
  it('derives initials', () => {
    expect(initialsOf('Researcher')).toBe('RE');
    expect(initialsOf('Data Scout')).toBe('DS');
    expect(initialsOf('')).toBe('?');
  });
});

describe('computeAgentStats', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const day = 86_400_000;
  const step = (agentId: string | null, status: Step['status'], tokens?: number): Step => ({
    id: Math.random().toString(36).slice(2),
    agentId,
    title: 't',
    dependsOn: [],
    status,
    ...(tokens !== undefined
      ? {
          usage: {
            inputTokens: Math.round(tokens * 0.75),
            outputTokens: Math.round(tokens * 0.25),
            costUsd: 0,
          },
        }
      : {}),
  });
  const runs = [
    {
      id: 'run_a',
      createdAt: new Date(now.getTime() - 1 * day),
      plan: [step(null, 'done'), step('agt_x', 'done', 1000), step('agt_x', 'failed', 3000)],
    },
    {
      id: 'run_b',
      createdAt: new Date(now.getTime() - 2 * day),
      plan: [step('agt_x', 'done', 2000), step('agt_y', 'done', 500)],
    },
    {
      id: 'run_old',
      createdAt: new Date(now.getTime() - 9 * day),
      plan: [step('agt_x', 'failed', 9000)],
    },
  ];

  it('counts distinct runs in the last 7 days and averages tokens over steps', () => {
    expect(computeAgentStats('agt_x', runs, now)).toEqual({
      runs7d: 2,
      successPct: 67,
      avgTokens: 2000,
    });
    expect(computeAgentStats('agt_y', runs, now)).toEqual({
      runs7d: 1,
      successPct: 100,
      avgTokens: 500,
    });
  });
  it('returns nulls, not zeros, when there is nothing to average', () => {
    expect(computeAgentStats('agt_z', runs, now)).toEqual({
      runs7d: 0,
      successPct: null,
      avgTokens: null,
    });
  });
});

describe('describeMemoryScope', () => {
  const ns = [
    { id: 'facts', label: 'Facts' },
    { id: 'rate-limits', label: 'Rate limits' },
    { id: 'decisions', label: 'Decisions' },
  ];
  it('names the common shapes', () => {
    expect(describeMemoryScope({ read: [], write: [] }, ns)).toBe('No memory access');
    expect(
      describeMemoryScope({ read: ['facts', 'rate-limits', 'decisions'], write: [] }, ns),
    ).toBe('Read · all namespaces');
    expect(
      describeMemoryScope({ read: ['rate-limits', 'facts'], write: ['facts', 'rate-limits'] }, ns),
    ).toBe('Read + write · facts, rate limits');
    expect(describeMemoryScope({ read: ['decisions'], write: ['facts'] }, ns)).toBe(
      'Read · decisions · Write · facts',
    );
  });
});

describe('filters and search', () => {
  it('groups paused with idle and searches across fields', () => {
    expect(matchesFilter('paused', 'idle')).toBe(true);
    expect(matchesFilter('running', 'idle')).toBe(false);
    expect(matchesFilter('waiting', 'all')).toBe(true);
    const a = {
      name: 'Coder',
      role: 'Writes code',
      model: 'claude-opus-5-5',
      description: 'Implements changes',
    };
    expect(matchesQuery(a, 'OPUS')).toBe(true);
    expect(matchesQuery(a, 'implements')).toBe(true);
    expect(matchesQuery(a, 'tester')).toBe(false);
    expect(matchesQuery(a, '   ')).toBe(true);
  });
});

describe('agent API schemas', () => {
  it('fills defaults on create and requires a name and model', () => {
    const parsed = agentInput.parse({ name: ' Scout ', model: 'claude-haiku-5-5' });
    expect(parsed.name).toBe('Scout');
    expect(parsed.limits).toEqual({ maxTokens: 100_000, maxSteps: 30, timeoutSec: 600 });
    expect(parsed.memoryScope).toEqual({ read: [], write: [] });
    expect(agentInput.safeParse({ model: 'x' }).success).toBe(false);
    expect(agentInput.safeParse({ name: 'x', model: '' }).success).toBe(false);
  });
  it('accepts a pause as a patch', () => {
    expect(agentPatch.parse({ status: 'paused' })).toEqual({ status: 'paused' });
    expect(agentPatch.safeParse({ status: 'running' }).success).toBe(false);
  });
});

describe('modelOptions', () => {
  it('lists known models first and keeps unknown ones in use', () => {
    expect(modelOptions(['claude-sonnet-5-5', 'my-local-model'])).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'my-local-model',
    ]);
  });
});

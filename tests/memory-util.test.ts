import { describe, expect, it } from 'vitest';
import { shortWhen } from '@/lib/format';
import {
  authorLabel,
  formatConfidence,
  formatExpires,
  isExpired,
  isStale,
  matchesMemoryQuery,
  rawJson,
  summarizeHealth,
} from '@/lib/memory-util';
import { memoryInput, memoryPatch, type MemoryEntry } from '@/lib/schemas';

const now = new Date('2026-11-09T12:00:00Z');
const DAY = 86_400_000;

describe('shortWhen', () => {
  it('reads like the nest table', () => {
    expect(shortWhen(new Date('2026-11-09T10:25:00Z'), now)).toMatch(/^\d\d:\d\d$/);
    expect(shortWhen(new Date(now.getTime() - 2 * DAY), now)).toMatch(
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/,
    );
    expect(shortWhen(new Date(now.getTime() - 12 * DAY), now)).toBe('12 d');
    expect(shortWhen(new Date(now.getTime() - 14 * DAY), now)).toBe('2 w');
    expect(shortWhen(new Date(now.getTime() - 90 * DAY), now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});

describe('trust', () => {
  const base = { stale: false, conflict: false, verifiedAt: now, expiresAt: null as Date | null };
  it('computes stale and expired on read', () => {
    expect(isStale(base, now)).toBe(false);
    expect(isStale({ ...base, verifiedAt: new Date(now.getTime() - 31 * DAY) }, now)).toBe(true);
    expect(isStale({ ...base, stale: true }, now)).toBe(true);
    expect(isExpired(base, now)).toBe(false);
    expect(isExpired({ ...base, expiresAt: new Date(now.getTime() - 1) }, now)).toBe(true);
  });
  it('summarises nest health', () => {
    const entries = [
      base,
      { ...base, verifiedAt: new Date(now.getTime() - 40 * DAY) },
      { ...base, conflict: true },
      { ...base, expiresAt: new Date(now.getTime() - DAY) },
    ];
    expect(summarizeHealth(entries, now)).toEqual({
      facts: 4,
      stale: 1,
      conflicts: 1,
      expired: 1,
      verifiedPct: 75,
    });
    expect(summarizeHealth([], now).verifiedPct).toBeNull();
  });
});

describe('labels', () => {
  const agents = [{ id: 'agt_coder', name: 'Coder', initials: 'CD' }];
  it('formats confidence, expiry and authors', () => {
    expect(formatConfidence(0.955)).toBe('0.95');
    expect(formatConfidence(1)).toBe('1.00');
    expect(formatExpires(null)).toBe('never');
    expect(formatExpires(new Date('2026-12-06T00:00:00Z'))).toBe('2026-12-06');
    expect(authorLabel('user', agents)).toBe('you');
    expect(authorLabel('agt_coder', agents)).toBe('CD');
    expect(authorLabel('agt_gone', agents)).toBe('agt_gone');
  });
  it('searches key, value, source and namespace', () => {
    const e = {
      key: 'visma.salesorder.rpm',
      value: '300 requests / min',
      source: 'docs.visma.net',
      ns: 'rate-limits',
    };
    expect(matchesMemoryQuery(e, 'RPM')).toBe(true);
    expect(matchesMemoryQuery(e, 'requests')).toBe(true);
    expect(matchesMemoryQuery(e, 'rate-limits')).toBe(true);
    expect(matchesMemoryQuery(e, 'shopify')).toBe(false);
  });
  it('renders the raw record in snake_case with names instead of ids', () => {
    const entry: MemoryEntry = {
      id: 'mem_1',
      ns: 'facts',
      key: 'k',
      value: 'v',
      data: null,
      confidence: 0.9,
      source: 's',
      writtenBy: 'agt_coder',
      readBy: ['agt_coder'],
      expiresAt: null,
      verifiedAt: now,
      stale: false,
      conflict: false,
      createdAt: now,
      updatedAt: now,
      history: [{ value: 'v', confidence: 0.9, writtenBy: 'agt_coder', at: now.toISOString() }],
    };
    const json = JSON.parse(rawJson(entry, agents));
    expect(json).toMatchObject({
      ns: 'facts',
      key: 'k',
      written_by: 'Coder',
      read_by: ['Coder'],
      expires: null,
      history: 1,
    });
    expect(json).not.toHaveProperty('data');
  });
});

describe('memory API schemas', () => {
  it('fills defaults and accepts a plain date for expiry', () => {
    const parsed = memoryInput.parse({
      ns: 'facts',
      key: ' k ',
      value: 'v',
      expiresAt: '2026-12-06',
    });
    expect(parsed).toMatchObject({
      key: 'k',
      confidence: 1,
      source: 'you',
      expiresAt: '2026-12-06',
    });
    expect(
      memoryInput.safeParse({ ns: 'facts', key: 'k', value: 'v', confidence: 1.2 }).success,
    ).toBe(false);
    expect(memoryInput.safeParse({ ns: 'Bad NS', key: 'k', value: 'v' }).success).toBe(false);
    expect(
      memoryInput.safeParse({ ns: 'facts', key: 'k', value: 'v', expiresAt: 'soon' }).success,
    ).toBe(false);
  });
  it('keeps a patch sparse', () => {
    expect(memoryPatch.parse({ verified: true })).toEqual({ verified: true });
    expect(memoryPatch.safeParse({ verified: false }).success).toBe(false);
  });
});

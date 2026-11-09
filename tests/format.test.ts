import { describe, expect, it } from 'vitest';
import { formatDuration, formatTokens, plural, relativeTime } from '@/lib/format';
import { listSentence } from '@/lib/text';

const now = new Date('2026-11-09T12:00:00Z');
const ago = (sec: number) => new Date(now.getTime() - sec * 1000);

describe('relativeTime', () => {
  it('rounds to the nearest sensible unit', () => {
    expect(relativeTime(ago(10), now)).toBe('just now');
    expect(relativeTime(ago(4 * 60), now)).toBe('4 minutes ago');
    expect(relativeTime(ago(2 * 3600), now)).toBe('2 hours ago');
    expect(relativeTime(ago(86_400), now)).toBe('yesterday');
    expect(relativeTime(ago(3 * 86_400), now)).toBe('3 days ago');
    expect(relativeTime(ago(14 * 86_400), now)).toBe('2 weeks ago');
  });
  it('falls back to a short date beyond a month', () => {
    expect(relativeTime(new Date('2026-08-01T00:00:00Z'), now)).toMatch(/Aug/);
  });
});

describe('formatDuration', () => {
  it('uses mm:ss under an hour and h:mm:ss above', () => {
    expect(formatDuration(48_000)).toBe('00:48');
    expect(formatDuration(7 * 60_000 + 48_000)).toBe('07:48');
    expect(formatDuration(3600_000 + 5 * 60_000 + 10_000)).toBe('1:05:10');
    expect(formatDuration(-5)).toBe('00:00');
  });
});

describe('formatTokens', () => {
  it('abbreviates like the design (42k, 118k, 1.4M)', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(42_000)).toBe('42k');
    expect(formatTokens(118_400)).toBe('118k');
    expect(formatTokens(1_400_000)).toBe('1.4M');
    expect(formatTokens(12_000_000)).toBe('12M');
  });
});

describe('plural and lists', () => {
  it('handles one and many', () => {
    expect(plural(1, 'bird')).toBe('1 bird');
    expect(plural(4, 'bird')).toBe('4 birds');
    expect(plural(0, 'shiny bit')).toBe('0 shiny bits');
  });
  it('joins names as a sentence', () => {
    expect(listSentence([])).toBe('');
    expect(listSentence(['Coder'])).toBe('Coder');
    expect(listSentence(['Coder', 'Reviewer'])).toBe('Coder and Reviewer');
    expect(listSentence(['Coder', 'Operator', 'Researcher', 'Reviewer'])).toBe(
      'Coder, Operator, Researcher and Reviewer',
    );
  });
});

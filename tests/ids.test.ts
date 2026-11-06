import { describe, expect, it } from 'vitest';
import { fromDisplayId, newId, toDisplayId } from '@/lib/ids';

describe('run display ids', () => {
  it('matches the design format (base36 of the counter)', () => {
    expect(toDisplayId(parseInt('8f3a21', 36))).toBe('flight_8f3a21');
  });

  it('round-trips', () => {
    for (const n of [0, 1, 35, 36, 509_076_649, Number.MAX_SAFE_INTEGER]) {
      expect(fromDisplayId(toDisplayId(n))).toBe(n);
    }
  });

  it('rejects junk', () => {
    expect(fromDisplayId('run_8f3a21')).toBeNull();
    expect(fromDisplayId('flight_')).toBeNull();
    expect(() => toDisplayId(-1)).toThrow(RangeError);
    expect(() => toDisplayId(1.5)).toThrow(RangeError);
  });
});

describe('newId', () => {
  it('is prefixed, lower-case and unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('agt')));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^agt_[0-9a-z]{16}$/);
  });
});

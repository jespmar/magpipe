import { describe, expect, it } from 'vitest';
import { addUsage, costUsd, priceFor, ZERO_USAGE } from '@/lib/pricing';

describe('pricing', () => {
  it('prices a response from the list table', () => {
    expect(costUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(4);
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 500_000, outputTokens: 100_000 })).toBe(2);
    expect(costUsd('claude-haiku-5-5', { inputTokens: 10_000, outputTokens: 2_000 })).toBe(0.002);
    expect(
      costUsd('claude-opus-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }),
    ).toBe(0.2);
  });
  it('never invents a price for an unknown model', () => {
    expect(priceFor('my-local-model')).toBeNull();
    expect(costUsd('my-local-model', { inputTokens: 1e6, outputTokens: 1e6 })).toBe(0);
  });
  it('adds usage without float drift', () => {
    const a = { inputTokens: 1, outputTokens: 2, costUsd: 0.1 };
    const b = { inputTokens: 3, outputTokens: 4, costUsd: 0.2 };
    expect(addUsage(a, b)).toEqual({ inputTokens: 4, outputTokens: 6, costUsd: 0.3 });
    expect(addUsage(ZERO_USAGE, a)).toEqual(a);
  });
});

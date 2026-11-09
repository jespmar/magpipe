/**
 * List prices per million tokens, in USD, for the models the app offers (spec §7.2 step 3).
 * Estimates: the Anthropic price table as of 2026-10; cache reads are billed at a fraction of
 * input and cache writes at a premium. Unknown models cost nothing rather than guessing.
 */
import type { Usage } from './schemas';

export type Price = {
  input: number;
  output: number;
  /** Per million cache-read tokens. */
  cacheRead: number;
  /** Per million cache-write tokens. */
  cacheWrite: number;
};

const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export function priceFor(model: string): Price | null {
  return PRICES[model] ?? null;
}

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/** Dollars for one response, rounded to a tenth of a cent. */
export function costUsd(model: string, tokens: TokenCounts): number {
  const price = priceFor(model);
  if (!price) return 0;
  const perToken = (n: number, perMillion: number) => (n * perMillion) / 1_000_000;
  const usd =
    perToken(tokens.inputTokens, price.input) +
    perToken(tokens.outputTokens, price.output) +
    perToken(tokens.cacheReadTokens ?? 0, price.cacheRead) +
    perToken(tokens.cacheWriteTokens ?? 0, price.cacheWrite);
  return Math.round(usd * 10_000) / 10_000;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 10_000) / 10_000,
  };
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { describeFailure, EngineError, fallbackParams, withRetries } from '@/lib/engine/model';

describe('model boundary', () => {
  it('classifies failures: retry network and 5xx, never auth, refusal-class or bad requests', () => {
    expect(
      describeFailure(new Anthropic.APIConnectionError({ message: 'socket hang up' })),
    ).toMatchObject({ code: 'network', retryable: true });
    expect(
      describeFailure(new Anthropic.RateLimitError(429, {}, 'slow down', new Headers())),
    ).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(
      describeFailure(new Anthropic.InternalServerError(503, {}, 'down', new Headers())),
    ).toMatchObject({ code: 'provider_error', retryable: true });
    expect(
      describeFailure(new Anthropic.BadRequestError(400, {}, 'bad', new Headers())),
    ).toMatchObject({ code: 'bad_request', retryable: false });
    expect(
      describeFailure(new Anthropic.AuthenticationError(401, {}, 'nope', new Headers())),
    ).toMatchObject({ code: 'no_api_key', retryable: false });
    expect(
      // What the SDK throws before any request: a plain Error, not one of its own classes.
      describeFailure(
        new Error('Could not resolve authentication method. Expected one of apiKey…'),
      ),
    ).toMatchObject({ code: 'no_api_key', retryable: false });
    expect(describeFailure(new EngineError('limit_steps', 'too many'))).toMatchObject({
      code: 'limit_steps',
      retryable: false,
    });
    expect(
      describeFailure(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })),
    ).toMatchObject({ code: 'network', retryable: true });
  });
  it('retries twice at most and only retryable failures', async () => {
    let n = 0;
    const retried: number[] = [];
    const out = await withRetries(
      async () => {
        n += 1;
        if (n < 3) throw new Anthropic.APIConnectionError({ message: 'flaky' });
        return 'ok';
      },
      { onRetry: (_f, attempt) => void retried.push(attempt) },
    );
    expect(out).toBe('ok');
    expect(retried).toEqual([1, 2]);
    await expect(
      withRetries(async () => {
        throw new EngineError('refusal', 'no');
      }),
    ).rejects.toThrow('no');
    let hard = 0;
    await expect(
      withRetries(async () => {
        hard += 1;
        throw new Anthropic.APIConnectionError({ message: 'always' });
      }),
    ).rejects.toThrow('always');
    expect(hard).toBe(3);
  }, 15_000);
  it('adds the refusal fallback for every model but Haiku', () => {
    expect(fallbackParams('claude-opus-5-5')).toEqual({
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(fallbackParams('claude-haiku-5-5')).toEqual({});
  });
});

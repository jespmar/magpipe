/**
 * The model boundary of the run engine. One small interface so tests can script responses and
 * so a hosted build could swap providers; the real client is the Anthropic SDK (beta Messages,
 * for the server-side refusal fallback). Retries are the engine's job (visible as events), so
 * the SDK's own are turned off.
 */
import Anthropic from '@anthropic-ai/sdk';

export type ModelParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type ModelMessage = Anthropic.Beta.Messages.BetaMessage;
export type ModelTool = Anthropic.Beta.Messages.BetaToolUnion;
export type ModelMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type ModelContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
export type ModelToolResultParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
export type ModelToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;

export interface ModelClient {
  create(params: ModelParams, signal?: AbortSignal): Promise<ModelMessage>;
}

/** The SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile. */
export function anthropicModelClient(): ModelClient {
  const client = new Anthropic({ maxRetries: 0 });
  return {
    create: (params, signal) => client.beta.messages.create(params, { signal: signal ?? null }),
  };
}

/** Thinking is adaptive by default on the 5.5 family; effort is the depth control. */
export type Effort = NonNullable<Anthropic.Beta.Messages.BetaOutputConfig['effort']>;

/**
 * The server-side refusal fallback (`fallbacks: "default"`): a safety-classifier decline is
 * re-run on the model Anthropic recommends for that category. Haiku 5.5 has no fallback.
 */
export function fallbackParams(model: string): Pick<ModelParams, 'betas' | 'fallbacks'> {
  if (model.startsWith('claude-haiku')) return {};
  return { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
}

export type ModelFailure = { code: string; message: string; retryable: boolean };

/** Network trouble, rate limits and 5xx are retried; refusals, bad requests and auth are not. */
const NO_KEY_MESSAGE =
  'No model credentials: set ANTHROPIC_API_KEY in magpipe.env (File → Open Config File) and restart Magpipe.';

export function describeFailure(err: unknown): ModelFailure {
  // Before any request, the SDK throws a plain Error when no credential source resolves.
  if (err instanceof Error && /authentication method/i.test(err.message)) {
    return { code: 'no_api_key', message: NO_KEY_MESSAGE, retryable: false };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return {
      code: 'no_api_key',
      message: `The model provider rejected the credentials. ${NO_KEY_MESSAGE}`,
      retryable: false,
    };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return {
      code: 'rate_limited',
      message: 'The model provider is rate limiting requests.',
      retryable: true,
    };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return {
      code: 'network',
      message: `Could not reach the model provider: ${err.message}`,
      retryable: true,
    };
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : 0;
    return {
      code: status >= 500 ? 'provider_error' : 'bad_request',
      message: `Model provider answered HTTP ${status}: ${err.message}`,
      retryable: status >= 500,
    };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { code: 'cancelled', message: 'Cancelled', retryable: false };
  }
  const code = (err as { code?: string })?.code;
  if (
    typeof code === 'string' &&
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
  ) {
    return {
      code: 'network',
      message: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }
  return {
    code: (err as { code?: string })?.code ?? 'error',
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}

/** Thrown by the engine with a stable code; `retryable` decides whether the step is retried. */
export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export const RETRY_BACKOFF_MS = [1_000, 3_000];

/**
 * Two retries with backoff for tool and network errors only — never for refusals, validation or
 * limits (spec §7.2). `onRetry` lets the caller log an event per attempt.
 */
export async function withRetries<T>(
  fn: () => Promise<T>,
  opts: {
    signal?: AbortSignal;
    onRetry?: (failure: ModelFailure, attempt: number) => Promise<void> | void;
  } = {},
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const failure =
        err instanceof EngineError
          ? { code: err.code, message: err.message, retryable: err.retryable }
          : describeFailure(err);
      if (!failure.retryable || attempt >= RETRY_BACKOFF_MS.length) throw err;
      await opts.onRetry?.(failure, attempt + 1);
      await sleep(RETRY_BACKOFF_MS[attempt]!, opts.signal);
      attempt += 1;
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const err = new Error('Cancelled');
  err.name = 'AbortError';
  return err;
}

/** The plain text of a response, for summaries and events. */
export function textOf(message: ModelMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

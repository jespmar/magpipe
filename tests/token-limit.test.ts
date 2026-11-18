/**
 * A step's token limit is on the context one model call reached (D56), not on the sum over its
 * calls: each call reads the whole conversation again, so a sum grows with every round however
 * little is added.
 */
import { describe, expect, it } from 'vitest';
import { apiBackend } from '@/lib/engine/backend';
import { spentOf, type ModelClient, type ModelMessage } from '@/lib/engine/model';
import type { ToolRuntime, Trail } from '@/lib/engine/tools';
import type { Agent } from '@/lib/schemas';

const reply = (stop: string, input: number, output: number, server = false): ModelMessage =>
  ({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: stop,
    stop_sequence: null,
    content: [
      ...(server
        ? [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } }]
        : []),
      { type: 'text', text: 'Working.', citations: null },
    ],
    usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0 },
  }) as unknown as ModelMessage;

const runtime: ToolRuntime = {
  tools: [],
  dispatch: new Map(),
  labels: new Map(),
  conventions: [],
  close: async () => {},
};
const trail: Trail = { emit: async () => {} };
const agent = {
  name: 'Reviewer',
  model: 'claude-opus-5-5',
  limits: { maxTokens: 1000, maxSteps: 10, timeoutSec: 60 },
} as Agent;

function client(calls: [string, number, number, boolean?][]): ModelClient {
  let i = 0;
  return { create: async () => reply(...calls[Math.min(i++, calls.length - 1)]!) };
}

describe('the token limit (D56)', () => {
  it('lets a step take many rounds whose context stays under the limit', async () => {
    const backend = apiBackend(
      client([
        ['pause_turn', 400, 100],
        ['pause_turn', 500, 100],
        ['end_turn', 600, 100],
      ]),
    );
    const done = await backend.step(
      { agent, system: 's', user: 'u', runtime, sandboxDir: process.cwd(), trail },
      new AbortController().signal,
    );
    // The usage still counts every call, for the run's record.
    expect(done.usage.inputTokens).toBe(1500);
  });

  it('stops a step whose context passes the limit', async () => {
    const backend = apiBackend(client([['end_turn', 950, 100]]));
    await expect(
      backend.step(
        { agent, system: 's', user: 'u', runtime, sandboxDir: process.cwd(), trail },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'limit_tokens',
      message: 'Reviewer reached 1,050 tokens of context, over its 1,000-token limit.',
    });
  });

  it('keeps what a stopped step spent on its error, for the step and the cap', async () => {
    const backend = apiBackend(
      client([
        ['pause_turn', 400, 100],
        ['end_turn', 950, 100],
      ]),
    );
    const err = await backend
      .step(
        { agent, system: 's', user: 'u', runtime, sandboxDir: process.cwd(), trail },
        new AbortController().signal,
      )
      .catch((e: unknown) => e);
    expect(spentOf(err)).toMatchObject({ inputTokens: 1350, outputTokens: 200 });
  });

  it('does not take a call that ran server tools for one read of the context', async () => {
    // Its usage adds up the searches the API ran inside it: rounds and the cap bound it.
    const backend = apiBackend(client([['end_turn', 3000, 100, true]]));
    const done = await backend.step(
      { agent, system: 's', user: 'u', runtime, sandboxDir: process.cwd(), trail },
      new AbortController().signal,
    );
    expect(done.usage.inputTokens).toBe(3000);
  });
});

/**
 * One step of a run (spec §7.2): the agent's own prompt, the orchestrator's instructions, the
 * results it depends on and the memory it may read; then the tool loop, with every message,
 * tool call, tool result and memory write written to the run's trail, under the agent's limits.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import * as t from '../db/schema';
import type { Agent, Attachment, MemoryEntry, Run, Step, Usage } from '../schemas';
import { addUsage, ZERO_USAGE } from '../pricing';
import { emitEvent } from './events';
import {
  EngineError,
  fallbackParams,
  textOf,
  withRetries,
  type ModelClient,
  type ModelContentBlockParam,
  type ModelMessageParam,
  type ModelToolResultParam,
  type ModelToolUseBlock,
} from './model';
import { memoryText, usageOf } from './plan';
import { setupTools } from './tools';

export type StepOutcome = { summary: string; usage: Usage };

export async function runStep(opts: {
  db: Db;
  client: ModelClient;
  run: Run;
  step: Step;
  agent: Agent;
  /** Results of the steps this one depends on, in plan order. */
  upstream: Step[];
  memory: MemoryEntry[];
  attachments: Attachment[];
  sandboxDir: string;
  signal: AbortSignal;
}): Promise<StepOutcome> {
  const { db, run, step, agent } = opts;
  const emit = (kind: Parameters<typeof emitEvent>[1]['kind'], text: string, payload?: unknown) =>
    emitEvent(db, { runId: run.id, stepId: step.id, agentId: agent.id, kind, text, payload });

  const timeout = AbortSignal.timeout(agent.limits.timeoutSec * 1000);
  const signal = AbortSignal.any([opts.signal, timeout]);
  const readable = opts.memory.filter((e) => agent.memoryScope.read.includes(e.ns));

  const runtime = await withRetries(
    () =>
      setupTools({
        db,
        agent,
        attachments: opts.attachments,
        sandboxDir: opts.sandboxDir,
        signal,
        onRejectedWrite: async (text) => void (await emit('error', text)),
      }),
    { signal, onRetry: (f, n) => void emit('error', `Retry ${n}: ${f.message}`) },
  );

  try {
    const system = [
      agent.systemPrompt || `You are ${agent.name}, ${agent.role}.`,
      '',
      `You are one agent in a run orchestrated by Magpipe. Do the step you are given, use your tools when they help, and finish with a clear written result: what you found or did, and anything the next step must know. Keep it under 1000 characters.`,
      readable.length ? `\nShared memory you may rely on:\n${memoryText(readable)}` : '',
    ].join('\n');

    const context = opts.upstream
      .filter((s) => s.result?.summary)
      .map((s) => `Result of "${s.title}":\n${s.result!.summary}`)
      .join('\n\n');
    const messages: ModelMessageParam[] = [
      {
        role: 'user',
        content: [
          `Task given to Magpipe:\n${run.input.text}`,
          `Your step: ${step.title}\n${step.instructions ?? ''}`,
          context ? `Earlier results:\n${context}` : '',
          opts.attachments.length
            ? `Attached files: ${opts.attachments.map((a) => a.name).join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ];

    let usage = ZERO_USAGE;
    let iterations = 0;
    let finalText = '';
    for (;;) {
      if (iterations >= agent.limits.maxSteps) {
        throw new EngineError(
          'limit_steps',
          `${agent.name} used all ${agent.limits.maxSteps} allowed tool rounds.`,
        );
      }
      iterations += 1;

      const message = await withRetries(
        () =>
          opts.client.create(
            {
              model: agent.model,
              max_tokens: 16_000,
              system,
              messages,
              ...(runtime.tools.length ? { tools: runtime.tools } : {}),
              output_config: { effort: 'high' },
              ...fallbackParams(agent.model),
            },
            signal,
          ),
        { signal, onRetry: (f, n) => void emit('error', `Retry ${n}: ${f.message}`) },
      );
      usage = addUsage(usage, usageOf(message));
      if (usage.inputTokens + usage.outputTokens > agent.limits.maxTokens) {
        throw new EngineError(
          'limit_tokens',
          `${agent.name} exceeded its ${agent.limits.maxTokens}-token limit.`,
        );
      }

      const text = textOf(message);
      if (text) await emit('message', text);
      // Server tools (web search / fetch) show up as blocks; name them in the trail.
      for (const block of message.content) {
        if (block.type === 'server_tool_use') {
          await emit('tool_call', `${block.name}: ${JSON.stringify(block.input).slice(0, 300)}`, {
            tool: block.name,
            input: block.input,
          });
        } else if (
          block.type === 'web_search_tool_result' ||
          block.type === 'web_fetch_tool_result'
        ) {
          const n = Array.isArray(block.content) ? block.content.length : 1;
          await emit(
            'tool_result',
            `${block.type === 'web_search_tool_result' ? 'web_search' : 'web_fetch'}: ${Array.isArray(block.content) ? `${n} results` : 'done'}`,
          );
        }
      }

      if (message.stop_reason === 'refusal') {
        throw new EngineError(
          'refusal',
          `${agent.name} declined this step${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : '.'}`,
        );
      }
      if (message.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: message.content as ModelContentBlockParam[] });
        continue;
      }
      const toolUses = message.content.filter((b): b is ModelToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0 || message.stop_reason === 'end_turn') {
        if (message.stop_reason === 'max_tokens' && toolUses.length) {
          throw new EngineError(
            'max_tokens',
            `${agent.name} ran out of output tokens mid tool call.`,
          );
        }
        finalText = text;
        break;
      }

      messages.push({ role: 'assistant', content: message.content as ModelContentBlockParam[] });
      const results: ModelToolResultParam[] = [];
      for (const use of toolUses) {
        const input = (use.input && typeof use.input === 'object' ? use.input : {}) as Record<
          string,
          unknown
        >;
        const label = runtime.labels.get(use.name) ?? use.name;
        await emit('tool_call', `${label}: ${JSON.stringify(input).slice(0, 300)}`, {
          tool: use.name,
          input,
        });
        const handler = runtime.dispatch.get(use.name);
        let outcome: { text: string; isError?: boolean; memoryWrite?: { ns: string; key: string } };
        if (!handler) outcome = { text: `Unknown tool ${use.name}`, isError: true };
        else {
          try {
            outcome = await handler(input);
          } catch (err) {
            outcome = { text: err instanceof Error ? err.message : String(err), isError: true };
          }
        }
        await emit(
          outcome.isError ? 'error' : 'tool_result',
          `${label} → ${outcome.text.slice(0, 300)}`,
          { tool: use.name, isError: outcome.isError ?? false },
        );
        if (outcome.memoryWrite)
          await emit(
            'memory_write',
            `${outcome.memoryWrite.ns}/${outcome.memoryWrite.key}`,
            outcome.memoryWrite,
          );
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: outcome.text,
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: results });
    }

    const summary = (finalText || `${agent.name} finished without a written result.`).slice(
      0,
      1000,
    );
    return { summary, usage };
  } catch (err) {
    if (timeout.aborted && !opts.signal.aborted) {
      throw new EngineError(
        'timeout',
        `${agent.name} ran past its ${agent.limits.timeoutSec} s limit.`,
      );
    }
    throw err;
  } finally {
    await runtime.close();
  }
}

/** Marks an agent running or idle for the Home and Agents screens; paused agents keep their status. */
export async function setAgentStatus(
  db: Db,
  agentId: string,
  status: 'running' | 'idle',
): Promise<void> {
  await db
    .update(t.agents)
    .set({ status })
    .where(
      and(eq(t.agents.id, agentId), eq(t.agents.status, status === 'running' ? 'idle' : 'running')),
    );
}

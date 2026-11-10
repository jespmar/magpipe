/**
 * The backend seam (D22): how a plan, a step and a merge reach a model. `apiBackend` is the
 * Messages API path the engine always had, with the tool loop; `claudeCodeBackend`
 * (./claude-code.ts) runs the same three operations through the Claude Code installed on the
 * operator's machine. Everything around them (durable plan, fan-out, retries, cancel, resume,
 * limits) stays in the engine.
 */
import type { Agent, Usage } from '../schemas';
import { addUsage, ZERO_USAGE } from '../pricing';
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
import { usageOf } from './plan';
import { invokeTool, type ToolRuntime, type Trail } from './tools';

export type { Trail };

export type PlanRequest = {
  model: string;
  system: string;
  user: string;
  /** JSON Schema the answer must follow. */
  schema: Record<string, unknown>;
};

export type MergeRequest = { model: string; system: string; user: string };

export type StepRequest = {
  agent: Agent;
  system: string;
  user: string;
  /** The step's tools, built by `setupTools`; the backend decides how the model reaches them. */
  runtime: ToolRuntime;
  sandboxDir: string;
  trail: Trail;
};

export type TextResult = { text: string; usage: Usage };
export type StepResult = { summary: string; usage: Usage };

export interface RunBackend {
  readonly name: 'api' | 'claude-code';
  /** The orchestrator's plan as JSON text matching `schema`. */
  plan(req: PlanRequest, signal: AbortSignal): Promise<TextResult>;
  /** One agent step: the model's final written result and what it cost. */
  step(req: StepRequest, signal: AbortSignal): Promise<StepResult>;
  /** The orchestrator's final answer as markdown. */
  merge(req: MergeRequest, signal: AbortSignal): Promise<TextResult>;
}

/** The Messages API backend: structured outputs for the plan, the engine's own tool loop for a step. */
export function apiBackend(client: ModelClient): RunBackend {
  return {
    name: 'api',

    async plan(req, signal) {
      const message = await client.create(
        {
          model: req.model,
          max_tokens: 16_000,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: {
            effort: 'high',
            format: { type: 'json_schema', schema: req.schema },
          },
          ...fallbackParams(req.model),
        },
        signal,
      );
      if (message.stop_reason === 'refusal') {
        throw new EngineError('refusal', 'The orchestrator declined to plan this task.');
      }
      return { text: textOf(message), usage: usageOf(message) };
    },

    async merge(req, signal) {
      const message = await client.create(
        {
          model: req.model,
          max_tokens: 16_000,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: { effort: 'medium' },
          ...fallbackParams(req.model),
        },
        signal,
      );
      return { text: textOf(message), usage: usageOf(message) };
    },

    async step(req, signal) {
      const { agent, runtime, trail } = req;
      const messages: ModelMessageParam[] = [{ role: 'user', content: req.user }];
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
            client.create(
              {
                model: agent.model,
                max_tokens: 16_000,
                system: req.system,
                messages,
                ...(runtime.tools.length ? { tools: runtime.tools } : {}),
                output_config: { effort: 'high' },
                ...fallbackParams(agent.model),
              },
              signal,
            ),
          { signal, onRetry: (f, n) => trail.emit('error', `Retry ${n}: ${f.message}`) },
        );
        usage = addUsage(usage, usageOf(message));
        if (usage.inputTokens + usage.outputTokens > agent.limits.maxTokens) {
          throw new EngineError(
            'limit_tokens',
            `${agent.name} exceeded its ${agent.limits.maxTokens}-token limit.`,
          );
        }

        const text = textOf(message);
        if (text) await trail.emit('message', text);
        // Server tools (web search / fetch) show up as blocks; name them in the trail.
        for (const block of message.content) {
          if (block.type === 'server_tool_use') {
            await trail.emit(
              'tool_call',
              `${block.name}: ${JSON.stringify(block.input).slice(0, 300)}`,
              { tool: block.name, input: block.input },
            );
          } else if (
            block.type === 'web_search_tool_result' ||
            block.type === 'web_fetch_tool_result'
          ) {
            const n = Array.isArray(block.content) ? block.content.length : 1;
            await trail.emit(
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
          messages.push({
            role: 'assistant',
            content: message.content as ModelContentBlockParam[],
          });
          continue;
        }
        const toolUses = message.content.filter(
          (b): b is ModelToolUseBlock => b.type === 'tool_use',
        );
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
          const outcome = await invokeTool(runtime, trail, use.name, input);
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: outcome.text,
            ...(outcome.isError ? { is_error: true } : {}),
          });
        }
        messages.push({ role: 'user', content: results });
      }
      return { summary: finalText, usage };
    },
  };
}

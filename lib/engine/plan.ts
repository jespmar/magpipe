/**
 * The orchestrator (spec §7.1): reads the task, the registry and the relevant memory, and
 * returns a plan as strict JSON through structured outputs. The final merge step is always the
 * orchestrator's own.
 */
import { z } from 'zod';
import type { Agent, MemoryEntry, Run, Step } from '../schemas';
import { costUsd } from '../pricing';
import type { Usage } from '../schemas';
import type { RunBackend } from './backend';
import { EngineError, type ModelMessage } from './model';

export const MERGE_STEP_ID = 'merge';

const planOutput = z.object({
  steps: z.array(
    z.object({
      id: z.string(),
      agent: z.string(),
      title: z.string(),
      instructions: z.string(),
      dependsOn: z.array(z.string()),
      optional: z.boolean(),
    }),
  ),
});

const PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short id like s1, s2 — referenced by dependsOn' },
          agent: { type: 'string', description: 'The agent slug from the registry' },
          title: { type: 'string', description: 'What this step does, in a few words' },
          instructions: {
            type: 'string',
            description:
              'Precise instructions for the agent, including the memory it should rely on',
          },
          dependsOn: { type: 'array', items: { type: 'string' } },
          optional: {
            type: 'boolean',
            description: 'true when the run can still succeed without it',
          },
        },
        required: ['id', 'agent', 'title', 'instructions', 'dependsOn', 'optional'],
        additionalProperties: false,
      },
    },
  },
  required: ['steps'],
  additionalProperties: false,
} as const;

export const ORCHESTRATOR_SYSTEM = `You are Magpipe, the orchestrator of a small fleet of AI agents.
Given a task, the registry of available agents and the relevant shared memory, return a plan.
Rules:
- Prefer the fewest agents that can do the job; give independent steps no dependencies so they run in parallel.
- Every step names exactly one agent by slug from the registry. Never invent an agent.
- Put the facts from shared memory that matter into the instructions of the steps that need them.
- Steps are small and concrete; the merge of results into a final answer is done by you afterwards, so do not add a step for it.
- If no agent fits, return an empty list of steps and the final answer will be written directly.`;

export function usageOf(message: ModelMessage): Usage {
  const u = message.usage;
  return {
    inputTokens:
      u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens,
    costUsd: costUsd(message.model, {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    }),
  };
}

export function registryText(agents: Agent[]): string {
  return agents
    .map(
      (a) =>
        `- ${a.slug} (${a.name}, ${a.role}): ${a.description}\n  model ${a.model}; tools: ${
          [...a.builtins, ...a.tools.map((g) => g.toolId)].join(', ') || 'none'
        }; memory read: ${a.memoryScope.read.join(', ') || 'none'}; write: ${a.memoryScope.write.join(', ') || 'none'}`,
    )
    .join('\n');
}

export function memoryText(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '(nothing relevant in memory)';
  return entries
    .map(
      (e) =>
        `- ${e.ns}/${e.key}: ${e.value} (confidence ${e.confidence.toFixed(2)}, source ${e.source})`,
    )
    .join('\n');
}

export type PlanResult = { steps: Step[]; usage: Usage; summary: string };

export async function planRun(opts: {
  backend: RunBackend;
  model: string;
  run: Run;
  agents: Agent[];
  memory: MemoryEntry[];
  signal: AbortSignal;
}): Promise<PlanResult> {
  const available = opts.agents.filter((a) => a.status !== 'paused');
  const system = `${ORCHESTRATOR_SYSTEM}\n\nAgents available:\n${registryText(available) || '(none)'}\n\nShared memory worth knowing:\n${memoryText(opts.memory)}`;
  const attachments = opts.run.input.attachments.map((a) => a.name).join(', ');
  const user = `Task:\n${opts.run.input.text}${attachments ? `\n\nAttached files: ${attachments}` : ''}`;

  const { text, usage } = await opts.backend.plan(
    {
      model: opts.model,
      system,
      user,
      schema: PLAN_JSON_SCHEMA as unknown as Record<string, unknown>,
    },
    opts.signal,
  );
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EngineError('plan_invalid', 'The orchestrator did not return a JSON plan.', true);
  }
  const parsed = planOutput.safeParse(json);
  if (!parsed.success) {
    throw new EngineError(
      'plan_invalid',
      `The plan did not match the schema: ${parsed.error.issues[0]?.message}`,
      true,
    );
  }

  const ids = new Set(parsed.data.steps.map((s) => s.id));
  if (ids.size !== parsed.data.steps.length || ids.has(MERGE_STEP_ID)) {
    throw new EngineError('plan_invalid', 'Step ids must be unique and may not be "merge".', true);
  }
  const steps: Step[] = [];
  for (const s of parsed.data.steps) {
    const agent = available.find((a) => a.slug === s.agent);
    if (!agent)
      throw new EngineError(
        'plan_invalid',
        `The plan names an unknown or paused agent: ${s.agent}`,
        true,
      );
    if (s.dependsOn.some((d) => !ids.has(d) || d === s.id)) {
      throw new EngineError(
        'plan_invalid',
        `Step ${s.id} depends on a step that does not exist.`,
        true,
      );
    }
    steps.push({
      id: s.id,
      agentId: agent.id,
      title: s.title,
      instructions: s.instructions,
      dependsOn: s.dependsOn,
      ...(s.optional ? { optional: true } : {}),
      status: 'todo',
    });
  }
  assertAcyclic(steps);
  const leaves = steps
    .filter((s) => !steps.some((o) => o.dependsOn.includes(s.id)))
    .map((s) => s.id);
  steps.push({
    id: MERGE_STEP_ID,
    agentId: null,
    title: 'Merge results',
    dependsOn: leaves,
    status: 'todo',
  });

  const named = steps
    .filter((s) => s.agentId)
    .map((s) => `${opts.agents.find((a) => a.id === s.agentId)?.name ?? s.agentId}: ${s.title}`);
  const summary =
    named.length === 0
      ? 'Answering directly'
      : named.length === 1
        ? `Route to ${named[0]}`
        : `Split into ${named.length} steps — ${named.join('; ')}`;
  return { steps, usage, summary };
}

function assertAcyclic(steps: Step[]): void {
  const state = new Map<string, 0 | 1 | 2>();
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visit = (id: string) => {
    const seen = state.get(id) ?? 0;
    if (seen === 1) throw new EngineError('plan_invalid', 'The plan has a dependency cycle.', true);
    if (seen === 2) return;
    state.set(id, 1);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    state.set(id, 2);
  };
  for (const s of steps) visit(s.id);
}

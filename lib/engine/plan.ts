/**
 * The orchestrator (spec §7.1): reads the task, the registry and the relevant memory, and
 * returns a plan as strict JSON through structured outputs. The final merge step is always the
 * orchestrator's own.
 */
import { z } from 'zod';
import type { Agent, MemoryEntry, Run, Step, Tool, ToolGrant, ToolStatus } from '../schemas';
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
- Give a step to an agent whose built-in tools and servers can do it. A server marked not reachable or needs auth will not answer.
- An agent that waits for approval pauses the run after its steps until the operator approves; plan the work that builds on its result as later steps in the same plan.
- An agent that may send work back reviews the steps it depends on: make it depend directly on the steps whose work it judges.
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

/** What the planner is told about a registry tool: its name and whether it answers. */
export type RegistryTool = Pick<Tool, 'id' | 'name' | 'status'>;

/** Tool names past this many are counted, not listed, so one large server cannot flood the plan. */
export const REGISTRY_TOOL_CAP = 20;

const STATUS_NOTE: Record<ToolStatus, string> = {
  connected: '',
  needs_auth: ', needs auth',
  error: ', not reachable',
};

// Server tool names come from the server. Only plain identifiers reach the planner's prompt; the
// rest are counted, so a server cannot write instructions into the plan through a tool's name.
const PLAIN_NAME = /^[A-Za-z0-9_.:/-]{1,64}$/;

/** "Repository files (read_text_file, write_file)": one granted server as the planner reads it. */
export function grantText(grant: ToolGrant, tool: RegistryTool): string {
  const plain = grant.scopes.filter((s) => PLAIN_NAME.test(s));
  const shown = plain.slice(0, REGISTRY_TOOL_CAP);
  const hidden = grant.scopes.length - shown.length;
  const name =
    tool.name
      .replace(/[\s;()]+/g, ' ')
      .trim()
      .slice(0, 64) || 'Unnamed server';
  const list = [...shown, ...(hidden > 0 ? [`and ${hidden} more`] : [])].join(', ');
  return `${name}${STATUS_NOTE[tool.status]} (${list})`;
}

/**
 * The orchestrator's registry: per agent its routing copy, model, built-in tools, the servers it
 * may use with the tools granted on each, and its memory scope. An empty grant allows no tools
 * (D25) and a grant to a tool that no longer exists allows nothing, so neither is listed.
 */
export function registryText(agents: Agent[], tools: readonly RegistryTool[]): string {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  return agents
    .map((a) => {
      const servers = a.tools.flatMap((g) => {
        const tool = byId.get(g.toolId);
        return tool && g.scopes.length > 0 ? [grantText(g, tool)] : [];
      });
      return [
        `- ${a.slug} (${a.name}, ${a.role}): ${a.description}`,
        `  model: ${a.model}`,
        `  built-in tools: ${a.builtins.join(', ') || 'none'}`,
        `  servers: ${servers.join('; ') || 'none'}`,
        ...(a.pauseAfter ? ['  waits for approval: the run pauses after its steps'] : []),
        ...(a.sendBackRounds > 0
          ? [
              `  may send work back: up to ${a.sendBackRounds} ${a.sendBackRounds === 1 ? 'time' : 'times'}, to the steps it depends on`,
            ]
          : []),
        `  memory read: ${a.memoryScope.read.join(', ') || 'none'}; write: ${a.memoryScope.write.join(', ') || 'none'}`,
      ].join('\n');
    })
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
  /** The registry's tools, so the planner sees each grant by name. */
  tools: readonly RegistryTool[];
  memory: MemoryEntry[];
  /** Earlier turns of the conversation this run continues, as prompt text; empty for a fresh task. */
  conversation?: string;
  signal: AbortSignal;
}): Promise<PlanResult> {
  const available = opts.agents.filter((a) => a.status !== 'paused');
  const system = `${ORCHESTRATOR_SYSTEM}\n\nAgents available:\n${registryText(available, opts.tools) || '(none)'}\n\nShared memory worth knowing:\n${memoryText(opts.memory)}${
    opts.conversation
      ? `\n\nThe operator is continuing a conversation. Earlier turns, oldest first:\n${opts.conversation}\n\nThe task below is the next turn; read it in that light.`
      : ''
  }`;
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

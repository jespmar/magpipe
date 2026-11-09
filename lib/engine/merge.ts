/** The orchestrator's last move (spec §7.1): compose the run's output from the steps' results. */
import type { Run, Step, Usage } from '../schemas';
import { fallbackParams, textOf, type ModelClient } from './model';
import { usageOf } from './plan';

export async function mergeRun(opts: {
  client: ModelClient;
  model: string;
  run: Run;
  steps: Step[];
  agentNames: Map<string, string>;
  signal: AbortSignal;
}): Promise<{ markdown: string; usage: Usage }> {
  const done = opts.steps.filter((s) => s.agentId && s.status === 'done' && s.result?.summary);
  const failed = opts.steps.filter((s) => s.agentId && s.status === 'failed');
  const results = done
    .map(
      (s) => `### ${opts.agentNames.get(s.agentId!) ?? 'Agent'} — ${s.title}\n${s.result!.summary}`,
    )
    .join('\n\n');
  const failures = failed.map((s) => `- ${s.title}: ${s.error?.message ?? 'failed'}`).join('\n');

  const system = `You are Magpipe, the orchestrator. Write the final answer to the operator's task in Markdown: lead with the outcome, keep it tight, keep every concrete fact and number the agents reported, and name what did not get done. Do not invent results.`;
  const user = done.length
    ? `Task:\n${opts.run.input.text}\n\nWhat the agents reported:\n\n${results}${failures ? `\n\nSteps that did not finish:\n${failures}` : ''}`
    : `Task:\n${opts.run.input.text}\n\nNo agent was involved; answer the task yourself.${failures ? `\n\nSteps that did not finish:\n${failures}` : ''}`;

  const message = await opts.client.create(
    {
      model: opts.model,
      max_tokens: 16_000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'medium' },
      ...fallbackParams(opts.model),
    },
    opts.signal,
  );
  const markdown =
    textOf(message) || (results ? `## ${opts.run.input.text}\n\n${results}` : 'No output.');
  return { markdown, usage: usageOf(message) };
}

/** The orchestrator's last move (spec §7.1): compose the run's output from the steps' results. */
import { workFacts } from '../work';
import type { Run, Step, Usage } from '../schemas';
import type { RunBackend } from './backend';

export async function mergeRun(opts: {
  backend: RunBackend;
  model: string;
  run: Run;
  steps: Step[];
  agentNames: Map<string, string>;
  /** Earlier turns of the conversation this run continues, as prompt text. */
  conversation?: string;
  signal: AbortSignal;
}): Promise<{ markdown: string; usage: Usage }> {
  const done = opts.steps.filter((s) => s.agentId && s.status === 'done' && s.result?.summary);
  const failed = opts.steps.filter((s) => s.agentId && s.status === 'failed');
  // Each report, then what Magpipe saw the step's tools do (D29): the answer may rely on those.
  const results = done
    .map((s) => {
      const facts = workFacts(s.work);
      return `### ${opts.agentNames.get(s.agentId!) ?? 'Agent'} — ${s.title}\n${s.result!.summary}${
        facts.length ? `\nRecorded by Magpipe:\n${facts.map((f) => `- ${f}`).join('\n')}` : ''
      }`;
    })
    .join('\n\n');
  const failures = failed.map((s) => `- ${s.title}: ${s.error?.message ?? 'failed'}`).join('\n');

  const system = `You are Magpipe, the orchestrator. Write the final answer to the operator's task in Markdown: lead with the outcome, keep it tight, keep every concrete fact and number the agents reported, and name what did not get done. Do not invent results.`;
  const before = opts.conversation ? `Earlier in this conversation:\n${opts.conversation}\n\n` : '';
  const user = done.length
    ? `${before}Task:\n${opts.run.input.text}\n\nWhat the agents reported:\n\n${results}${failures ? `\n\nSteps that did not finish:\n${failures}` : ''}`
    : `${before}Task:\n${opts.run.input.text}\n\nNo agent was involved; answer the task yourself.${failures ? `\n\nSteps that did not finish:\n${failures}` : ''}`;

  const { text, usage } = await opts.backend.merge(
    { model: opts.model, system, user },
    opts.signal,
  );
  const markdown = text || (results ? `## ${opts.run.input.text}\n\n${results}` : 'No output.');
  return { markdown, usage };
}

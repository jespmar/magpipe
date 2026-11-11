/**
 * A scripted stand-in for the model, for development and end-to-end tests without credentials
 * (`MAGPIPE_MODEL_STUB=scripted`, never in production). It plans one step for the first agent in
 * the registry, answers the step with a line of text (a short spec when the step writes a
 * document) and merges a short markdown result, so a run goes queued → running → done through
 * the real engine, events and screens.
 */
import type { ModelClient, ModelMessage, ModelParams } from './model';

const DELAY_MS = 250;

function message(text: string): ModelMessage {
  return {
    id: `msg_stub_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: 'scripted',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text, citations: null }],
    usage: { input_tokens: 120, output_tokens: 40 },
  } as unknown as ModelMessage;
}

function systemText(params: ModelParams): string {
  if (typeof params.system === 'string') return params.system;
  if (Array.isArray(params.system)) {
    return params.system.map((b) => ('text' in b ? b.text : '')).join('\n');
  }
  return '';
}

function lastUserText(params: ModelParams): string {
  for (let i = params.messages.length - 1; i >= 0; i--) {
    const m = params.messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    return m.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * The agent to plan for, from the orchestrator's registry text (`- slug (Name, role): …` then
 * indented lines, one of them `servers: …`): the first agent with no servers (the stub never
 * calls a tool server), else the first agent at all.
 */
export function pickRegistrySlug(text: string): string | null {
  const entries = text.split(/^(?=- [a-z0-9-]+ \()/m).filter((e) => e.startsWith('- '));
  const slugOf = (entry: string) => /^- ([a-z0-9-]+) \(/.exec(entry)?.[1] ?? null;
  const toolFree = entries.find((e) => /^ {2}servers: none$/m.test(e));
  return slugOf(toolFree ?? entries[0] ?? '');
}

export function scriptedModelClient(): ModelClient {
  return {
    async create(params, signal) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      const system = systemText(params);
      const user = lastUserText(params);
      if (params.output_config?.format) {
        const slug = pickRegistrySlug(user) ?? pickRegistrySlug(system) ?? 'researcher';
        const entry = system
          .split(/^(?=- [a-z0-9-]+ \()/m)
          .find((e) => e.startsWith(`- ${slug} (`));
        const waits = entry ? /^ {2}waits for approval:/m.test(entry) : false;
        return message(
          JSON.stringify({
            steps: [
              {
                id: 's1',
                agent: slug,
                title: 'Answer the task',
                instructions: 'Answer the task in one short paragraph.',
                dependsOn: [],
                optional: false,
              },
              // After an agent that waits for approval, a step that builds on its result (D30).
              ...(waits
                ? [
                    {
                      id: 's2',
                      agent: slug,
                      title: 'Carry on after approval',
                      instructions: 'Build on the approved answer in one line.',
                      dependsOn: ['s1'],
                      optional: false,
                    },
                  ]
                : []),
            ],
          }),
        );
      }
      if (system.includes('final answer')) {
        return message(
          [
            '## Result',
            '',
            'Merged by the scripted model: the one step answered the task in a line.',
            '',
            '- No tools were called and nothing was written to memory.',
          ].join('\n'),
        );
      }
      // A step whose result is a document (a factory spec, D37) hands one over.
      if (system.includes('Your result is a document')) {
        return message(
          [
            '# Scripted spec',
            '',
            '## Problem',
            '',
            'Written by the scripted model from the task. It stands in for the spec a Spec Builder writes: the problem as the operator described it, who has it, and what it costs them today, with the paths in the repository where it shows.',
            '',
            '## Outcome',
            '',
            'The task is done, and a person who reads only this section knows what changed for them. The outcome names the screen, the command or the file where the change can be seen, and nothing about how it was built.',
            '',
            '## Acceptance criteria',
            '',
            '1. A test checks it.',
            '',
            '## Not in scope',
            '',
            'Anything else.',
            '',
            '## Constraints',
            '',
            'None found.',
            '',
            '## Assumptions and open questions',
            '',
            'None.',
          ].join('\n'),
        );
      }
      // A reviewer that owes a verdict line (D38) passes the work.
      if (system.includes('"Verdict: pass"')) {
        return message('Verdict: pass\n\n- Every checklist item holds in the scripted review.');
      }
      return message('Scripted answer: the task was read and answered in one line.');
    },
  };
}

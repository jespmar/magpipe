/**
 * One step of a run (spec §7.2): the agent's own prompt, the orchestrator's instructions, the
 * results it depends on, the memory it may read and the conventions of the repositories it can
 * reach (D34); then the backend runs the model with the step's tools, writing every message,
 * tool call, tool result and memory write to the run's trail, under the agent's limits.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import * as t from '../db/schema';
import {
  DOCUMENT_CAP,
  type Agent,
  type Attachment,
  type Goal,
  type MemoryEntry,
  type Run,
  type Step,
  type Usage,
} from '../schemas';
import type { RunBackend } from './backend';
import { emitEvent } from './events';
import { EngineError, withRetries } from './model';
import { memoryText } from './plan';
import { setupTools, type StepConventions, type Trail } from './tools';
import { CONVENTIONS_CAP } from '../repo';
import { resumeNote, workFacts, type WorkItem } from '../work';

/** `document` is set when the step writes one (D37): its whole result, up to DOCUMENT_CAP. */
export type StepOutcome = { summary: string; usage: Usage; document?: string };

/** The 1000-character summary of a document: its opening, cut at a line where one fits. */
export function documentSummary(text: string, cap = 1000): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, cap - 1);
  const cut = head.lastIndexOf('\n');
  return `${(cut > cap / 2 ? head.slice(0, cut) : head).trimEnd()}…`;
}

/** What the step must finish with: a short result, or the whole document (D37). */
function resultRule(step: Step): string {
  if (step.recordsGoals) {
    return `You are one agent in a run orchestrated by Magpipe. Do the step you are given and use your tools when they help. Your result is the goals: record them with the record_goals tool until Magpipe accepts them, then finish with a short summary under 1000 characters. Magpipe hands the goals themselves to the steps after yours.`;
  }
  return step.writesDocument
    ? `You are one agent in a run orchestrated by Magpipe. Do the step you are given and use your tools when they help. Your result is a document: finish with the whole document in Markdown and nothing after it. The steps after yours read all of it, and the operator receives it.`
    : `You are one agent in a run orchestrated by Magpipe. Do the step you are given, use your tools when they help, and finish with a clear written result: what you found or did, and anything the next step must know. Keep it under 1000 characters.`;
}

export async function runStep(opts: {
  db: Db;
  backend: RunBackend;
  run: Run;
  step: Step;
  agent: Agent;
  /** Results of the steps this one depends on, in plan order. */
  upstream: Step[];
  memory: MemoryEntry[];
  attachments: Attachment[];
  sandboxDir: string;
  /** Earlier turns of the conversation this run continues, as prompt text. */
  conversation?: string;
  /** Collects what repository tools do in this step (D29); the caller keeps it, done or failed. */
  work?: WorkItem[];
  /** Offers the send_back tool while rounds remain (D31); the caller reads `findings`. */
  sendBack?: { remaining: number; findings?: string };
  /** Offers the record_goals tool (D39); the caller reads `goals`. */
  recordGoals?: { criteria: number[] | null; goals?: Goal[] };
  /** Repository folders (and scripts) this run works in instead of the bound ones (D41, D45). */
  repoPaths?: Record<string, { path: string; scripts?: string[] }>;
  /** What the operator wrote about the factory project this run belongs to (D45). */
  projectContext?: string;
  /** Saves the record onto the step as it grows, so a restart keeps it (D33). */
  onWork?: (work: readonly WorkItem[]) => Promise<void>;
  signal: AbortSignal;
}): Promise<StepOutcome> {
  const { db, run, step, agent } = opts;
  const trail: Trail = {
    emit: async (kind, text, payload) => {
      await emitEvent(db, {
        runId: run.id,
        stepId: step.id,
        agentId: agent.id,
        kind,
        text,
        payload,
      });
    },
  };

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
        onRejectedWrite: (text) => trail.emit('error', text),
        onToolUnavailable: (text) => trail.emit('error', text),
        work: opts.work,
        sendBack: opts.sendBack,
        recordGoals: opts.recordGoals,
        repoPaths: opts.repoPaths,
        onWork: opts.onWork,
      }),
    { signal, onRetry: (f, n) => trail.emit('error', `Retry ${n}: ${f.message}`) },
  );

  try {
    const system = [
      agent.systemPrompt || `You are ${agent.name}, ${agent.role}.`,
      '',
      resultRule(step),
      opts.projectContext ? `\nAbout the project you are working on:\n${opts.projectContext}` : '',
      readable.length ? `\nShared memory you may rely on:\n${memoryText(readable)}` : '',
      runtime.conventions.length ? `\n${conventionsText(runtime.conventions)}` : '',
    ].join('\n');

    // Each earlier result, then what Magpipe saw its tools do: the branch, the files, the checks.
    const context = opts.upstream
      .filter((s) => s.result?.summary)
      .map((s) => {
        // A document is handed on whole (D37); the summary is only its opening.
        if (s.document) return `Document written by "${s.title}", in full:\n${s.document}`;
        const facts = workFacts(s.work);
        // The operator approved this result before your step could start (D30).
        const approval = s.approvedAt
          ? `\nThe operator approved this${s.approvalNote ? ` with a note: ${s.approvalNote}` : '.'}`
          : '';
        return `Result of "${s.title}":\n${s.result!.summary}${
          facts.length ? `\nRecorded by Magpipe:\n${facts.map((f) => `- ${f}`).join('\n')}` : ''
        }${approval}`;
      })
      .join('\n\n');
    const user = [
      opts.conversation ? `Earlier in this conversation:\n${opts.conversation}` : '',
      `Task given to Magpipe:\n${run.input.text}`,
      `Your step: ${step.title}\n${step.instructions ?? ''}`,
      // A step that was sent back runs again with what it must address (D31).
      step.feedback ? `Round ${step.round ?? 2}. ${step.feedback}` : '',
      // The draft this step revises: its own from the last round, or the run it follows up.
      step.writesDocument && step.document
        ? `The document so far. Revise it; your result replaces it:\n${step.document}`
        : step.recordsGoals && step.document
          ? `The goals so far. Revise them, and record the whole set again with record_goals:\n${step.document}`
          : '',
      resumeNote(step) ?? '',
      context ? `Earlier results:\n${context}` : '',
      opts.attachments.length
        ? `Attached files: ${opts.attachments.map((a) => a.name).join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const outcome = await opts.backend.step(
      { agent, system, user, runtime, sandboxDir: opts.sandboxDir, trail },
      signal,
    );
    const text = outcome.summary || `${agent.name} finished without a written result.`;
    if (step.writesDocument && outcome.summary.trim()) {
      const document = outcome.summary.trim().slice(0, DOCUMENT_CAP);
      return { summary: documentSummary(document), usage: outcome.usage, document };
    }
    return { summary: text.slice(0, 1000), usage: outcome.usage };
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

/**
 * The repositories' own instructions for the step's system prompt (D34). Steps load no settings
 * of their own (D22), so each file reaches the prompt here, once, under the names of the
 * repository tools bound to its work tree.
 */
export function conventionsText(list: readonly StepConventions[]): string {
  if (list.length === 0) return '';
  const files = list.map((c) => {
    const names = [...c.repos].sort((a, b) => a.localeCompare(b));
    const who =
      names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    const cut = c.cut
      ? `\n[Cut here: only the first ${CONVENTIONS_CAP.toLocaleString('en-US')} characters of ${c.name} are shown.]`
      : '';
    return `Conventions of ${who} (${names.length === 1 ? 'its' : 'their'} ${c.name}):\n${c.text}${cut}`;
  });
  return [
    'The repositories you can reach keep these instructions for anyone who works in them. Follow them where they apply to your step.',
    ...files,
  ].join('\n\n');
}

/**
 * Moves an agent between idle, waiting (for a repository another step is changing, D28) and
 * running. A paused agent is never touched, and waiting never hides a step that is running.
 */
const STATUS_FROM: Record<'running' | 'waiting' | 'idle', Agent['status'][]> = {
  running: ['idle', 'waiting'],
  waiting: ['idle'],
  idle: ['running', 'waiting'],
};

export async function setAgentStatus(
  db: Db,
  agentId: string,
  status: 'running' | 'waiting' | 'idle',
): Promise<void> {
  await db
    .update(t.agents)
    .set({ status })
    .where(and(eq(t.agents.id, agentId), inArray(t.agents.status, STATUS_FROM[status])));
}

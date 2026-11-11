/**
 * The software factory, phase 1 (D37): lib/factory.ts mirrors docs/factory.md; loading it onto a
 * real git repository creates nine template-only agents with their grants, beside the flock and
 * without touching it; a spec template run skips planning, keeps the spec whole, sends it back
 * once and answers with the spec and the review, with no model call to merge.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { updateAgent } from '@/lib/agents';
import { Engine } from '@/lib/engine';
import { listEvents } from '@/lib/engine/events';
import { documentAnswer } from '@/lib/engine/merge';
import type { ModelClient, ModelMessage, ModelParams } from '@/lib/engine/model';
import { documentSummary } from '@/lib/engine/step';
import {
  FACTORY_AGENTS,
  FACTORY_TEMPLATES,
  FactoryNotReadyError,
  FactoryValidationError,
  loadFactory,
  missingAgents,
  runDocument,
  summarizeFactory,
  templatePlan,
  type FactoryResult,
  type TemplateStep,
} from '@/lib/factory';
import { loadFlock } from '@/lib/flock';
import { createRun, getRun } from '@/lib/runs';
import type { Step } from '@/lib/schemas';

// ─── docs/factory.md, parsed ──────────────────────────────────────────────

const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'factory.md'), 'utf8');
const mdLines = md.split('\n');

/** The lines under `### <name>`, up to the next heading. */
function section(name: string): string {
  const start = mdLines.indexOf(`### ${name}`);
  if (start === -1) throw new Error(`docs/factory.md has no section ${name}`);
  let end = start + 1;
  while (end < mdLines.length && !/^#{2,3} /.test(mdLines[end]!)) end++;
  return mdLines.slice(start + 1, end).join('\n');
}

/** `- **Role:** text`, with indented continuation lines joined by a space. */
function bullet(text: string, label: string): string {
  const lines = text.split('\n');
  const prefix = `- **${label}:** `;
  const i = lines.findIndex((l) => l.startsWith(prefix));
  if (i === -1) throw new Error(`No ${label} bullet`);
  const parts = [lines[i]!.slice(prefix.length)];
  for (let j = i + 1; j < lines.length && /^ {2}\S/.test(lines[j]!); j++) {
    parts.push(lines[j]!.trim());
  }
  return parts.join(' ');
}

/** The rows of the table with these first two header cells inside `### <name>`. */
function tableIn(name: string, first: string, second: string): string[][] {
  const lines = section(name).split('\n');
  const cells = (line: string) =>
    line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
  const header = lines.findIndex(
    (l) => l.startsWith('|') && cells(l)[0] === first && cells(l)[1] === second,
  );
  if (header === -1) throw new Error(`No table with ${first} | ${second} under ${name}`);
  const rows: string[][] = [];
  for (let i = header + 2; i < lines.length && lines[i]!.startsWith('|'); i++) {
    rows.push(cells(lines[i]!));
  }
  return rows;
}

/** The rows of the table whose header has these first two cells. */
function table(first: string, second: string): string[][] {
  const cells = (line: string) =>
    line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
  const header = mdLines.findIndex(
    (l) => l.startsWith('|') && cells(l)[0] === first && cells(l)[1] === second,
  );
  if (header === -1) throw new Error(`No table with ${first} | ${second}`);
  const rows: string[][] = [];
  for (let i = header + 2; i < mdLines.length && mdLines[i]!.startsWith('|'); i++) {
    rows.push(cells(mdLines[i]!));
  }
  return rows;
}

const list = (cell: string) =>
  cell === 'none'
    ? []
    : cell
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
const code = (cell: string) => Array.from(cell.matchAll(/`([a-z_-]+)`/g), (m) => m[1]!);
const ROUNDS: Record<string, number> = { never: 0, once: 1, twice: 2 };

describe('lib/factory.ts mirrors docs/factory.md', () => {
  it('has the nine agents of the pipeline, in the order of the agents table', () => {
    const designed = table('Agent', 'Reads').map((r) => r[0]);
    expect(designed).toEqual(FACTORY_AGENTS.map((a) => a.name));
    expect(table('Agent', 'Slug').map((r) => r[0])).toEqual(designed);
  });

  it('the roster table: slug, model, built-ins, memory, limits, send-backs', () => {
    for (const row of table('Agent', 'Slug')) {
      const [name, slug, model, builtins, memory, limits, rounds] = row as [string, ...string[]];
      const agent = FACTORY_AGENTS.find((a) => a.name === name)!;
      expect(code(slug!), name).toEqual([agent.slug]);
      expect(agent.model, name).toBe(model);
      expect(agent.builtins, name).toEqual(list(builtins!));
      const [read, write] = memory!.split(' / ');
      expect(agent.memoryScope, name).toEqual({ read: list(read!), write: list(write!) });
      const [maxTokens, maxSteps, timeoutSec] = limits!
        .split(' / ')
        .map((n) => Number(n.replace(/\s/g, '')));
      expect(agent.limits, name).toEqual({ maxTokens, maxSteps, timeoutSec });
      expect(agent.sendBackRounds, name).toBe(ROUNDS[rounds!]);
    }
  });

  it('the models match the pipeline’s agents table', () => {
    for (const row of table('Agent', 'Reads')) {
      const agent = FACTORY_AGENTS.find((a) => a.name === row[0])!;
      expect(agent.model, agent.name).toBe(row.at(-1));
    }
  });

  it('the grants table: operations on the repository', () => {
    const rows = table('Agent', 'App (repository)');
    expect(rows.map((r) => r[0])).toEqual(FACTORY_AGENTS.map((a) => a.name));
    for (const [name, app] of rows as [string, string][]) {
      const agent = FACTORY_AGENTS.find((a) => a.name === name)!;
      expect([...agent.grants.app].sort(), name).toEqual(code(app).sort());
    }
  });

  for (const agent of FACTORY_AGENTS) {
    it(`${agent.name}: the fenced prompt, role and description, verbatim`, () => {
      const text = section(agent.name);
      const prompt = /```text\n([\s\S]*?)\n```/.exec(text)?.[1];
      expect(agent.systemPrompt).toBe(prompt);
      expect(agent.role).toBe(bullet(text, 'Role'));
      expect(agent.description).toBe(bullet(text, 'Description'));
    });
  }

  it('every agent runs only from a template and never pauses the run', () => {
    for (const agent of FACTORY_AGENTS) {
      expect(agent.templateOnly, agent.name).toBe(true);
      expect(agent.pauseAfter, agent.name).toBe(false);
    }
  });

  for (const template of Object.values(FACTORY_TEMPLATES)) {
    it(`the ${template.id} template: steps, agents, titles, dependencies, instructions`, () => {
      const rows = tableIn(template.name, 'Step', 'Agent');
      expect(rows).toEqual(
        template.steps.map((s: TemplateStep) => [
          `\`${s.id}\``,
          s.agent ? FACTORY_AGENTS.find((a) => a.slug === s.agent)!.name : 'Magpipe',
          s.title,
          s.dependsOn.map((d) => `\`${d}\``).join(', ') || 'none',
          s.writesDocument || s.recordsGoals ? 'yes' : 'no',
          s.judges ? 'yes' : 'no',
          s.when === 'linear'
            ? 'Linear is set up'
            : s.when === 'github'
              ? 'GitHub is set up'
              : 'always',
          s.instructions,
        ]),
      );
      expect(section(template.name)).toContain(
        `The hand-over step is titled "${template.handOver}".`,
      );
    });
  }
});

// ─── loading it ────────────────────────────────────────────────────────────

let dir: string;
let repo: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-factory-'));
  repo = path.join(dir, 'app');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'app', scripts: { typecheck: 'node -e 0', test: 'node -e 0' } }),
  );
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('loadFactory', () => {
  let db: Db;
  let close: () => Promise<void>;
  let first: FactoryResult;

  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
  }, 30_000);
  afterAll(() => close());

  it('refuses before it is loaded, saying where to load it', async () => {
    expect(await missingAgents(db, 'spec')).toEqual(['Spec Builder', 'Spec Review']);
    const err = await templatePlan(db, 'spec').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FactoryNotReadyError);
    expect((err as Error).message).toBe(
      'The software factory is not loaded: Spec Builder and Spec Review are missing. Load it in Settings, then send it again.',
    );
  });

  it('refuses a folder or scripts it cannot use, and writes nothing', async () => {
    const before = (await db.select().from(t.agents)).length;
    const refused = async (opts: { path: string; scripts: string[] }) =>
      (await loadFactory(db, opts).catch((e: unknown) => e)) as FactoryValidationError;
    expect(await refused({ path: repo, scripts: [] })).toMatchObject({
      field: 'scripts',
      message: 'Name at least one script, such as test: the Test Agent runs the checks.',
    });
    expect(await refused({ path: repo, scripts: ['lint'] })).toMatchObject({
      field: 'scripts',
      message: 'package.json has no script named lint. It has typecheck, test.',
    });
    expect(await refused({ path: dir, scripts: ['test'] })).toBeInstanceOf(FactoryValidationError);
    expect((await db.select().from(t.agents)).length).toBe(before);
  });

  it('creates the nine agents, template-only, with grants on the one repository', async () => {
    first = await loadFactory(db, { path: repo, scripts: ['typecheck', 'test'] });
    expect(first.agents).toEqual(FACTORY_AGENTS.map((a) => ({ name: a.name, outcome: 'created' })));
    expect(first.tools).toEqual([{ name: 'app', outcome: 'created' }]);
    const [tool] = await db.select().from(t.tools).where(eq(t.tools.name, 'app'));
    for (const def of FACTORY_AGENTS) {
      const [row] = await db.select().from(t.agents).where(eq(t.agents.slug, def.slug));
      expect(row, def.name).toMatchObject({
        name: def.name,
        initials: def.initials,
        model: def.model,
        templateOnly: true,
        sendBackRounds: def.sendBackRounds,
        tools: [{ toolId: tool!.id, scopes: expect.any(Array) }],
      });
      expect([...row!.tools[0]!.scopes].sort()).toEqual([...def.grants.app].sort());
    }
    expect(summarizeFactory(first)[0]).toEqual({
      label: 'Agents',
      text: `Created ${FACTORY_AGENTS.slice(0, -1)
        .map((a) => a.name)
        .join(', ')} and Merge Agent.`,
    });
  });

  it('changes nothing the second time, and shares the folder with the flock', async () => {
    const again = await loadFactory(db, { path: repo, scripts: ['typecheck', 'test'] });
    expect(again.agents.every((a) => a.outcome === 'unchanged')).toBe(true);
    expect(again.tools).toEqual([{ name: 'app', outcome: 'unchanged' }]);

    const flock = await loadFlock(db, { path: repo, scripts: ['typecheck', 'test'] });
    expect(flock.tools[0]).toEqual({ name: 'app', role: 'app', outcome: 'unchanged' });
    const third = await loadFactory(db, { path: repo, scripts: ['typecheck', 'test'] });
    expect(third.agents.every((a) => a.outcome === 'unchanged')).toBe(true);
    const [coder] = await db.select().from(t.agents).where(eq(t.agents.slug, 'coder'));
    expect(coder!.templateOnly).toBe(false);
  });

  it('builds the spec plan, seeds a draft, and names a paused agent', async () => {
    const { plan, text } = await templatePlan(db, 'spec', { draft: '# Old spec' });
    expect(text).toBe(
      'From the spec template: Spec Builder: Write the spec; Spec Review: Review the spec',
    );
    expect(plan.map((s) => [s.id, s.title, s.dependsOn])).toEqual([
      ['spec', 'Write the spec', []],
      ['review', 'Review the spec', ['spec']],
      ['merge', 'Hand over the spec', ['review']],
    ]);
    expect(plan[0]).toMatchObject({ writesDocument: true, document: '# Old spec' });
    expect(plan[1]!.document).toBeUndefined();

    const [review] = await db.select().from(t.agents).where(eq(t.agents.slug, 'spec-review'));
    await updateAgent(db, review!.id, { status: 'paused' });
    await expect(templatePlan(db, 'spec')).rejects.toThrow(
      'Spec Review is paused. Resume it on Agents, then send it again.',
    );
    await updateAgent(db, review!.id, { status: 'idle' });
  });
});

// ─── running the spec template ────────────────────────────────────────────

function message(content: ModelMessage['content'], stop: string = 'end_turn'): ModelMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: stop,
    stop_sequence: null,
    content,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as ModelMessage;
}
const text = (s: string) => message([{ type: 'text', text: s, citations: null }]);
const sendBack = (findings: string) =>
  message([{ type: 'tool_use', id: 'tu_sb', name: 'send_back', input: { findings } }], 'tool_use');

const SPEC_1 = `# Export runs as CSV\n\n## Problem\n\n${'The operator copies runs by hand. '.repeat(40)}\n\n## Outcome\n\nA CSV export.`;
const SPEC_2 = `${SPEC_1}\n\n## Acceptance criteria\n\n1. The export has a header row (a test).`;

describe('a spec template run', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
    await loadFactory(db, { path: repo, scripts: ['test'] });
  }, 30_000);
  afterAll(() => close());

  it('skips planning, keeps the spec whole, sends it back once, answers with spec and review', async () => {
    const builderUsers: string[] = [];
    const reviewUsers: string[] = [];
    const systems: string[] = [];
    const calls: ModelParams[] = [];
    const client: ModelClient = {
      async create(p) {
        calls.push(p);
        const system = String(p.system);
        systems.push(system);
        const user = JSON.stringify(p.messages[0]!.content);
        const sawResult = p.messages.some(
          (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
        );
        if (system.startsWith('You write the spec')) {
          builderUsers.push(user);
          return text(builderUsers.length === 1 ? SPEC_1 : SPEC_2);
        }
        reviewUsers.push(user);
        if (user.includes('Your findings last round sent the work back')) {
          return text('Verdict: pass. Every item holds.');
        }
        if (sawResult) return text('Verdict: fail. Sent back.');
        return sendBack('Acceptance criteria are missing.');
      },
    };
    const engine = new Engine({ client, getDb: async () => db });
    const preset = await templatePlan(db, 'spec');
    const run = await createRun(
      db,
      { text: 'Let me export runs as CSV', attachments: [], template: 'spec' },
      null,
      preset,
    );
    engine.enqueue(run.id);
    await engine.whenIdle();

    const done = (await getRun(db, run.id))!;
    expect(done.status).toBe('done');
    // No plan and no merge: every call was a step.
    expect(calls.some((p) => p.output_config?.format)).toBe(false);
    expect(systems.some((s) => s.includes('final answer'))).toBe(false);
    expect(systems[0]).toContain('Your result is a document');

    // Round 1 kept the spec whole; the review read all of it.
    expect(SPEC_1.length).toBeGreaterThan(1000);
    expect(reviewUsers[0]).toContain(JSON.stringify(SPEC_1).slice(1, -1));
    // Round 2 revised the first draft with the findings.
    expect(builderUsers).toHaveLength(2);
    expect(builderUsers[1]).toContain('The document so far. Revise it');
    expect(builderUsers[1]).toContain('Spec Review sent the work back after round 1');

    const [spec, review, merge] = done.plan as [Step, Step, Step];
    expect(spec).toMatchObject({ round: 2, document: SPEC_2, writesDocument: true });
    expect(spec.result!.summary.length).toBeLessThanOrEqual(1000);
    expect(review.round).toBe(2);
    expect(merge).toMatchObject({
      status: 'done',
      title: 'Hand over the spec',
      result: { summary: 'Handed over the document' },
    });
    expect(done.output!.markdown).toBe(
      `${SPEC_2}\n\n## Review the spec\n\nSpec Review: Verdict: pass. Every item holds.`,
    );
    expect(runDocument(done.plan)).toBe(SPEC_2);
    const events = await listEvents(db, run.id);
    expect(events[0]).toMatchObject({
      kind: 'plan',
      text: 'From the spec template: Spec Builder: Write the spec; Spec Review: Review the spec',
    });
  }, 20_000);

  it('a plain run never offers the factory agents to the orchestrator', async () => {
    let planSystem = '';
    const client: ModelClient = {
      async create(p) {
        if (p.output_config?.format) {
          planSystem = String(p.system);
          return text(JSON.stringify({ steps: [] }));
        }
        return text('Answered directly.');
      },
    };
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'Write a spec for CSV export', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    expect((await getRun(db, run.id))!.status).toBe('done');
    expect(planSystem).toContain('- researcher (');
    for (const agent of FACTORY_AGENTS) expect(planSystem).not.toContain(`- ${agent.slug} (`);
  }, 20_000);
});

describe('documents', () => {
  it('summarises a long document at a line break', () => {
    const doc = `# Title\n\n${'a'.repeat(700)}\n\n${'b'.repeat(700)}`;
    const summary = documentSummary(doc);
    expect(summary).toBe(`# Title\n\n${'a'.repeat(700)}…`);
    expect(documentSummary('short')).toBe('short');
  });

  it('answers with nothing when no step kept a document', () => {
    const step: Step = {
      id: 'a',
      agentId: 'agt_x',
      title: 'A',
      dependsOn: [],
      status: 'done',
      writesDocument: true,
      result: { summary: 'x' },
    };
    expect(documentAnswer([step], new Map())).toBeNull();
  });
});

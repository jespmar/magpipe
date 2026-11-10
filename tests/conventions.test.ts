/**
 * A repository's conventions in the step prompt (D34): the reader in lib/repo.ts against real
 * git folders, then a whole run with a scripted model that checks what each step's system prompt
 * carries. Also pins the memory cap the Settings and Memory screens quote.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { Engine, relevantMemory } from '@/lib/engine';
import type { ModelClient, ModelMessage, ModelParams } from '@/lib/engine/model';
import { conventionsText } from '@/lib/engine/step';
import { writeMemory } from '@/lib/memory';
import { clipValue, PLAN_MEMORY_CAP, standingReach } from '@/lib/memory-util';
import { CONVENTIONS_CAP, readConventions } from '@/lib/repo';
import { createRun, getRun } from '@/lib/runs';

let dir: string;

/** A git work tree at `name` under the temp folder, with the files given. */
function workTree(name: string, files: Record<string, string> = {}): string {
  const root = path.join(dir, name);
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return fs.realpathSync(root);
}

const LONG = Array.from({ length: 800 }, (_, i) => `Rule ${i + 1}: keep the tests green.`).join(
  '\n',
);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-conventions-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('reading a repository’s conventions', () => {
  it('takes the folder’s CLAUDE.md before the work tree’s', async () => {
    const root = workTree('both', {
      'CLAUDE.md': 'Root rules.\n',
      'packages/web/CLAUDE.md': '﻿Web rules.\n\n',
    });
    const found = await readConventions(path.join(root, 'packages/web'), root);
    expect(found).toEqual({
      file: path.join(root, 'packages/web/CLAUDE.md'),
      name: 'CLAUDE.md',
      text: 'Web rules.',
      cut: false,
    });
  });

  it('falls back to the work tree’s CLAUDE.md, then to AGENTS.md the same way', async () => {
    const root = workTree('fallback', {
      'CLAUDE.md': 'Root rules.\n',
      'packages/web/AGENTS.md': 'Web agents.\n',
      'packages/web/package.json': '{}',
    });
    const web = path.join(root, 'packages/web');
    expect((await readConventions(web, root))?.text).toBe('Root rules.');
    fs.rmSync(path.join(root, 'CLAUDE.md'));
    expect(await readConventions(web, root)).toMatchObject({
      name: 'AGENTS.md',
      text: 'Web agents.',
    });
    fs.rmSync(path.join(web, 'AGENTS.md'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Root agents.\n');
    expect((await readConventions(web, root))?.text).toBe('Root agents.');
    fs.rmSync(path.join(root, 'AGENTS.md'));
    expect(await readConventions(web, root)).toBeNull();
  });

  it('skips an empty file, a folder by that name and a symlink that leads out', async () => {
    const root = workTree('odd', { 'CLAUDE.md': '  \n', 'AGENTS.md': 'Agents here.\n' });
    expect((await readConventions(root, root))?.name).toBe('AGENTS.md');

    const linked = workTree('linked', { 'AGENTS.md': 'Inside.\n' });
    fs.writeFileSync(path.join(dir, 'outside.md'), 'Outside the repository.\n');
    fs.symlinkSync(path.join(dir, 'outside.md'), path.join(linked, 'CLAUDE.md'));
    expect((await readConventions(linked, linked))?.text).toBe('Inside.');

    const folder = workTree('folder');
    fs.mkdirSync(path.join(folder, 'CLAUDE.md'));
    expect(await readConventions(folder, folder)).toBeNull();
  });

  it('cuts a long file at a line end and says so', async () => {
    const root = workTree('long', { 'CLAUDE.md': LONG });
    const found = (await readConventions(root, root))!;
    expect(found.cut).toBe(true);
    expect(found.text.length).toBeLessThanOrEqual(CONVENTIONS_CAP);
    expect(found.text.length).toBeGreaterThan(CONVENTIONS_CAP / 2);
    expect(LONG.startsWith(`${found.text}\n`)).toBe(true);
    expect(conventionsText([{ ...found, repos: ['Long'] }])).toContain(
      'Conventions of Long (its CLAUDE.md):\nRule 1: keep the tests green.',
    );
    expect(conventionsText([{ ...found, repos: ['Long'] }])).toMatch(
      /\[Cut here: only the first 8,000 characters of CLAUDE\.md are shown\.\]$/,
    );
    expect(conventionsText([])).toBe('');
  });
});

// ─── a whole run ───────────────────────────────────────────────────────────

function message(content: ModelMessage['content']): ModelMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as ModelMessage;
}
const text = (s: string) => message([{ type: 'text', text: s, citations: null }]);

function scripted(answer: (p: ModelParams) => ModelMessage): ModelClient {
  return { create: async (params) => answer(params) };
}

describe('a step’s system prompt', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
    const app = workTree('run-app', {
      'CLAUDE.md': '# App\nRun npm test before you commit.\n',
      'docs/plans/README.md': 'Plans live here.\n',
    });
    const mono = workTree('run-mono', {
      'AGENTS.md': 'Use pnpm in this repository.\n',
      'packages/web/index.ts': 'export {};\n',
    });
    const big = workTree('run-big', { 'CLAUDE.md': `${LONG}\nEND OF THE BIG RULES\n` });
    const hidden = workTree('run-hidden', { 'CLAUDE.md': 'Hidden rules.\n' });
    const runOnly = workTree('run-only', { 'CLAUDE.md': 'Run-only rules.\n' });
    const repo = (id: string, name: string, folder: string) => ({
      id,
      slug: id.replace('tool_', ''),
      name,
      glyph: 'RP',
      kind: 'repository' as const,
      category: 'npm',
      description: `Folder ${folder}`,
      transport: 'repository' as const,
      url: null,
      command: null,
      // No scripts anywhere, so a grant of `run` alone offers nothing.
      repository: { path: folder, scripts: [], timeoutSec: 60 },
      auth: { type: 'none' as const },
      status: 'connected' as const,
      scopes: ['read', 'write', 'git_status'],
      grantedAgents: ['agt_operator'],
      stats: { calls24h: 0, lastCallAt: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .insert(t.tools)
      .values([
        repo('tool_app', 'App', app),
        repo('tool_plans', 'App plans', path.join(app, 'docs/plans')),
        repo('tool_web', 'Web', path.join(mono, 'packages/web')),
        repo('tool_big', 'Big', big),
        repo('tool_hidden', 'Hidden', hidden),
        repo('tool_runonly', 'Run only', runOnly),
      ]);
    await db
      .update(t.agents)
      .set({
        tools: [
          { toolId: 'tool_app', scopes: ['read'] },
          { toolId: 'tool_plans', scopes: ['write'] },
          { toolId: 'tool_web', scopes: ['read'] },
          { toolId: 'tool_big', scopes: ['git_status'] },
          // An empty grant allows nothing (D25), and `run` without scripts is never offered.
          { toolId: 'tool_hidden', scopes: [] },
          { toolId: 'tool_runonly', scopes: ['run'] },
        ],
      })
      .where(eq(t.agents.slug, 'operator'));
  }, 30_000);
  afterAll(() => close());

  it('carries each reachable repository’s conventions once, and nothing else', async () => {
    const systems = new Map<string, string>();
    const client = scripted((p) => {
      if (p.output_config?.format) {
        return text(
          JSON.stringify({
            steps: ['operator', 'researcher'].map((agent, i) => ({
              id: `s${i + 1}`,
              agent,
              title: `Work as ${agent}`,
              instructions: '',
              dependsOn: [],
              optional: false,
            })),
          }),
        );
      }
      const system = String(p.system);
      if (system.includes('final answer')) return text('merged');
      systems.set(system.includes('You are Operator') ? 'operator' : 'researcher', system);
      return text('Done.');
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'look at the repositories', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    expect((await getRun(db, run.id))!.status).toBe('done');

    const operator = systems.get('operator')!;
    expect(operator).toContain(
      'The repositories you can reach keep these instructions for anyone who works in them.',
    );
    // Two bindings of one work tree: the file once, under both names.
    expect(operator).toContain(
      'Conventions of App and App plans (their CLAUDE.md):\n# App\nRun npm test before you commit.',
    );
    expect(operator.split('Run npm test before you commit.').length - 1).toBe(1);
    // A folder with no CLAUDE.md anywhere in its work tree falls back to AGENTS.md at the root.
    expect(operator).toContain('Conventions of Web (its AGENTS.md):\nUse pnpm in this repository.');
    // A long file is cut, and the prompt says so.
    expect(operator).toContain(
      'Conventions of Big (its CLAUDE.md):\nRule 1: keep the tests green.',
    );
    expect(operator).toContain(
      `[Cut here: only the first ${CONVENTIONS_CAP.toLocaleString('en-US')} characters of CLAUDE.md are shown.]`,
    );
    expect(operator).not.toContain('END OF THE BIG RULES');
    // Nothing from a repository the agent holds no offered operation on.
    expect(operator).not.toContain('Hidden rules.');
    expect(operator).not.toContain('Run-only rules.');

    // An agent with no repository gets no conventions at all.
    expect(systems.get('researcher')).toBeDefined();
    expect(systems.get('researcher')).not.toContain('Conventions of');
  }, 30_000);

  it('hands the planner every decision first, up to the cap the screens quote', async () => {
    for (let i = 0; i < PLAN_MEMORY_CAP + 2; i += 1) {
      await writeMemory(
        db,
        {
          ns: 'decisions',
          key: `standing.${i}`,
          value: `Standing rule ${i}`,
          confidence: 1,
          source: 'operator',
          expiresAt: null,
        },
        'user',
      );
    }
    const memory = await relevantMemory(db, 'anything');
    expect(memory).toHaveLength(PLAN_MEMORY_CAP);
    expect(memory.every((e) => e.ns === 'decisions')).toBe(true);
    expect(standingReach(PLAN_MEMORY_CAP)).toBe(
      'Every entry here reaches every plan the orchestrator makes.',
    );
    expect(standingReach(PLAN_MEMORY_CAP + 2)).toBe(
      `The ${PLAN_MEMORY_CAP} most recently updated entries here reach every plan the orchestrator makes; the other 2 are left out until they are edited.`,
    );
  }, 30_000);
});

describe('a standing instruction in a list', () => {
  it('keeps a short value whole and cuts a long one at a word', () => {
    expect(clipValue('For code changes:\n  plan first.')).toBe('For code changes: plan first.');
    const long = `For code changes: ${'every step names its tests '.repeat(10)}`;
    const cut = clipValue(long, 60);
    expect(cut.length).toBeLessThanOrEqual(60);
    expect(cut.endsWith('…')).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(cut.slice(0, -1).endsWith(' ')).toBe(false);
    expect(clipValue('x'.repeat(100), 60)).toBe(`${'x'.repeat(59)}…`);
  });
});

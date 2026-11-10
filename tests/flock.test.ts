/**
 * The development flock (D35): lib/flock.ts mirrors docs/flock.md, and loading it onto a real git
 * repository in a temp folder creates the agents, namespaces, entries, tools and grants the
 * document describes, refuses what it cannot use, and changes nothing the second time.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import {
  FLOCK_AGENTS,
  FLOCK_DECISIONS,
  FlockValidationError,
  loadFlock,
  parseScripts,
  summarizeFlock,
  type FlockResult,
} from '@/lib/flock';
import { connectTool } from '@/lib/tools';
import { updateAgent } from '@/lib/agents';
import type { Tool } from '@/lib/schemas';

// ─── docs/flock.md, parsed ────────────────────────────────────────────────

const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'flock.md'), 'utf8');
const mdLines = md.split('\n');

/** The lines under `### <name>`, up to the next heading. */
function section(name: string): string {
  const start = mdLines.indexOf(`### ${name}`);
  if (start === -1) throw new Error(`docs/flock.md has no section ${name}`);
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
const ops = (cell: string) => Array.from(cell.matchAll(/`([a-z_]+)`/g), (m) => m[1]!).sort();

describe('lib/flock.ts mirrors docs/flock.md', () => {
  it('has the five agents of the roster, in its order', () => {
    expect(table('Agent', 'Writes').map((r) => r[0])).toEqual(FLOCK_AGENTS.map((a) => a.name));
  });

  for (const agent of FLOCK_AGENTS) {
    it(`${agent.name}: the fenced prompt, role and description, verbatim`, () => {
      const text = section(agent.name);
      const prompt = /```text\n([\s\S]*?)\n```/.exec(text)?.[1];
      expect(agent.systemPrompt).toBe(prompt);
      expect(agent.role).toBe(bullet(text, 'Role'));
      expect(agent.description).toBe(bullet(text, 'Description'));
    });
  }

  it('the roster table: model, built-ins, memory read and write, limits', () => {
    for (const row of table('Agent', 'Writes')) {
      const [name, , model, builtins, memory, limits] = row as [string, ...string[]];
      const agent = FLOCK_AGENTS.find((a) => a.name === name)!;
      expect(agent.model, name).toBe(model!.split(',')[0]!.trim());
      expect(agent.builtins, name).toEqual(list(builtins!));
      const [read, write] = memory!.split(' / ');
      expect(agent.memoryScope, name).toEqual({ read: list(read!), write: list(write!) });
      const [maxTokens, maxSteps, timeoutSec] = limits!
        .split(' / ')
        .map((n) => Number(n.replace(/\s/g, '')));
      expect(agent.limits, name).toEqual({ maxTokens, maxSteps, timeoutSec });
    }
  });

  it('the grants table: operations on App and on App plans', () => {
    const rows = table('Agent', 'App (repository)');
    expect(rows.map((r) => r[0])).toEqual(FLOCK_AGENTS.map((a) => a.name));
    for (const [name, app, plans] of rows as [string, string, string][]) {
      const agent = FLOCK_AGENTS.find((a) => a.name === name)!;
      expect([...agent.grants.app].sort(), name).toEqual(ops(app));
      expect([...agent.grants.plans].sort(), name).toEqual(ops(plans));
    }
  });

  it('the six standing instructions, verbatim', () => {
    const rows = table('Key', 'Value');
    expect(FLOCK_DECISIONS).toEqual(
      rows.map(([key, value]) => ({ key: key!.replace(/`/g, ''), value })),
    );
    expect(FLOCK_DECISIONS).toHaveLength(6);
  });
});

// ─── loading it ────────────────────────────────────────────────────────────

let dir: string;
let repo: string;

function makeRepo(at: string, scripts: Record<string, string>, git = true) {
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify({ name: 'app', scripts }));
  if (git) execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: at });
}

const CHECKS = { typecheck: 'node -e 0', lint: 'node -e 0', test: 'node -e 0', build: 'node -e 0' };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-flock-'));
  repo = path.join(dir, 'app');
  makeRepo(repo, CHECKS);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function counts(db: Db) {
  const [agents, tools, memory, namespaces] = await Promise.all([
    db.select({ id: t.agents.id }).from(t.agents),
    db.select({ id: t.tools.id }).from(t.tools),
    db.select({ id: t.memory.id }).from(t.memory),
    db.select({ id: t.memoryNamespaces.id }).from(t.memoryNamespaces),
  ]);
  return {
    agents: agents.length,
    tools: tools.length,
    memory: memory.length,
    namespaces: namespaces.length,
  };
}

describe('loadFlock', () => {
  let db: Db;
  let close: () => Promise<void>;
  let first: FlockResult;
  let other: Tool;

  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
    // A grant the operator made on another tool, which the flock must leave alone.
    const loose = path.join(dir, 'elsewhere');
    makeRepo(loose, { test: 'node -e 0' });
    ({ tool: other } = await connectTool(db, {
      name: 'Elsewhere',
      transport: 'repository',
      path: loose,
      scripts: [],
      auth: { type: 'none' },
      grant: [],
    }));
    await updateAgent(db, 'agt_coder', { tools: [{ toolId: other.id, scopes: ['read'] }] });
  }, 30_000);
  afterAll(async () => {
    await close();
  });

  const agentBySlug = async (slug: string) => {
    const [row] = await db.select().from(t.agents).where(eq(t.agents.slug, slug));
    return row!;
  };

  it('refuses a folder it cannot bind or scripts the folder lacks, and writes nothing', async () => {
    const before = await counts(db);
    const outside = path.join(dir, 'not-git');
    makeRepo(outside, CHECKS, false);

    const refused = async (opts: { path: string; scripts: string[] }) => {
      const err = await loadFlock(db, opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FlockValidationError);
      return err as FlockValidationError;
    };
    expect(await refused({ path: 'app', scripts: ['test'] })).toMatchObject({
      field: 'path',
      message: 'Give the folder as an absolute path.',
    });
    expect(await refused({ path: outside, scripts: ['test'] })).toMatchObject({
      field: 'path',
      message: expect.stringContaining('is not inside a git repository'),
    });
    expect(await refused({ path: repo, scripts: ['typecheck', 'e2e'] })).toMatchObject({
      field: 'scripts',
      message: 'package.json has no script named e2e. It has typecheck, lint, test, build.',
    });
    expect(await refused({ path: repo, scripts: [] })).toMatchObject({ field: 'scripts' });
    expect(await refused({ path: repo, scripts: ['rm -rf'] })).toMatchObject({ field: 'scripts' });

    expect(await counts(db)).toEqual(before);
    expect(fs.existsSync(path.join(outside, 'docs'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'docs'))).toBe(false);
  });

  it('creates docs/plans and binds the folder twice, named after it', async () => {
    first = await loadFlock(db, { path: repo, scripts: parseScripts('typecheck, lint test') });
    expect(first.path).toBe(repo);
    expect(first.plansFolderCreated).toBe(true);
    expect(fs.statSync(path.join(repo, 'docs', 'plans')).isDirectory()).toBe(true);

    const tools = await db.select().from(t.tools).where(eq(t.tools.kind, 'repository'));
    const app = tools.find((x) => x.name === 'app')!;
    const plans = tools.find((x) => x.name === 'app plans')!;
    expect(app).toMatchObject({
      status: 'connected',
      repository: { path: repo, scripts: ['typecheck', 'lint', 'test'], timeoutSec: 600 },
    });
    expect(app.scopes).toContain('run');
    expect(plans).toMatchObject({
      status: 'connected',
      repository: { path: path.join(repo, 'docs', 'plans'), scripts: [] },
    });
    expect(plans.scopes).not.toContain('run');
    expect(first.tools).toEqual([
      { name: 'app', role: 'app', outcome: 'created' },
      { name: 'app plans', role: 'plans', outcome: 'created' },
    ]);
  });

  it('adds the namespaces and the six decisions entries, written by the operator', async () => {
    const namespaces = await db.select().from(t.memoryNamespaces);
    expect(namespaces.map((n) => n.id)).toEqual(expect.arrayContaining(['plans', 'reviews']));
    expect(namespaces.find((n) => n.id === 'plans')!.label).toBe('Plans');
    expect(first.namespaces.filter((n) => n.outcome === 'created').map((n) => n.id)).toEqual([
      'plans',
      'reviews',
    ]);

    const entries = await db.select().from(t.memory).where(eq(t.memory.ns, 'decisions'));
    expect(entries).toHaveLength(6);
    for (const d of FLOCK_DECISIONS) {
      expect(entries.find((e) => e.key === d.key)).toMatchObject({
        value: d.value,
        confidence: 1,
        source: 'operator',
        writtenBy: 'user',
      });
    }
  });

  it('upserts the five agents as flock.md writes them, with explicit grants', async () => {
    const tools = await db.select().from(t.tools).where(eq(t.tools.kind, 'repository'));
    const app = tools.find((x) => x.name === 'app')!;
    const plans = tools.find((x) => x.name === 'app plans')!;

    for (const def of FLOCK_AGENTS) {
      const agent = await agentBySlug(def.slug);
      expect(agent, def.name).toMatchObject({
        name: def.name,
        role: def.role,
        description: def.description,
        model: def.model,
        systemPrompt: def.systemPrompt,
        builtins: def.builtins,
        memoryScope: def.memoryScope,
        limits: def.limits,
      });
      const grant = (toolId: string) => agent.tools.find((g) => g.toolId === toolId);
      expect([...grant(app.id)!.scopes].sort(), def.name).toEqual([...def.grants.app].sort());
      if (def.grants.plans.length > 0) {
        expect(grant(plans.id)!.scopes).toEqual(def.grants.plans);
      } else {
        expect(grant(plans.id), def.name).toBeUndefined();
      }
      // Never an empty grant (D25).
      expect(
        agent.tools.every((g) => g.scopes.length > 0),
        def.name,
      ).toBe(true);
    }

    // The starters keep their ids; Planner and Verifier are new.
    expect((await agentBySlug('researcher')).id).toBe('agt_researcher');
    expect(first.agents).toEqual([
      { name: 'Researcher', outcome: 'updated' },
      { name: 'Planner', outcome: 'created' },
      { name: 'Coder', outcome: 'updated' },
      { name: 'Reviewer', outcome: 'updated' },
      { name: 'Verifier', outcome: 'created' },
    ]);

    // The tool side of the grants follows: everyone on the folder, only the Planner on plans.
    const planner = await agentBySlug('planner');
    expect(
      (await db.select().from(t.tools).where(eq(t.tools.id, app.id)))[0]!.grantedAgents,
    ).toHaveLength(5);
    expect(
      (await db.select().from(t.tools).where(eq(t.tools.id, plans.id)))[0]!.grantedAgents,
    ).toEqual([planner.id]);

    // A grant the operator made on another tool is kept.
    expect((await agentBySlug('coder')).tools).toContainEqual({
      toolId: other.id,
      scopes: ['read'],
    });
  });

  it('pauses Operator rather than deleting it', async () => {
    expect(first.operator).toBe('paused');
    expect((await agentBySlug('operator')).status).toBe('paused');
  });

  it('says what it did in plain lines', () => {
    expect(summarizeFlock(first)).toEqual([
      {
        label: 'Agents',
        text: 'Created Planner and Verifier. Updated Researcher, Coder and Reviewer. Paused Operator.',
      },
      { label: 'Tools', text: 'Bound app and app plans as repository tools.' },
      {
        label: 'Memory',
        text: 'Created the namespaces plans and reviews. Wrote 6 decisions entries.',
      },
      {
        label: 'Plan folder',
        text: 'Created docs/plans. Git keeps it once a plan file is in it.',
      },
      {
        label: 'Still to connect',
        text: 'GitHub (read) and Library docs need a token or npx, so they are not connected. Connect them from Tools, then tick their tools for each agent.',
      },
    ]);
  });

  it('changes nothing when loaded again', async () => {
    const before = await counts(db);
    const coderBefore = await agentBySlug('coder');
    const again = await loadFlock(db, { path: `${repo}/`, scripts: ['typecheck', 'lint', 'test'] });

    expect(await counts(db)).toEqual(before);
    expect((await agentBySlug('coder')).updatedAt).toEqual(coderBefore.updatedAt);
    expect(again.plansFolderCreated).toBe(false);
    expect(again.tools.map((x) => x.outcome)).toEqual(['unchanged', 'unchanged']);
    expect(again.namespaces.every((n) => n.outcome === 'unchanged')).toBe(true);
    expect(again.entries.every((e) => e.outcome === 'unchanged')).toBe(true);
    expect(again.agents.every((a) => a.outcome === 'unchanged')).toBe(true);
    expect(again.operator).toBe('unchanged');
    const [entry] = await db
      .select()
      .from(t.memory)
      .where(and(eq(t.memory.ns, 'decisions'), eq(t.memory.key, 'dev.workflow')));
    expect(entry!.history).toHaveLength(1);

    expect(summarizeFlock(again).slice(0, 4)).toEqual([
      {
        label: 'Agents',
        text: 'No changes to Researcher, Planner, Coder, Reviewer and Verifier. Operator stays paused.',
      },
      { label: 'Tools', text: 'Reused app and app plans.' },
      { label: 'Memory', text: '6 decisions entries unchanged.' },
      { label: 'Plan folder', text: 'docs/plans was already there.' },
    ]);
  });

  it('puts back what was edited since, as a new version', async () => {
    const [entry] = await db
      .select()
      .from(t.memory)
      .where(and(eq(t.memory.ns, 'decisions'), eq(t.memory.key, 'dev.checks')));
    await db
      .update(t.memory)
      .set({ value: 'Anything goes.', confidence: 0.4 })
      .where(eq(t.memory.id, entry!.id));
    await updateAgent(db, 'agt_reviewer', { model: 'claude-haiku-5-5' });

    const again = await loadFlock(db, { path: repo, scripts: ['typecheck', 'lint', 'test'] });
    expect(again.entries.find((e) => e.key === 'dev.checks')!.outcome).toBe('updated');
    expect(again.agents.find((a) => a.name === 'Reviewer')!.outcome).toBe('updated');
    const [fixed] = await db.select().from(t.memory).where(eq(t.memory.id, entry!.id));
    expect(fixed).toMatchObject({ confidence: 1, conflict: false, source: 'operator' });
    expect(fixed!.value).toBe(FLOCK_DECISIONS.find((d) => d.key === 'dev.checks')!.value);
    expect((await agentBySlug('reviewer')).model).toBe('claude-opus-5-5');
  });
});

describe('loadFlock on a folder the operator already bound', () => {
  let db: Db;
  let close: () => Promise<void>;
  let repo2: string;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
    repo2 = path.join(dir, 'bound');
    makeRepo(repo2, CHECKS);
    fs.mkdirSync(path.join(repo2, 'docs', 'plans'), { recursive: true });
    await connectTool(db, {
      name: 'App',
      transport: 'repository',
      path: repo2,
      scripts: ['test'],
      auth: { type: 'none' },
      grant: [],
    });
    // Another tool already has the folder's name, so the plans binding needs its own.
    await connectTool(db, {
      name: 'bound plans',
      transport: 'stdio',
      command: 'no-such-mcp-binary',
      auth: { type: 'none' },
      grant: [],
    });
  }, 30_000);
  afterAll(async () => {
    await close();
  });

  it('reuses that tool with the scripts asked for, and names a new one apart', async () => {
    const result = await loadFlock(db, { path: repo2, scripts: ['typecheck', 'test'] });
    expect(result.plansFolderCreated).toBe(false);
    expect(result.tools).toEqual([
      { name: 'App', role: 'app', outcome: 'updated' },
      { name: 'bound plans 2', role: 'plans', outcome: 'created' },
    ]);
    const repos = await db.select().from(t.tools).where(eq(t.tools.kind, 'repository'));
    expect(repos).toHaveLength(2);
    expect(repos.find((x) => x.name === 'App')!.repository!.scripts).toEqual(['typecheck', 'test']);
    expect(summarizeFlock(result)[1]).toEqual({
      label: 'Tools',
      text: 'Bound bound plans 2 as a repository tool. Updated the scripts of App.',
    });
  });
});

describe('the flock and the run gates', () => {
  it('has the Planner wait for approval and lets the Reviewer send work back once (D30, D31)', () => {
    const by = Object.fromEntries(FLOCK_AGENTS.map((a) => [a.slug, a]));
    expect(by.planner).toMatchObject({ pauseAfter: true, sendBackRounds: 0 });
    expect(by.reviewer).toMatchObject({ pauseAfter: false, sendBackRounds: 1 });
    for (const slug of ['researcher', 'coder', 'verifier']) {
      expect(by[slug]).toMatchObject({ pauseAfter: false, sendBackRounds: 0 });
    }
  });
});

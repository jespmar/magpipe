/**
 * The Claude Code backend (D22) against a fake `claude` and the real embedded database: the MCP
 * endpoint serves a step's tools, the fake CLI uses it the way Claude Code does, plan and merge
 * come back as single results, failures map to engine codes, cancel kills the process, and a
 * whole run goes queued → done through the engine.
 */
import http from 'node:http';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/mcp/route';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { Engine } from '@/lib/engine';
import {
  CLI_LOGIN_MESSAGE,
  claudeCodeBackend,
  failureFrom,
  runCli,
  type ClaudeCli,
} from '@/lib/engine/claude-code';
import { listEvents } from '@/lib/engine/events';
import { registerToolSession, unregisterToolSession } from '@/lib/engine/tool-sessions';
import { setupTools, type Trail } from '@/lib/engine/tools';
import { connectMcp } from '@/lib/mcp';
import { listMemory } from '@/lib/memory';
import { createRun, getRun } from '@/lib/runs';
import type { Agent, RunEventKind } from '@/lib/schemas';

const FAKE: ClaudeCli = {
  path: process.execPath,
  argsPrefix: [path.join(process.cwd(), 'tests', 'stubs', 'claude.mjs')],
};

/** Mounts the route handler on a plain Node server, so the fake CLI (and our own client) can reach it. */
function serveRoute(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).filter(
          (e): e is [string, string] => typeof e[1] === 'string',
        ),
        ...(req.method === 'POST' ? { body } : {}),
      });
      const response =
        req.method === 'POST' ? await POST(request) : new Response(null, { status: 405 });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

function recorder(): Trail & { events: { kind: RunEventKind; text: string }[] } {
  const events: { kind: RunEventKind; text: string }[] = [];
  return {
    events,
    async emit(kind, text) {
      events.push({ kind, text });
    },
  };
}

describe('claude code backend', () => {
  let db: Db;
  let close: () => Promise<void>;
  let served: { url: string; close: () => void };
  let researcher: Agent;

  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
    await db
      .update(t.agents)
      .set({ memoryScope: { read: ['facts', 'decisions'], write: ['facts'] } })
      .where(eq(t.agents.slug, 'researcher'));
    const [row] = await db.select().from(t.agents).where(eq(t.agents.slug, 'researcher'));
    researcher = row!;
    served = await serveRoute();
  }, 30_000);
  afterAll(async () => {
    served.close();
    await close();
  });
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_FAIL;
    delete process.env.FAKE_CLAUDE_HANG;
    delete process.env.FAKE_CLAUDE_TURNS;
    delete process.env.FAKE_CLAUDE_WRITE;
  });

  async function runtimeFor(agent: Agent, trail: Trail) {
    return setupTools({
      db,
      agent,
      attachments: [],
      sandboxDir: process.cwd(),
      signal: new AbortController().signal,
      onRejectedWrite: (text) => trail.emit('error', text),
      onToolUnavailable: (text) => trail.emit('error', text),
    });
  }

  it('serves a step’s tools over MCP to our own client, under the step’s token only', async () => {
    const trail = recorder();
    const runtime = await runtimeFor(researcher, trail);
    const session = registerToolSession({ runtime, trail, agentName: researcher.name });
    try {
      const conn = await connectMcp({
        transport: 'http',
        url: `${served.url}/api/mcp`,
        headers: { Authorization: `Bearer ${session.token}` },
      });
      const names = (await conn.listTools()).map((d) => d.name).sort();
      expect(names).toEqual(['files_read', 'memory_get', 'memory_search', 'memory_write']);
      const res = await conn.callTool('memory_write', {
        ns: 'facts',
        key: 'mcp.roundtrip',
        value: 'served by the app',
        confidence: 0.9,
        source: 'test',
        expiresAt: null,
      });
      expect(res.isError).toBe(false);
      expect(res.content[0]?.text).toMatch(/Wrote facts\/mcp\.roundtrip/);
      await conn.close();
      expect(trail.events.map((e) => e.kind)).toEqual(['tool_call', 'tool_result', 'memory_write']);
      const stored = await listMemory(db, { ns: 'facts' });
      expect(stored.some((e) => e.key === 'mcp.roundtrip')).toBe(true);

      // a scope the agent does not hold is refused and written to the trail
      const denied = await (
        await connectMcp({
          transport: 'http',
          url: `${served.url}/api/mcp`,
          headers: { Authorization: `Bearer ${session.token}` },
        })
      ).callTool('memory_write', {
        ns: 'decisions',
        key: 'x',
        value: 'y',
        confidence: 1,
        source: 'test',
        expiresAt: null,
      });
      expect(denied.isError).toBe(true);
      expect(trail.events.some((e) => e.text.includes('outside its memory scope'))).toBe(true);
    } finally {
      await runtime.close();
      unregisterToolSession(session.token);
    }
    // no token, no answer
    await expect(
      connectMcp({
        transport: 'http',
        url: `${served.url}/api/mcp`,
        headers: { Authorization: 'Bearer nope' },
      }),
    ).rejects.toThrow();
  });

  it('plans and merges with one print-mode call each', async () => {
    const backend = claudeCodeBackend({ cli: async () => FAKE, serverUrl: served.url });
    const signal = new AbortController().signal;
    const plan = await backend.plan(
      {
        model: 'claude-opus-5-5',
        system: 'orchestrate',
        user: 'Task: hello',
        schema: { type: 'object' },
      },
      signal,
    );
    expect(JSON.parse(plan.text)).toMatchObject({ steps: [{ agent: 'researcher' }] });
    expect(plan.usage).toEqual({ inputTokens: 350, outputTokens: 80, costUsd: 0.0123 });
    const merge = await backend.merge(
      { model: 'claude-opus-5-5', system: 'merge', user: 'Task: hello' },
      signal,
    );
    expect(merge.text).toMatch(/^## Merged by the fake claude/);
  });

  it('runs a step through the CLI, which writes memory back through the app’s MCP endpoint', async () => {
    process.env.FAKE_CLAUDE_WRITE = JSON.stringify({
      ns: 'facts',
      key: 'visma.rpm',
      value: '300 rpm',
      confidence: 0.9,
      source: 'docs',
      expiresAt: null,
    });
    const backend = claudeCodeBackend({ cli: async () => FAKE, serverUrl: served.url });
    const trail = recorder();
    const runtime = await runtimeFor(researcher, trail);
    try {
      const out = await backend.step(
        {
          agent: researcher,
          system: 'You are Researcher.',
          user: 'Task given to Magpipe:\nFind the limit\n\nYour step: Look it up\n',
          runtime,
          sandboxDir: process.cwd(),
          trail,
        },
        new AbortController().signal,
      );
      expect(out.summary).toMatch(/^Fake answer to: Look it up/);
      expect(out.summary).toContain('tools: files_read, memory_search, memory_get, memory_write');
      expect(out.summary).toContain('wrote: Wrote facts/visma.rpm');
      expect(out.usage).toEqual({ inputTokens: 350, outputTokens: 80, costUsd: 0.0123 });
      const kinds = trail.events.map((e) => e.kind);
      expect(kinds).toEqual(['tool_call', 'tool_result', 'memory_write', 'message', 'message']);
      const stored = await listMemory(db, { ns: 'facts' });
      expect(stored.find((e) => e.key === 'visma.rpm')?.value).toBe('300 rpm');
    } finally {
      await runtime.close();
    }
  });

  it('maps the CLI’s failures to engine codes and stops a step that exceeds its rounds', async () => {
    expect(
      failureFrom({ type: 'result', is_error: true, result: 'Authentication error' }, 'X').code,
    ).toBe('no_api_key');
    expect(
      failureFrom({ type: 'result', is_error: true, result: 'Authentication error' }, 'X').message,
    ).toBe(CLI_LOGIN_MESSAGE);
    expect(
      failureFrom({ type: 'result', is_error: true, subtype: 'error_max_turns' }, 'X').code,
    ).toBe('limit_steps');
    expect(failureFrom({ type: 'result', is_error: true, stop_reason: 'refusal' }, 'X').code).toBe(
      'refusal',
    );
    const generic = failureFrom(
      { type: 'result', is_error: true, result: 'temporary network issue' },
      'X',
    );
    expect(generic.code).toBe('provider_error');
    expect(generic.retryable).toBe(true);

    const backend = claudeCodeBackend({ cli: async () => FAKE, serverUrl: served.url });
    const trail = recorder();
    const runtime = await runtimeFor(researcher, trail);
    try {
      process.env.FAKE_CLAUDE_FAIL = 'auth';
      await expect(
        backend.step(
          { agent: researcher, system: 's', user: 'u', runtime, sandboxDir: process.cwd(), trail },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'no_api_key' });

      delete process.env.FAKE_CLAUDE_FAIL;
      process.env.FAKE_CLAUDE_TURNS = '5';
      const tight = { ...researcher, limits: { ...researcher.limits, maxSteps: 2 } };
      await expect(
        backend.step(
          { agent: tight, system: 's', user: 'u', runtime, sandboxDir: process.cwd(), trail },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'limit_steps' });
    } finally {
      await runtime.close();
    }

    // a command that does not exist is a configuration problem, not something to retry
    await expect(
      runCli({ path: '/no/such/claude' }, ['-p'], {
        input: 'x',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'no_cli', retryable: false });
  });

  it('kills the CLI when the step is cancelled', async () => {
    process.env.FAKE_CLAUDE_HANG = '1';
    const controller = new AbortController();
    const started = Date.now();
    const pending = runCli(FAKE, ['-p', '--output-format', 'json'], {
      input: 'x',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('takes a whole run from queued to done through the engine', async () => {
    const backend = claudeCodeBackend({ cli: async () => FAKE, serverUrl: served.url });
    const engine = new Engine({ backend, getDb: async () => db });
    const run = await createRun(db, { text: 'Summarise the nest', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    const done = (await getRun(db, run.displayId))!;
    expect(done.status).toBe('done');
    expect(done.output?.markdown).toMatch(/^## Merged by the fake claude/);
    expect(done.plan.map((s) => s.status)).toEqual(['done', 'done']);
    expect(done.usage.costUsd).toBeCloseTo(0.0123 * 3, 6);
    const events = await listEvents(db, run.id);
    expect(events.map((e) => e.kind)).toContain('plan');
    expect(events.some((e) => e.kind === 'message' && e.text.startsWith('Fake answer to'))).toBe(
      true,
    );
    expect(events.at(-1)?.kind).toBe('done');
  }, 30_000);
});

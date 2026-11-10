/**
 * The Claude Code backend against the real `claude` on this machine. Skipped unless
 * REAL_CLAUDE=1 (it needs a signed-in Claude Code and spends a little): the suite itself never
 * needs credentials. Run it on a machine where Magpipe will use the backend:
 *
 *   REAL_CLAUDE=1 npx vitest run tests/real-claude.test.ts
 */
import http from 'node:http';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/mcp/route';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { claudeCodeBackend, findClaudeCli } from '@/lib/engine/claude-code';
import { setupTools, type Trail } from '@/lib/engine/tools';
import { listMemory } from '@/lib/memory';
import type { Agent, RunEventKind } from '@/lib/schemas';

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

describe.skipIf(!process.env.REAL_CLAUDE)('the real claude', () => {
  let db: Db;
  let close: () => Promise<void>;
  let served: { url: string; close: () => void };
  let researcher: Agent;

  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
    await db
      .update(t.agents)
      .set({ memoryScope: { read: ['facts'], write: ['facts'] }, model: 'claude-haiku-5-5' })
      .where(eq(t.agents.slug, 'researcher'));
    const [row] = await db.select().from(t.agents).where(eq(t.agents.slug, 'researcher'));
    researcher = row!;
    served = await serveRoute();
  }, 30_000);
  afterAll(async () => {
    served.close();
    await close();
  });

  it('is installed and signed in', async () => {
    const cli = await findClaudeCli();
    expect(cli).not.toBeNull();
    expect(cli!.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('plans with a schema and keeps our system prompt', async () => {
    const backend = claudeCodeBackend({ serverUrl: served.url });
    const signal = new AbortController().signal;
    const out = await backend.plan(
      {
        model: 'claude-haiku-5-5',
        system:
          'You are a planner. Return exactly one step for the agent with slug "researcher", titled "Probe".',
        user: 'Task: say hello',
        schema: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  agent: { type: 'string' },
                  title: { type: 'string' },
                  instructions: { type: 'string' },
                  dependsOn: { type: 'array', items: { type: 'string' } },
                  optional: { type: 'boolean' },
                },
                required: ['id', 'agent', 'title', 'instructions', 'dependsOn', 'optional'],
                additionalProperties: false,
              },
            },
          },
          required: ['steps'],
          additionalProperties: false,
        },
      },
      signal,
    );
    const plan = JSON.parse(out.text) as { steps: { agent: string }[] };
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps[0]!.agent).toBe('researcher');
    expect(out.usage.outputTokens).toBeGreaterThan(0);
  }, 120_000);

  it('runs a step whose tools come back through the app over MCP', async () => {
    const backend = claudeCodeBackend({ serverUrl: served.url });
    const events: { kind: RunEventKind; text: string }[] = [];
    const trail: Trail = {
      async emit(kind, text) {
        events.push({ kind, text });
      },
    };
    const runtime = await setupTools({
      db,
      agent: researcher,
      attachments: [],
      sandboxDir: process.cwd(),
      signal: new AbortController().signal,
      onRejectedWrite: (text) => trail.emit('error', text),
      onToolUnavailable: (text) => trail.emit('error', text),
    });
    try {
      const out = await backend.step(
        {
          agent: researcher,
          system:
            'You are Researcher. You must call the memory_write tool exactly once with ns "facts", key "probe.answer", value "pelican", confidence 1, source "probe", expiresAt null. Then reply with the single word DONE.',
          user: 'Your step: Record the probe fact.',
          runtime,
          sandboxDir: process.cwd(),
          trail,
        },
        new AbortController().signal,
      );
      expect(out.summary.toUpperCase()).toContain('DONE');
      expect(events.some((e) => e.kind === 'memory_write' && e.text === 'facts/probe.answer')).toBe(
        true,
      );
      const stored = await listMemory(db, { ns: 'facts' });
      expect(stored.find((e) => e.key === 'probe.answer')?.value.toLowerCase()).toContain(
        'pelican',
      );
      expect(out.usage.outputTokens).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  }, 180_000);
});

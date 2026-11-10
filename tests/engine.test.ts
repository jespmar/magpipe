/**
 * The run engine against the real embedded database with a scripted model: plan → steps →
 * merge, tool calls, memory writes, retries, failures, limits and cancellation (spec §7.2, D5).
 */
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { Engine } from '@/lib/engine';
import { listEvents } from '@/lib/engine/events';
import type { ModelClient, ModelMessage, ModelParams } from '@/lib/engine/model';
import { listMemory } from '@/lib/memory';
import { createRun, getRun, homeStats, listRuns } from '@/lib/runs';

type Script = (params: ModelParams, call: number) => ModelMessage | Error | Promise<ModelMessage>;

function message(
  partial: Partial<ModelMessage> & { content: ModelMessage['content'] },
): ModelMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
      inference_geo: null,
      iterations: null,
      speed: null,
    } as ModelMessage['usage'],
    ...partial,
  } as ModelMessage;
}
const text = (s: string) => message({ content: [{ type: 'text', text: s, citations: null }] });
const toolUse = (name: string, input: Record<string, unknown>, id = `tu_${name}`) =>
  message({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const plan = (steps: unknown[]) => text(JSON.stringify({ steps }));

/** A model that answers from a script and records every request. */
function scripted(script: Script): ModelClient & { calls: ModelParams[] } {
  const calls: ModelParams[] = [];
  return {
    calls,
    async create(params, signal) {
      calls.push(params);
      const out = await script(params, calls.length);
      if (out instanceof Error) throw out;
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      return out;
    },
  };
}

const isPlan = (p: ModelParams) => Boolean(p.output_config?.format);
const isMerge = (p: ModelParams) =>
  typeof p.system === 'string' && p.system.includes('final answer');

describe('run engine', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
    // the starter agents have no tools; give Researcher a memory write scope for the tests
    await db
      .update(t.agents)
      .set({ memoryScope: { read: ['facts', 'decisions'], write: ['facts'] } })
      .where(eq(t.agents.slug, 'researcher'));
  }, 30_000);
  afterAll(() => close());

  it('plans, fans out, writes memory through the tool, merges, and records the trail', async () => {
    const client = scripted((p) => {
      if (isPlan(p)) {
        return plan([
          {
            id: 's1',
            agent: 'researcher',
            title: 'Look up the limit',
            instructions: 'Find the rate limit and remember it.',
            dependsOn: [],
            optional: false,
          },
          {
            id: 's2',
            agent: 'coder',
            title: 'Draft the change',
            instructions: 'Use the limit.',
            dependsOn: ['s1'],
            optional: false,
          },
        ]);
      }
      if (isMerge(p)) return text('## Done\n\nThe limit is 300 rpm and the change is drafted.');
      const last = p.messages[p.messages.length - 1]!;
      const isToolResult =
        Array.isArray(last.content) &&
        last.content.some((b) => (b as { type: string }).type === 'tool_result');
      const system = String(p.system);
      if (system.includes('Researcher') && !isToolResult) {
        return toolUse('memory_write', {
          ns: 'facts',
          key: 'visma.rpm',
          value: '300 rpm',
          confidence: 0.9,
          source: 'docs',
          expiresAt: null,
        });
      }
      if (system.includes('Researcher'))
        return text('Found it: 300 requests per minute, recorded in memory.');
      return text('Drafted the change using 300 rpm.');
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, {
      text: 'What is the Visma rate limit and draft a change for it',
      attachments: [],
    });
    engine.enqueue(run.id);
    await engine.whenIdle();

    const done = (await getRun(db, run.id))!;
    expect(done.status).toBe('done');
    expect(done.output?.markdown).toContain('300 rpm');
    expect(done.plan.map((s) => [s.id, s.status])).toEqual([
      ['s1', 'done'],
      ['s2', 'done'],
      ['merge', 'done'],
    ]);
    expect(done.plan[1]!.dependsOn).toEqual(['s1']);
    expect(done.usage.inputTokens).toBeGreaterThan(0);
    expect(done.usage.costUsd).toBeGreaterThan(0);
    expect(done.durationMs).toBeGreaterThanOrEqual(0);

    const kinds = (await listEvents(db, run.id)).map((e) => e.kind);
    expect(kinds[0]).toBe('plan');
    expect(kinds).toEqual(
      expect.arrayContaining(['tool_call', 'tool_result', 'memory_write', 'message', 'done']),
    );
    expect(kinds[kinds.length - 1]).toBe('done');

    const [fact] = await listMemory(db, { ns: 'facts', q: 'visma.rpm' });
    expect(fact).toMatchObject({ value: '300 rpm', writtenBy: 'agt_researcher' });

    // the coder's step saw the researcher's result
    const coderCall = client.calls.find(
      (p) => !isPlan(p) && !isMerge(p) && String(p.system).includes('Coder'),
    )!;
    expect(JSON.stringify(coderCall.messages)).toContain('Found it: 300 requests');
    // agents are idle again
    const agents = await db.select({ status: t.agents.status }).from(t.agents);
    expect(agents.every((a) => a.status === 'idle')).toBe(true);
    expect((await homeStats(db)).runsToday).toBeGreaterThanOrEqual(1);
  });

  it('rejects writes outside the memory scope and logs them', async () => {
    const client = scripted((p) => {
      if (isPlan(p))
        return plan([
          {
            id: 's1',
            agent: 'researcher',
            title: 'Try a forbidden write',
            instructions: '',
            dependsOn: [],
            optional: false,
          },
        ]);
      if (isMerge(p)) return text('ok');
      const last = p.messages[p.messages.length - 1]!;
      if (
        Array.isArray(last.content) &&
        last.content.some((b) => (b as { type: string }).type === 'tool_result')
      ) {
        expect(JSON.stringify(last.content)).toContain('may not write');
        return text('Understood, not written.');
      }
      return toolUse('memory_write', {
        ns: 'tenants',
        key: 'x',
        value: 'y',
        confidence: 1,
        source: 's',
        expiresAt: null,
      });
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'forbidden write', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    expect((await getRun(db, run.id))!.status).toBe('done');
    const errors = (await listEvents(db, run.id)).filter((e) => e.kind === 'error');
    expect(errors.some((e) => e.text.includes('outside its memory scope'))).toBe(true);
    expect(await listMemory(db, { ns: 'tenants' })).toEqual([]);
  });

  it('retries network trouble, never a bad request, and marks downstream steps skipped', async () => {
    let flaky = 0;
    const client = scripted((p) => {
      if (isPlan(p)) {
        return plan([
          {
            id: 's1',
            agent: 'researcher',
            title: 'Flaky',
            instructions: '',
            dependsOn: [],
            optional: false,
          },
          {
            id: 's2',
            agent: 'coder',
            title: 'Bad',
            instructions: '',
            dependsOn: [],
            optional: false,
          },
          {
            id: 's3',
            agent: 'operator',
            title: 'After bad',
            instructions: '',
            dependsOn: ['s2'],
            optional: false,
          },
        ]);
      }
      const system = String(p.system);
      if (system.includes('Researcher')) {
        flaky += 1;
        if (flaky <= 2) return new Anthropic.APIConnectionError({ message: 'socket hang up' });
        return text('third time lucky');
      }
      if (system.includes('Coder'))
        return new Anthropic.BadRequestError(
          400,
          { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
          'bad request',
          new Headers(),
        );
      return text('should not run');
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'mixed failures', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    const result = (await getRun(db, run.id))!;
    expect(result.status).toBe('failed');
    const byId = Object.fromEntries(result.plan.map((s) => [s.id, s]));
    expect(byId.s1!.status).toBe('done');
    expect(byId.s2!.status).toBe('failed');
    expect(byId.s2!.error?.code).toBe('bad_request');
    expect(byId.s3!.status).toBe('skipped');
    expect(byId.merge!.status).toBe('skipped');
    expect(flaky).toBe(3);
    const events = await listEvents(db, run.id);
    expect(events.filter((e) => e.text.startsWith('Retry')).length).toBe(2);
    expect(events[events.length - 1]!.kind).toBe('error');
  }, 20_000);

  it('enforces the step limit and the plan schema', async () => {
    await db
      .update(t.agents)
      .set({ limits: { maxTokens: 100_000, maxSteps: 2, timeoutSec: 600 } })
      .where(eq(t.agents.slug, 'coder'));
    let plans = 0;
    const client = scripted((p) => {
      if (isPlan(p)) {
        plans += 1;
        if (plans === 1) return text('not json at all');
        return plan([
          {
            id: 's1',
            agent: 'coder',
            title: 'Loop forever',
            instructions: '',
            dependsOn: [],
            optional: false,
          },
        ]);
      }
      return toolUse('memory_search', { query: 'x' }, `tu_${Math.random()}`);
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'limits', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    const result = (await getRun(db, run.id))!;
    expect(plans).toBe(2); // an unparseable plan is retried once
    expect(result.status).toBe('failed');
    expect(result.plan[0]!.error?.code).toBe('limit_steps');
  }, 20_000);

  it('cancels a running run', async () => {
    const client = scripted(async (p) => {
      if (isPlan(p))
        return plan([
          {
            id: 's1',
            agent: 'operator',
            title: 'Slow',
            instructions: '',
            dependsOn: [],
            optional: false,
          },
        ]);
      await new Promise((r) => setTimeout(r, 400));
      return text('too late');
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'cancel me', attachments: [] });
    engine.enqueue(run.id);
    await new Promise((r) => setTimeout(r, 150));
    expect(await engine.cancel(run.id)).toBe(true);
    await engine.whenIdle();
    const result = (await getRun(db, run.id))!;
    expect(result.status).toBe('cancelled');
    expect(result.plan.find((s) => s.id === 's1')?.status).toBe('failed');
    expect(result.plan.find((s) => s.id === 'merge')?.status).toBe('skipped');
    const { counts } = await listRuns(db);
    expect(counts.cancelled).toBeGreaterThanOrEqual(1);
  });

  it('carries a follow-up’s conversation into the plan, the step and the merge', async () => {
    const client = scripted((p) => {
      if (isPlan(p)) {
        return plan([
          {
            id: 's1',
            agent: 'coder',
            title: 'Answer the follow-up',
            instructions: 'Answer it.',
            dependsOn: [],
            optional: false,
          },
        ]);
      }
      if (isMerge(p)) return text('Twelve, counting the new one.');
      return text('Twelve.');
    });
    const engine = new Engine({ client, getDb: async () => db });
    const first = await createRun(db, { text: 'How many birds are in the nest?', attachments: [] });
    await db
      .update(t.runs)
      .set({ status: 'done', output: { markdown: 'Eleven birds.', artifacts: [] } })
      .where(eq(t.runs.id, first.id));
    // A re-fly repeats the task; its newer answer is the one the thread keeps.
    const retry = await createRun(db, first.input, first.id);
    await db
      .update(t.runs)
      .set({ status: 'done', output: { markdown: 'Eleven birds, one on the way.', artifacts: [] } })
      .where(eq(t.runs.id, retry.id));
    const followUp = await createRun(db, { text: 'And once it lands?', attachments: [] }, retry.id);
    engine.enqueue(followUp.id);
    await engine.whenIdle();
    expect((await getRun(db, followUp.id))!.status).toBe('done');

    const planCall = client.calls.find(isPlan)!;
    const planSystem = String(planCall.system);
    expect(planSystem).toContain(
      'Operator: How many birds are in the nest?\nMagpipe: Eleven birds, one on the way.',
    );
    expect(planSystem).not.toContain('Magpipe: Eleven birds.\n');
    expect(planSystem.split('Operator:').length - 1).toBe(1);
    const stepCall = client.calls.find((p) => !isPlan(p) && !isMerge(p))!;
    const stepUser = JSON.stringify(stepCall.messages[0]!.content);
    expect(stepUser).toContain('Earlier in this conversation');
    expect(stepUser).toContain('one on the way');
    expect(stepUser).toContain('Task given to Magpipe:\\nAnd once it lands?');
    // The planner's prompt also speaks of a final answer; the merge is the one without a schema.
    const mergeCall = client.calls.find((p) => !isPlan(p) && isMerge(p))!;
    expect(JSON.stringify(mergeCall.messages[0]!.content)).toContain(
      'Earlier in this conversation',
    );

    // A fresh task carries no thread.
    const fresh = await createRun(db, { text: 'A new question', attachments: [] });
    engine.enqueue(fresh.id);
    await engine.whenIdle();
    const freshPlan = client.calls.filter(isPlan).at(-1)!;
    expect(String(freshPlan.system)).not.toContain('Earlier');
  }, 20_000);

  it('resumes runs a previous process left behind', async () => {
    const run = await createRun(db, { text: 'resume me', attachments: [] });
    await db
      .update(t.runs)
      .set({
        status: 'running',
        startedAt: new Date(),
        plan: [
          { id: 's1', agentId: 'agt_operator', title: 'Was live', dependsOn: [], status: 'live' },
          { id: 'merge', agentId: null, title: 'Merge results', dependsOn: ['s1'], status: 'todo' },
        ],
      })
      .where(eq(t.runs.id, run.id));
    const client = scripted((p) =>
      isMerge(p) ? text('merged after restart') : text('did the step'),
    );
    const engine = new Engine({ client, getDb: async () => db });
    expect(await engine.resumeInterrupted(db)).toBeGreaterThanOrEqual(1);
    await engine.whenIdle();
    const result = (await getRun(db, run.id))!;
    expect(result.status).toBe('done');
    expect(result.output?.markdown).toBe('merged after restart');
    expect(client.calls.some((p) => isPlan(p))).toBe(false); // the existing plan was kept
  });
});

describe('run engine with a granted MCP server', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
  }, 30_000);
  afterAll(() => close());

  it('exposes the server’s tools under wire names, calls them and counts the call', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-engine-mcp-'));
    const script = path.join(dir, 'server.js');
    fs.writeFileSync(
      script,
      `let buf='';process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))!==-1){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);if(m.id===undefined)continue;
      const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'echo',version:'0'}}:m.method==='tools/list'?{tools:[{name:'echo.say',description:'Echo',inputSchema:{$schema:'x',type:'object',properties:{text:{type:'string'}},required:['text']}},{name:'hidden',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'echo: '+m.params.arguments.text}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});`,
    );
    const toolId = 'tool_echo';
    await db.insert(t.tools).values({
      id: toolId,
      slug: 'echo-server',
      name: 'Echo server',
      glyph: 'EC',
      kind: 'mcp',
      category: 'Test',
      description: 'A local echo',
      transport: 'stdio',
      url: null,
      command: `"${process.execPath}" "${script}"`,
      auth: { type: 'none' },
      status: 'connected',
      scopes: ['echo.say', 'hidden'],
      grantedAgents: ['agt_operator'],
      stats: { calls24h: 0, lastCallAt: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(t.agents)
      .set({ tools: [{ toolId, scopes: ['echo.say'] }] })
      .where(eq(t.agents.slug, 'operator'));

    const client = scripted((p) => {
      if (isPlan(p))
        return plan([
          {
            id: 's1',
            agent: 'operator',
            title: 'Say hi',
            instructions: '',
            dependsOn: [],
            optional: false,
          },
        ]);
      if (isMerge(p)) return text('merged');
      const names = (p.tools ?? []).map((tool) => (tool as { name: string }).name);
      expect(names).toContain('echo-server__echo_say');
      expect(names).not.toContain('echo-server__hidden'); // not granted
      const schema = (p.tools ?? []).find(
        (tool) => (tool as { name: string }).name === 'echo-server__echo_say',
      ) as { input_schema: Record<string, unknown> };
      expect(schema.input_schema).not.toHaveProperty('$schema');
      const last = p.messages[p.messages.length - 1]!;
      if (
        Array.isArray(last.content) &&
        last.content.some((b) => (b as { type: string }).type === 'tool_result')
      ) {
        expect(JSON.stringify(last.content)).toContain('echo: hi');
        return text('said hi');
      }
      return toolUse('echo-server__echo_say', { text: 'hi' });
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'use the echo server', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    expect((await getRun(db, run.id))!.status).toBe('done');
    const events = await listEvents(db, run.id);
    expect(
      events.some((e) => e.kind === 'tool_call' && e.text.startsWith('Echo server · echo.say')),
    ).toBe(true);
    const [tool] = await db.select().from(t.tools).where(eq(t.tools.id, toolId));
    expect(tool!.stats.calls24h).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe('run engine with an empty grant', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
  }, 30_000);
  afterAll(() => close());

  it('gives the agent none of the server’s tools and never starts the server (D25)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-engine-empty-'));
    const started = path.join(dir, 'started');
    const script = path.join(dir, 'server.js');
    // The server leaves a file behind if it is ever started.
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(started)}, 'yes');`);
    const toolId = 'tool_empty_grant';
    await db.insert(t.tools).values({
      id: toolId,
      slug: 'quiet-server',
      name: 'Quiet server',
      glyph: 'QS',
      kind: 'mcp',
      category: 'Test',
      description: 'Granted with nothing ticked',
      transport: 'stdio',
      url: null,
      command: `"${process.execPath}" "${script}"`,
      auth: { type: 'none' },
      status: 'connected',
      scopes: ['write_file', 'read_file'],
      grantedAgents: ['agt_operator'],
      stats: { calls24h: 0, lastCallAt: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(t.agents)
      .set({ tools: [{ toolId, scopes: [] }] })
      .where(eq(t.agents.slug, 'operator'));

    let stepTools: string[] = [];
    const client = scripted((p) => {
      if (isPlan(p)) {
        // The planner is not told the agent has this tool.
        expect(String(p.system)).not.toContain(toolId);
        return plan([
          {
            id: 's1',
            agent: 'operator',
            title: 'Look around',
            instructions: '',
            dependsOn: [],
            optional: false,
          },
        ]);
      }
      if (isMerge(p)) return text('merged');
      stepTools = (p.tools ?? []).map((tool) => (tool as { name: string }).name);
      return text('nothing to do');
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'look around', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    expect((await getRun(db, run.id))!.status).toBe('done');
    expect(stepTools.length).toBeGreaterThan(0); // memory and file tools are still there
    expect(stepTools.some((n) => n.startsWith('quiet-server__'))).toBe(false);
    expect(fs.existsSync(started)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe('run engine with a tool server that is down', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
  }, 30_000);
  afterAll(() => close());

  it('logs the loss on the step and finishes the run without that server (D19)', async () => {
    const toolId = 'tool_down';
    await db.insert(t.tools).values({
      id: toolId,
      slug: 'down-server',
      name: 'Down server',
      glyph: 'DN',
      kind: 'mcp',
      category: 'Test',
      description: 'A server that is not installed',
      transport: 'stdio',
      url: null,
      command: 'no-such-mcp-binary --serve',
      auth: { type: 'none' },
      status: 'connected',
      scopes: ['anything'],
      grantedAgents: ['agt_operator'],
      stats: { calls24h: 0, lastCallAt: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(t.agents)
      .set({ tools: [{ toolId, scopes: ['anything'] }] })
      .where(eq(t.agents.slug, 'operator'));

    const client = scripted((p) => {
      if (isPlan(p))
        return plan([
          {
            id: 's1',
            agent: 'operator',
            title: 'Carry on',
            instructions: '',
            dependsOn: [],
            optional: false,
          },
        ]);
      if (isMerge(p)) return text('merged');
      // The step still runs, with no tool from the server that is down.
      const names = (p.tools ?? []).map((tool) => (tool as { name: string }).name);
      expect(names.some((n) => n.startsWith('down-server__'))).toBe(false);
      return text('carried on');
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'keep going', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    const after = (await getRun(db, run.id))!;
    expect(after.status).toBe('done');
    expect(after.plan.find((s) => s.id === 's1')!.status).toBe('done');
    const events = await listEvents(db, run.id);
    const loss = events.find(
      (e) => e.kind === 'error' && e.text.startsWith('Down server is unreachable'),
    );
    expect(loss?.stepId).toBe('s1');
    expect(loss?.text).toContain('the step runs without its tools');
  }, 20_000);
});

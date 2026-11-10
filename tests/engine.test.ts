/**
 * The run engine against the real embedded database with a scripted model: plan → steps →
 * merge, tool calls, memory writes, retries, failures, limits and cancellation (spec §7.2, D5),
 * the daily spend cap (D32) and resuming a step after a restart (D33).
 */
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { Engine } from '@/lib/engine';
import { listEvents } from '@/lib/engine/events';
import type { ModelClient, ModelMessage, ModelParams } from '@/lib/engine/model';
import { listMemory } from '@/lib/memory';
import { approveRun, createRun, getRun, homeStats, listRuns } from '@/lib/runs';

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
    // The step knows it was interrupted, and that nothing was recorded before (D33).
    expect(result.plan[0]!.restarts).toBe(1);
    expect(result.plan[1]!.restarts).toBeUndefined();
    const stepUser = JSON.stringify(client.calls.find((p) => !isMerge(p))!.messages[0]!.content);
    expect(stepUser).toContain('This step was interrupted by a restart after it had started.');
    expect(stepUser).toContain('Magpipe recorded no repository work before that.');
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
      if (isPlan(p)) {
        // The planner reads the grant by name, with only the tool it allows.
        expect(String(p.system)).toContain('  servers: Echo server (echo.say)\n');
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
      }
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

describe('run engine with an approval gate', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
    await db.update(t.agents).set({ pauseAfter: true }).where(eq(t.agents.slug, 'researcher'));
  }, 30_000);
  afterAll(() => close());

  const twoSteps = (dependant = true) => [
    {
      id: 's1',
      agent: 'researcher',
      title: 'Plan it',
      instructions: '',
      dependsOn: [],
      optional: false,
    },
    ...(dependant
      ? [
          {
            id: 's2',
            agent: 'coder',
            title: 'Build it',
            instructions: '',
            dependsOn: ['s1'],
            optional: false,
          },
        ]
      : []),
  ];

  it('waits after a step by an agent that waits, and goes on with the note once approved (D30)', async () => {
    let planSystem = '';
    let builderUser = '';
    const client = scripted((p) => {
      if (isPlan(p)) {
        planSystem = String(p.system);
        return plan(twoSteps());
      }
      if (isMerge(p)) return text('merged');
      if (String(p.system).includes('You are Coder')) {
        builderUser = JSON.stringify(p.messages[0]!.content);
        return text('Built it.');
      }
      return text('The plan: one change.');
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'plan then build', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();

    const waiting = (await getRun(db, run.id))!;
    expect(waiting.status).toBe('waiting');
    expect(waiting.plan.map((s) => s.status)).toEqual(['done', 'todo', 'todo']);
    expect(waiting.finishedAt).toBeNull();
    expect(planSystem).toContain('  waits for approval: the run pauses after its steps');
    const events = await listEvents(db, run.id);
    expect(events.map((e) => e.text)).toContain('Waiting for you: approve “Plan it” to go on.');
    const [coder] = await db.select().from(t.agents).where(eq(t.agents.slug, 'coder'));
    expect(coder!.status).toBe('idle');

    const approved = await approveRun(db, run.id, '  Skip the second tenant.  ');
    expect(approved!.status).toBe('queued');
    expect(approved!.plan[0]).toMatchObject({ approvalNote: 'Skip the second tenant.' });
    expect(approved!.plan[0]!.approvedAt).toBeTruthy();
    expect(await approveRun(db, run.id)).toBeUndefined(); // no longer waiting

    engine.enqueue(run.id);
    await engine.whenIdle();
    const after = (await getRun(db, run.id))!;
    expect(after.status).toBe('done');
    expect(after.plan.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(builderUser).toContain(
      'The operator approved this with a note: Skip the second tenant.',
    );
  }, 20_000);

  it('never waits when only the merge comes after the step', async () => {
    const client = scripted((p) => {
      if (isPlan(p)) return plan(twoSteps(false));
      if (isMerge(p)) return text('merged');
      return text('The plan: one change.');
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'just plan', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    expect((await getRun(db, run.id))!.status).toBe('done');
  }, 20_000);

  it('cancels a waiting run, skipping what was held', async () => {
    const client = scripted((p) => {
      if (isPlan(p)) return plan(twoSteps());
      if (isMerge(p)) return text('merged');
      return text('ok');
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'plan, then stop', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    expect((await getRun(db, run.id))!.status).toBe('waiting');
    expect(await engine.cancel(run.id)).toBe(true);
    const after = (await getRun(db, run.id))!;
    expect(after.status).toBe('cancelled');
    expect(after.plan.map((s) => s.status)).toEqual(['done', 'skipped', 'skipped']);
    expect(after.finishedAt).not.toBeNull();
  }, 20_000);
});

describe('run engine with a reviewer that may send work back', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
  }, 30_000);
  afterAll(() => close());

  const plannedPair = () =>
    plan([
      {
        id: 's1',
        agent: 'coder',
        title: 'Make the change',
        instructions: '',
        dependsOn: [],
        optional: false,
      },
      {
        id: 's2',
        agent: 'reviewer',
        title: 'Review the change',
        instructions: '',
        dependsOn: ['s1'],
        optional: false,
      },
    ]);
  const names = (p: ModelParams) => (p.tools ?? []).map((tool) => (tool as { name: string }).name);
  const userOf = (p: ModelParams) => JSON.stringify(p.messages[0]!.content);
  const sawResult = (p: ModelParams) =>
    p.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => (b as { type: string }).type === 'tool_result'),
    );

  it('reruns the reviewed step with the findings, then reviews once more (D31)', async () => {
    await db.update(t.agents).set({ sendBackRounds: 1 }).where(eq(t.agents.slug, 'reviewer'));
    const coderUsers: string[] = [];
    const reviewerTools: string[][] = [];
    let reviewerRound2 = '';
    let planSystem = '';
    const client = scripted((p) => {
      if (isPlan(p)) {
        planSystem = String(p.system);
        return plannedPair();
      }
      if (isMerge(p)) return text('merged');
      if (String(p.system).includes('You are Coder')) {
        coderUsers.push(userOf(p));
        return text(coderUsers.length === 1 ? 'Made it.' : 'Fixed the tenant check.');
      }
      reviewerTools.push(names(p));
      const user = userOf(p);
      if (user.includes('Your findings last round sent the work back')) {
        reviewerRound2 = user;
        return text('Approve.');
      }
      if (sawResult(p)) return text('Changes requested.');
      return toolUse('send_back', { findings: 'The tenant check is missing in src/a.ts:12.' });
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'change with a review', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    const after = (await getRun(db, run.id))!;
    expect(after.status).toBe('done');
    expect(planSystem).toContain('  may send work back: up to 1 time, to the steps it depends on');

    // The Coder ran twice, the second time with the findings; the Reviewer reviewed again.
    expect(coderUsers).toHaveLength(2);
    expect(coderUsers[0]).not.toContain('sent the work back');
    expect(coderUsers[1]).toContain(
      'Round 2. Reviewer sent the work back after round 1: The tenant check is missing in src/a.ts:12.',
    );
    expect(reviewerRound2).toContain('The tenant check is missing');
    expect(reviewerTools[0]).toContain('send_back');
    expect(reviewerTools.at(-1)).not.toContain('send_back'); // no rounds left
    const [s1, s2] = after.plan;
    expect([s1!.round, s2!.round]).toEqual([2, 2]);
    expect(s2!.sentBack).toBeUndefined();
    const events = await listEvents(db, run.id);
    expect(events.map((e) => e.text)).toContain(
      'Round 2: Reviewer sent the work back to “Make the change”.',
    );
    // Every model call is still counted after the steps were reopened.
    expect(after.usage.inputTokens).toBe(100 * client.calls.length);
  }, 20_000);

  it('never offers send_back to an agent with no rounds', async () => {
    await db.update(t.agents).set({ sendBackRounds: 0 }).where(eq(t.agents.slug, 'reviewer'));
    const seen: string[][] = [];
    const client = scripted((p) => {
      if (isPlan(p)) return plannedPair();
      if (isMerge(p)) return text('merged');
      if (!String(p.system).includes('You are Coder')) seen.push(names(p));
      return text('ok');
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'change without a loop', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    expect((await getRun(db, run.id))!.status).toBe('done');
    expect(seen.flat()).not.toContain('send_back');
  }, 20_000);
});

describe('run engine recording what steps did in a repository', () => {
  let db: Db;
  let close: () => Promise<void>;
  let dir: string;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-engine-work-'));
    fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: `node -e "console.log('1 passed')"` } }),
    );
    const sh = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    sh(['init', '-q', '-b', 'main']);
    sh(['config', 'user.name', 'Test']);
    sh(['config', 'user.email', 'test@example.com']);
    sh(['add', '-A']);
    sh(['commit', '-q', '-m', 'init']);
    const repoRow = (
      id: string,
      slug: string,
      name: string,
      folder: string,
      scripts: string[],
    ) => ({
      id,
      slug,
      name,
      glyph: 'RP',
      kind: 'repository' as const,
      category: 'npm',
      description: `Folder ${folder}`,
      transport: 'repository' as const,
      url: null,
      command: null,
      repository: { path: folder, scripts, timeoutSec: 60 },
      auth: { type: 'none' as const },
      status: 'connected' as const,
      scopes: ['read', 'write', 'run', 'git_branch', 'git_commit'],
      grantedAgents: ['agt_operator'],
      stats: { calls24h: 0, lastCallAt: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .insert(t.tools)
      .values([
        repoRow('tool_work_app', 'app', 'App', dir, ['test']),
        repoRow('tool_work_plans', 'plans', 'App plans', path.join(dir, 'docs', 'plans'), []),
      ]);
    await db
      .update(t.agents)
      .set({
        tools: [
          { toolId: 'tool_work_app', scopes: ['read', 'write', 'run', 'git_branch', 'git_commit'] },
          { toolId: 'tool_work_plans', scopes: ['write'] },
        ],
      })
      .where(eq(t.agents.slug, 'operator'));
  }, 30_000);
  afterAll(async () => {
    await close();
    (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
  });

  const resultsIn = (p: ModelParams) =>
    p.messages.filter(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => (b as { type: string }).type === 'tool_result'),
    ).length;

  it('records the branch, files, commit and check, and hands them on as facts (D29)', async () => {
    const script: [string, Record<string, unknown>][] = [
      ['app__git_branch', { name: 'magpipe/x', create: true }],
      ['app__write', { path: 'src/a.ts', contents: 'export const a = 1;\n' }],
      ['plans__write', { path: 'x.md', contents: '# Plan\n' }],
      ['app__git_commit', { message: 'Add a', paths: ['src/a.ts', 'docs/plans/x.md'] }],
      ['app__run', { script: 'test' }],
    ];
    let readerUser = '';
    let mergeUser = '';
    const client = scripted((p) => {
      if (isPlan(p)) {
        return plan([
          {
            id: 's1',
            agent: 'operator',
            title: 'Make the change',
            instructions: '',
            dependsOn: [],
            optional: false,
          },
          {
            id: 's2',
            agent: 'researcher',
            title: 'Look it over',
            instructions: '',
            dependsOn: ['s1'],
            optional: false,
          },
        ]);
      }
      if (isMerge(p)) {
        mergeUser = JSON.stringify(p.messages[0]!.content);
        return text('merged');
      }
      if (String(p.system).includes('You are Researcher')) {
        readerUser = JSON.stringify(p.messages[0]!.content);
        return text('Looked it over.');
      }
      const n = resultsIn(p);
      if (n > 0) {
        const last = JSON.stringify(p.messages[p.messages.length - 1]!.content);
        expect(last).not.toContain('"is_error":true');
      }
      const next = script[n];
      return next ? toolUse(next[0], next[1]) : text('Done on magpipe/x.');
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'make the change', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    const after = (await getRun(db, run.id))!;
    expect(after.status).toBe('done');

    const sha = (await import('node:child_process'))
      .execFileSync('git', ['rev-parse', '--short', 'magpipe/x'], { cwd: dir })
      .toString()
      .trim();
    const s1 = after.plan.find((st) => st.id === 's1')!;
    expect(s1.work).toEqual({
      branches: [{ repo: 'App', name: 'magpipe/x', created: true }],
      files: [
        { repo: 'App', path: 'src/a.ts', change: 'created' },
        { repo: 'App plans', path: 'docs/plans/x.md', change: 'created' },
      ],
      commits: [{ repo: 'App', branch: 'magpipe/x', sha, message: 'Add a' }],
      checks: [
        { repo: 'App', script: 'test', exit: 0, seconds: expect.any(Number), timedOut: false },
      ],
    });
    expect(after.plan.find((st) => st.id === 's2')!.work).toBeUndefined();

    // The next step and the merge are told what the tools did, not only what the agent said.
    for (const prompt of [readerUser, mergeUser]) {
      expect(prompt).toContain('Recorded by Magpipe:');
      expect(prompt).toContain(`- App: committed ${sha} on magpipe/x: Add a`);
      expect(prompt).toContain('- App: ran test, passed (exit 0)');
    }
    expect(after.output!.artifacts).toEqual([
      { kind: 'branch', repo: 'App', name: 'magpipe/x', detail: `1 commit · last ${sha} Add a` },
      { kind: 'file', repo: 'App', name: 'src/a.ts', detail: 'created' },
      { kind: 'file', repo: 'App plans', name: 'docs/plans/x.md', detail: 'created' },
    ]);
  }, 30_000);

  it('keeps the work of a step that fails partway', async () => {
    let calls = 0;
    const client = scripted((p) => {
      if (isPlan(p)) {
        return plan([
          {
            id: 's1',
            agent: 'operator',
            title: 'Start the change',
            instructions: '',
            dependsOn: [],
            optional: false,
          },
        ]);
      }
      calls += 1;
      if (resultsIn(p) === 0) return toolUse('app__write', { path: 'src/b.ts', contents: 'b\n' });
      return Object.assign(new Error('The model refused to continue'), { status: 400 });
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'start a change', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    const after = (await getRun(db, run.id))!;
    expect(after.status).toBe('failed');
    const s1 = after.plan.find((st) => st.id === 's1')!;
    expect(s1.status).toBe('failed');
    expect(s1.work?.files).toEqual([{ repo: 'App', path: 'src/b.ts', change: 'created' }]);
    expect(calls).toBeGreaterThan(1);
  }, 30_000);

  it('saves each recorded item onto the step before the step ends (D33)', async () => {
    const run = await createRun(db, { text: 'write two files', attachments: [] });
    const seen: { status?: string; files?: string[] }[] = [];
    const client = scripted(async (p) => {
      if (isPlan(p)) {
        return plan([
          {
            id: 's1',
            agent: 'operator',
            title: 'Write two files',
            instructions: '',
            dependsOn: [],
            optional: false,
          },
        ]);
      }
      if (isMerge(p)) return text('merged');
      const n = resultsIn(p);
      if (n > 0) {
        // What a restart at this moment would find in the plan.
        const s1 = (await getRun(db, run.id))!.plan.find((st) => st.id === 's1')!;
        seen.push({ status: s1.status, files: s1.work?.files.map((f) => f.path) });
      }
      if (n === 0) return toolUse('app__write', { path: 'src/d1.ts', contents: 'd1\n' }, 'tu_d1');
      if (n === 1) return toolUse('app__write', { path: 'src/d2.ts', contents: 'd2\n' }, 'tu_d2');
      return text('Wrote both.');
    });
    const engine = new Engine({ client, getDb: async () => db });
    engine.enqueue(run.id);
    await engine.whenIdle();
    expect((await getRun(db, run.id))!.status).toBe('done');
    expect(seen).toEqual([
      { status: 'live', files: ['src/d1.ts'] },
      { status: 'live', files: ['src/d1.ts', 'src/d2.ts'] },
    ]);
  }, 30_000);

  it('resumes an interrupted step with what it had recorded, and keeps that work (D33)', async () => {
    const run = await createRun(db, { text: 'finish the change', attachments: [] });
    const earlier = {
      branches: [{ repo: 'App', name: 'magpipe/x', created: true }],
      files: [{ repo: 'App', path: 'src/e1.ts', change: 'created' as const }],
      commits: [{ repo: 'App', branch: 'magpipe/x', sha: 'abc1234', message: 'First half' }],
      checks: [],
    };
    await db
      .update(t.runs)
      .set({
        status: 'running',
        startedAt: new Date(),
        plan: [
          {
            id: 's1',
            agentId: 'agt_operator',
            title: 'Make the change',
            dependsOn: [],
            status: 'live',
            startedAt: new Date().toISOString(),
            work: earlier,
          },
          { id: 'merge', agentId: null, title: 'Merge results', dependsOn: ['s1'], status: 'todo' },
        ],
      })
      .where(eq(t.runs.id, run.id));

    let stepUser = '';
    const client = scripted((p) => {
      if (isMerge(p)) return text('merged after restart');
      if (resultsIn(p) === 0) {
        stepUser = String(p.messages[0]!.content);
        return toolUse('app__write', { path: 'src/e2.ts', contents: 'e2\n' }, 'tu_e2');
      }
      return text('Finished the second half.');
    });
    const engine = new Engine({ client, getDb: async () => db });
    expect(await engine.resumeInterrupted(db)).toBe(1);
    await engine.whenIdle();

    expect(stepUser).toContain(
      [
        'This step was interrupted by a restart after it had started. Before that, Magpipe recorded:',
        '- App: created and switched to branch magpipe/x',
        '- App: created src/e1.ts',
        '- App: committed abc1234 on magpipe/x: First half',
        'Continue from there: check git_status and the branch, and do not redo work that is already committed.',
      ].join('\n'),
    );
    const after = (await getRun(db, run.id))!;
    expect(after.status).toBe('done');
    const s1 = after.plan.find((st) => st.id === 's1')!;
    expect(s1.restarts).toBe(1);
    // Both attempts are on the record: the first attempt's branch, file and commit, then the new file.
    expect(s1.work).toEqual({
      ...earlier,
      files: [
        { repo: 'App', path: 'src/e1.ts', change: 'created' },
        { repo: 'App', path: 'src/e2.ts', change: 'created' },
      ],
    });
    const texts = (await listEvents(db, run.id)).map((e) => e.text);
    expect(texts).toContain('Magpipe restarted; resuming where the run left off.');
  }, 30_000);
});

describe('run engine under a daily spend cap (D32)', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
    // Room for the pricey calls below: the cap, not a step's token limit, is what stops them.
    await db
      .update(t.agents)
      .set({ limits: { maxTokens: 10_000_000, maxSteps: 30, timeoutSec: 600 } });
  }, 30_000);
  afterAll(() => close());
  beforeEach(async () => {
    // Each case starts the day afresh.
    await db.delete(t.runs);
  });

  /** Every call costs $1.40 at the orchestrator's prices: 100k tokens in, 50k out. */
  const pricey = (m: ModelMessage): ModelMessage => ({
    ...m,
    usage: { ...m.usage, input_tokens: 100_000, output_tokens: 50_000 },
  });
  const twoSteps = () =>
    scripted((p) => {
      if (isPlan(p)) {
        return pricey(
          plan([
            {
              id: 's1',
              agent: 'researcher',
              title: 'Look it up',
              instructions: '',
              dependsOn: [],
              optional: false,
            },
            {
              id: 's2',
              agent: 'coder',
              title: 'Draft the change',
              instructions: '',
              dependsOn: ['s1'],
              optional: false,
            },
          ]),
        );
      }
      if (isMerge(p)) return pricey(text('merged'));
      return pricey(text(String(p.system).includes('Coder') ? 'Drafted.' : 'Found it.'));
    });
  const setCap = (spendCapUsd: number) => db.update(t.settings).set({ spendCapUsd });
  const runOnce = async (client: ModelClient) => {
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'look it up and draft the change', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    const events = await listEvents(db, run.id);
    return { run: (await getRun(db, run.id))!, last: events[events.length - 1]! };
  };

  it('stops the run before a step once today’s spend reaches the cap', async () => {
    await setCap(2);
    const client = twoSteps();
    const { run, last } = await runOnce(client);
    expect(run.status).toBe('failed');
    expect(run.plan.map((s) => [s.id, s.status])).toEqual([
      ['s1', 'done'],
      ['s2', 'skipped'],
      ['merge', 'skipped'],
    ]);
    // The plan ($1.40) left room for the first step; the first step's own $1.40 used it up.
    expect(last).toMatchObject({
      kind: 'error',
      payload: { code: 'spend_cap' },
      text: 'Today’s spend ($2.80) reached the $2.00 cap, so the run stopped before “Draft the change”. Raise the cap in Settings to go on.',
    });
    // One plan call and the first step's call; the second step and the merge never asked.
    expect(client.calls.filter(isPlan)).toHaveLength(1);
    expect(client.calls.filter((p) => !isPlan(p))).toHaveLength(1);
    expect(run.usage.costUsd).toBeCloseTo(2.8);
  }, 20_000);

  it('runs to the end while today’s spend stays under the cap', async () => {
    await setCap(100);
    const { run, last } = await runOnce(twoSteps());
    expect(run.status).toBe('done');
    expect(run.plan.every((s) => s.status === 'done')).toBe(true);
    expect(last.kind).toBe('done');
    expect(run.usage.costUsd).toBeCloseTo(5.6);
  }, 20_000);

  it('stops before planning when the day is already spent, and treats a cap of 0 as none', async () => {
    const spent = await createRun(db, { text: 'an earlier run', attachments: [] });
    await db
      .update(t.runs)
      .set({ status: 'done', usage: { inputTokens: 1, outputTokens: 1, costUsd: 500 } })
      .where(eq(t.runs.id, spent.id));

    await setCap(50);
    const stopped = twoSteps();
    const first = await runOnce(stopped);
    expect(first.run.status).toBe('failed');
    expect(first.run.plan).toEqual([]);
    expect(stopped.calls).toHaveLength(0);
    expect(first.last.payload).toEqual({ code: 'spend_cap' });
    expect(first.last.text).toBe(
      'Today’s spend ($500.00) reached the $50.00 cap, so the run stopped before planning. Raise the cap in Settings to go on.',
    );

    await setCap(0);
    const second = await runOnce(twoSteps());
    expect(second.run.status).toBe('done');
  }, 20_000);
});

describe('run engine with one writer per work tree', () => {
  let db: Db;
  let close: () => Promise<void>;
  let dir: string;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-engine-writers-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await db.insert(t.tools).values({
      id: 'tool_writers_repo',
      slug: 'app',
      name: 'App',
      glyph: 'AP',
      kind: 'repository',
      category: 'npm',
      description: `Folder ${dir}`,
      transport: 'repository',
      url: null,
      command: null,
      repository: { path: dir, scripts: [], timeoutSec: 60 },
      auth: { type: 'none' },
      status: 'connected',
      scopes: ['read', 'write'],
      grantedAgents: ['agt_coder', 'agt_researcher'],
      stats: { calls24h: 0, lastCallAt: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(t.agents)
      .set({ tools: [{ toolId: 'tool_writers_repo', scopes: ['read', 'write'] }] })
      .where(eq(t.agents.slug, 'coder'));
    await db
      .update(t.agents)
      .set({ tools: [{ toolId: 'tool_writers_repo', scopes: ['read'] }] })
      .where(eq(t.agents.slug, 'researcher'));
  }, 30_000);
  afterAll(async () => {
    await close();
    (await import('node:fs')).rmSync(dir, { recursive: true, force: true });
  });

  /** A model that holds every step for a moment and records how many were in flight. */
  function tracking(steps: (agent: string, i: number) => { id: string; agent: string }[]) {
    const now = { coder: 0, researcher: 0, all: 0 };
    const most = { coder: 0, researcher: 0, all: 0, side: 0 };
    const client = scripted(async (p) => {
      if (isPlan(p)) {
        return plan(
          steps('', 0).map((st) => ({
            ...st,
            title: `Step ${st.id}`,
            instructions: '',
            dependsOn: [],
            optional: false,
          })),
        );
      }
      if (isMerge(p)) return text('merged');
      const who = String(p.system).includes('You are Coder') ? 'coder' : 'researcher';
      now[who] += 1;
      now.all += 1;
      most[who] = Math.max(most[who], now[who]);
      most.all = Math.max(most.all, now.all);
      if (now.coder > 0 && now.researcher > 0) most.side += 1;
      await new Promise((r) => setTimeout(r, 150));
      now[who] -= 1;
      now.all -= 1;
      return text('done');
    });
    return { client, most };
  }

  it('never runs two writers at once, while a reader works beside one (D28)', async () => {
    const { client, most } = tracking(() => [
      { id: 'c1', agent: 'coder' },
      { id: 'c2', agent: 'coder' },
      { id: 'r1', agent: 'researcher' },
    ]);
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'two changes and a question', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    const after = (await getRun(db, run.id))!;
    expect(after.status).toBe('done');
    expect(after.plan.filter((st) => st.id !== 'merge').map((st) => st.status)).toEqual([
      'done',
      'done',
      'done',
    ]);
    expect(most.coder).toBe(1);
    expect(most.side).toBeGreaterThan(0); // the reader ran beside a writer
  }, 20_000);

  it('runs at most three steps of a run at once', async () => {
    const { client, most } = tracking(() =>
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, agent: 'researcher' })),
    );
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'five questions', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    expect((await getRun(db, run.id))!.status).toBe('done');
    expect(most.all).toBe(3);
  }, 20_000);

  it('makes a second run wait while the first changes the same work tree, and says so', async () => {
    const { client, most } = tracking(() => [{ id: 'c1', agent: 'coder' }]);
    const engine = new Engine({ client, getDb: async () => db });
    const first = await createRun(db, { text: 'first change', attachments: [] });
    const second = await createRun(db, { text: 'second change', attachments: [] });
    engine.enqueue(first.id);
    engine.enqueue(second.id);
    await engine.whenIdle();
    expect((await getRun(db, first.id))!.status).toBe('done');
    expect((await getRun(db, second.id))!.status).toBe('done');
    expect(most.coder).toBe(1);
    const waits = [
      ...(await listEvents(db, first.id)),
      ...(await listEvents(db, second.id)),
    ].filter((e) => e.text.startsWith('Waiting to change App:'));
    expect(waits).toHaveLength(1);
    expect(waits[0]!.text).toMatch(
      /^Waiting to change App: run flight_[0-9a-z]+ is changing it\.$/,
    );
    const [coder] = await db.select().from(t.agents).where(eq(t.agents.slug, 'coder'));
    expect(coder!.status).toBe('idle');
  }, 20_000);
});

describe('run engine with a bound repository', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
  }, 30_000);
  afterAll(() => close());

  it('runs an allowed script for an agent granted run, and offers nothing it was not granted (D27)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-engine-repo-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: `node -e "console.log('3 passed')"` } }),
    );
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const toolId = 'tool_app_repo';
    await db.insert(t.tools).values({
      id: toolId,
      slug: 'app-repo',
      name: 'App repo',
      glyph: 'AR',
      kind: 'repository',
      category: 'npm',
      description: `Folder ${dir}`,
      transport: 'repository',
      url: null,
      command: null,
      repository: { path: dir, scripts: ['test'], timeoutSec: 60 },
      auth: { type: 'none' },
      status: 'connected',
      scopes: ['read', 'search', 'write', 'run', 'git_status'],
      grantedAgents: ['agt_operator'],
      stats: { calls24h: 0, lastCallAt: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(t.agents)
      .set({ tools: [{ toolId, scopes: ['read', 'run'] }] })
      .where(eq(t.agents.slug, 'operator'));

    const client = scripted((p) => {
      if (isPlan(p)) {
        expect(String(p.system)).toContain('  servers: App repo (read, run)\n');
        return plan([
          {
            id: 's1',
            agent: 'operator',
            title: 'Run the tests',
            instructions: '',
            dependsOn: [],
            optional: false,
          },
        ]);
      }
      if (isMerge(p)) return text('merged');
      const names = (p.tools ?? []).map((tool) => (tool as { name: string }).name);
      expect(names).toEqual(expect.arrayContaining(['app-repo__read', 'app-repo__run']));
      expect(names).not.toContain('app-repo__write');
      expect(names).not.toContain('app-repo__git_status');
      const last = p.messages[p.messages.length - 1]!;
      if (
        Array.isArray(last.content) &&
        last.content.some((b) => (b as { type: string }).type === 'tool_result')
      ) {
        const result = JSON.stringify(last.content);
        expect(result).toContain('$ npm run test');
        expect(result).toContain('3 passed');
        expect(result).toContain('exit 0');
        return text('The tests pass: 3 passed.');
      }
      return toolUse('app-repo__run', { script: 'test' });
    });
    const engine = new Engine({ client, getDb: async () => db });
    const run = await createRun(db, { text: 'run the tests', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    expect((await getRun(db, run.id))!.status).toBe('done');
    const events = await listEvents(db, run.id);
    expect(events.some((e) => e.kind === 'tool_call' && e.text.startsWith('App repo · run'))).toBe(
      true,
    );
    const [tool] = await db.select().from(t.tools).where(eq(t.tools.id, toolId));
    expect(tool!.stats.calls24h).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);
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

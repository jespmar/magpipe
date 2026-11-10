import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { Engine } from '@/lib/engine';
import { listEvents } from '@/lib/engine/events';
import { pickRegistrySlug, scriptedModelClient } from '@/lib/engine/stub-model';
import { approveRun, createRun, getRun } from '@/lib/runs';

describe('the scripted model', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
  }, 30_000);
  afterAll(() => close());

  it('picks the first agent without servers, else the first agent', () => {
    const registry = [
      '- coder (Coder, Writes code): x',
      '  model: claude-opus-5-5',
      '  built-in tools: files.read',
      '  servers: GitHub (get_issue)',
      '  memory read: none; write: none',
      '- reviewer (Reviewer, y): z',
      '  model: claude-sonnet-5-5',
      '  built-in tools: files.read',
      '  servers: none',
      '  memory read: none; write: none',
    ].join('\n');
    expect(pickRegistrySlug(registry)).toBe('reviewer');
    expect(pickRegistrySlug(registry.split('\n').slice(0, 5).join('\n'))).toBe('coder');
    expect(pickRegistrySlug('nothing here')).toBeNull();
  });

  it('takes a run through the real engine to done, with a plan, a step and a merged result', async () => {
    const engine = new Engine({ client: scriptedModelClient(), getDb: async () => db });
    const run = await createRun(db, { text: 'Say hello', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    const after = (await getRun(db, run.id))!;
    expect(after.status).toBe('done');
    expect(after.plan.map((s) => s.status)).toEqual(['done', 'done']);
    expect(after.plan[0]!.title).toBe('Answer the task');
    expect(after.output?.markdown).toContain('Merged by the scripted model');
    expect(after.usage.inputTokens).toBeGreaterThan(0);
    const kinds = (await listEvents(db, run.id)).map((e) => e.kind);
    expect(kinds).toContain('plan');
    expect(kinds[kinds.length - 1]).toBe('done');
  }, 20_000);

  it('plans a second step after an agent that waits for approval, and lands once approved', async () => {
    await db.update(t.agents).set({ pauseAfter: true });
    const engine = new Engine({ client: scriptedModelClient(), getDb: async () => db });
    const run = await createRun(db, { text: 'Plan a change', attachments: [] });
    engine.enqueue(run.id);
    await engine.whenIdle();
    const waiting = (await getRun(db, run.id))!;
    expect(waiting.status).toBe('waiting');
    expect(waiting.plan.map((s) => s.title)).toEqual([
      'Answer the task',
      'Carry on after approval',
      'Merge results',
    ]);
    await approveRun(db, run.id);
    engine.enqueue(run.id);
    await engine.whenIdle();
    expect((await getRun(db, run.id))!.status).toBe('done');
    await db.update(t.agents).set({ pauseAfter: false });
  }, 20_000);
});

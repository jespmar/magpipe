/**
 * Run events: written to `run_events` (the durable trail, spec §6) and broadcast in-process so
 * the SSE route can tail a run without polling on every tick. `seq` is the resume cursor (D2).
 */
import { EventEmitter } from 'node:events';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import type { Db } from '../db';
import * as t from '../db/schema';
import { newId } from '../ids';
import type { RunEvent, RunEventKind } from '../schemas';

export type EventInput = {
  runId: string;
  stepId?: string | null;
  agentId?: string | null;
  kind: RunEventKind;
  text: string;
  payload?: unknown;
};

const g = globalThis as unknown as { __magpipeEvents?: EventEmitter };
function bus(): EventEmitter {
  if (!g.__magpipeEvents) {
    g.__magpipeEvents = new EventEmitter();
    g.__magpipeEvents.setMaxListeners(200);
  }
  return g.__magpipeEvents;
}

export async function emitEvent(db: Db, input: EventInput): Promise<RunEvent> {
  const [row] = await db
    .insert(t.runEvents)
    .values({
      id: newId('evt'),
      runId: input.runId,
      ts: new Date(),
      stepId: input.stepId ?? null,
      agentId: input.agentId ?? null,
      kind: input.kind,
      text: input.text.slice(0, 4000),
      payload: input.payload ?? null,
    })
    .returning();
  const event = row as RunEvent;
  bus().emit(`run:${input.runId}`, event);
  return event;
}

/** Live events for one run; returns the unsubscribe function. */
export function subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
  const channel = `run:${runId}`;
  bus().on(channel, listener);
  return () => bus().off(channel, listener);
}

/** The last `limit` events in order, or everything after `afterSeq` (the SSE replay, spec §8). */
export async function listEvents(
  db: Db,
  runId: string,
  opts: { afterSeq?: number; limit?: number } = {},
): Promise<RunEvent[]> {
  const limit = opts.limit ?? 200;
  if (opts.afterSeq !== undefined) {
    return db
      .select()
      .from(t.runEvents)
      .where(and(eq(t.runEvents.runId, runId), gt(t.runEvents.seq, opts.afterSeq)))
      .orderBy(asc(t.runEvents.seq))
      .limit(limit);
  }
  const latest = await db
    .select()
    .from(t.runEvents)
    .where(eq(t.runEvents.runId, runId))
    .orderBy(desc(t.runEvents.seq))
    .limit(limit);
  return latest.reverse();
}

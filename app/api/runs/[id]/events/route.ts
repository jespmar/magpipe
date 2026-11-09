import { NextResponse } from 'next/server';
import { apiError, dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { listEvents, subscribe } from '@/lib/engine/events';
import { getRun } from '@/lib/runs';
import type { RunEvent } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const encoder = new TextEncoder();

function frame(event: RunEvent): Uint8Array {
  return encoder.encode(`id: ${event.seq}\nevent: run_event\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * GET /api/runs/[id]/events — Server-Sent Events (spec §2, §8): replays the last 200 events
 * (or everything after `?after=` / `Last-Event-ID`), then tails the run until the client leaves.
 * A poll every two seconds catches anything the in-process bus missed.
 */
export async function GET(req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  let db;
  try {
    db = await getDb();
  } catch (err) {
    return dbError(err);
  }
  const run = await getRun(db, id);
  if (!run) return apiError('not_found', 'No such run', 404);

  const url = new URL(req.url);
  const cursor = Number(url.searchParams.get('after') ?? req.headers.get('last-event-id') ?? NaN);
  let lastSeq = Number.isFinite(cursor) ? cursor : 0;
  const runId = run.id;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const database = db!;
      let closed = false;
      const send = (event: RunEvent) => {
        if (closed || event.seq <= lastSeq) return;
        lastSeq = event.seq;
        controller.enqueue(frame(event));
      };
      const replay = await listEvents(
        database,
        runId,
        Number.isFinite(cursor) ? { afterSeq: cursor } : {},
      );
      for (const event of replay) send(event);

      const unsubscribe = subscribe(runId, send);
      const poll = setInterval(async () => {
        try {
          for (const event of await listEvents(database, runId, { afterSeq: lastSeq })) send(event);
        } catch {
          /* the next tick retries */
        }
      }, 2000);
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(': ping\n\n'));
      }, 15_000);

      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(poll);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener('abort', close, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

import { NextResponse } from 'next/server';
import { apiError, dbError, parseBody, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { emitEvent } from '@/lib/engine/events';
import { getEngine } from '@/lib/engine';
import { approveRun, getRun } from '@/lib/runs';
import { runApproveInput } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/runs/[id]/approve { note? } — a run waiting for the operator goes on (D30). The
 * steps that were held start, and the note reaches them with the approved result.
 */
export async function POST(req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const body = await parseBody(req, runApproveInput);
  if (!body.ok) return body.res;
  try {
    const db = await getDb();
    const run = await getRun(db, id);
    if (!run) return apiError('not_found', 'No such run', 404);
    if (run.status !== 'waiting') {
      return apiError('not_waiting', 'This run is not waiting for approval.', 409);
    }
    const approved = await approveRun(db, run.id, body.data.note);
    if (!approved) return apiError('not_waiting', 'This run is not waiting for approval.', 409);
    await emitEvent(db, {
      runId: run.id,
      kind: 'message',
      text: body.data.note
        ? `Approved by the operator: ${body.data.note}`
        : 'Approved by the operator.',
    });
    getEngine().enqueue(run.id);
    return NextResponse.json({ run: approved });
  } catch (err) {
    return dbError(err);
  }
}

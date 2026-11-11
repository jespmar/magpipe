import { NextResponse } from 'next/server';
import { apiError, dbError, parseBody, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { sendBackInput } from '@/lib/schemas';
import { LinearNotReadyError, TrackerError } from '@/lib/tracker';
import { GateError, sendBackGoal } from '@/lib/tracker/issues';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/issues/[id]/send-back { note } — the merge question answered no from Magpipe (D42):
 * the goal goes back to the approved status and is built again with the note for the Code Agent.
 */
export async function POST(req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await parseBody(req, sendBackInput);
  if (!body.ok) return body.res;
  const { id } = await params;
  try {
    const issue = await sendBackGoal(await getDb(), id, body.data.note);
    if (!issue) return apiError('not_found', 'No such issue', 404);
    return NextResponse.json({ issue });
  } catch (err) {
    if (err instanceof GateError) return apiError(err.code, err.message, 409);
    if (err instanceof LinearNotReadyError) return apiError(err.code, err.message, 409);
    if (err instanceof TrackerError) return apiError(`tracker_${err.code}`, err.message, 502);
    return dbError(err);
  }
}

import { NextResponse } from 'next/server';
import { apiError, dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { LinearNotReadyError, TrackerError } from '@/lib/tracker';
import { approveIssue, GateError } from '@/lib/tracker/issues';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/issues/[id]/approve — gate G1 from Magpipe (D38): moves the issue to the approved
 * status in Linear, then records it. Linear refusing or out of reach changes nothing.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const issue = await approveIssue(await getDb(), id);
    if (!issue) return apiError('not_found', 'No such issue', 404);
    return NextResponse.json({ issue });
  } catch (err) {
    if (err instanceof GateError) return apiError(err.code, err.message, 409);
    if (err instanceof LinearNotReadyError) return apiError(err.code, err.message, 409);
    if (err instanceof TrackerError) return apiError(`tracker_${err.code}`, err.message, 502);
    return dbError(err);
  }
}

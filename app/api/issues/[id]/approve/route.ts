import { NextResponse } from 'next/server';
import { apiError, dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { LinearNotReadyError, TrackerError } from '@/lib/tracker';
import { getEngine } from '@/lib/engine';
import { startGoalsRun } from '@/lib/factory';
import { approveIssue, GateError, getIssue } from '@/lib/tracker/issues';

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
    const db = await getDb();
    const issue = await approveIssue(db, id);
    if (!issue) return apiError('not_found', 'No such issue', 404);
    // Approval opens gate G1: the goals run starts now (D39). If it cannot, the approval stands
    // and the watcher tries again at its next check.
    let goalsRun: { id: string; displayId: string } | null = null;
    let goalsProblem: string | null = null;
    try {
      const run = await startGoalsRun(db, issue, (runId) => getEngine().enqueue(runId));
      goalsRun = run ? { id: run.id, displayId: run.displayId } : null;
    } catch (err) {
      goalsProblem = err instanceof Error ? err.message : String(err);
    }
    return NextResponse.json({ issue: (await getIssue(db, id)) ?? issue, goalsRun, goalsProblem });
  } catch (err) {
    if (err instanceof GateError) return apiError(err.code, err.message, 409);
    if (err instanceof LinearNotReadyError) return apiError(err.code, err.message, 409);
    if (err instanceof TrackerError) return apiError(`tracker_${err.code}`, err.message, 502);
    return dbError(err);
  }
}

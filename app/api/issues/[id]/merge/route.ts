import { NextResponse } from 'next/server';
import { apiError, dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getEngine } from '@/lib/engine';
import { startLandRun } from '@/lib/factory';
import { GateError, getIssue, requestMerge } from '@/lib/tracker/issues';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/issues/[id]/merge — the merge question answered yes from Magpipe (G2, D42). The land
 * run starts now: it brings the branch up to date, runs the tests again and merges. If it cannot
 * start, the answer stands and the watcher tries again at its next check.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const db = await getDb();
    const issue = await requestMerge(db, id);
    if (!issue) return apiError('not_found', 'No such issue', 404);
    let landRun: { id: string; displayId: string } | null = null;
    let landProblem: string | null = null;
    try {
      const run = await startLandRun(db, issue, (runId) => getEngine().enqueue(runId));
      landRun = run ? { id: run.id, displayId: run.displayId } : null;
    } catch (err) {
      landProblem = err instanceof Error ? err.message : String(err);
    }
    return NextResponse.json({ issue: (await getIssue(db, id)) ?? issue, landRun, landProblem });
  } catch (err) {
    if (err instanceof GateError) return apiError(err.code, err.message, 409);
    return dbError(err);
  }
}

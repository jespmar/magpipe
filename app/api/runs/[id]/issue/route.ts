import { NextResponse } from 'next/server';
import { apiError, dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getRun } from '@/lib/runs';
import { getIssue, goalIssues, issueForRun } from '@/lib/tracker/issues';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/runs/[id]/issue — the Linear issue a factory run concerns (D38, D39): the one a spec
 * run filed, the one a goals run splits, or the goal a build or land run works on; the goals filed
 * under it; and the goals and land runs it started (D42). `issue` is null when there is none.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const db = await getDb();
    const run = await getRun(db, id);
    if (!run) return apiError('not_found', 'No such run', 404);
    const issue = run.input.issueId
      ? await getIssue(db, run.input.issueId)
      : await issueForRun(db, run.id);
    if (!issue) return NextResponse.json({ issue: null, goals: [], goalsRun: null, landRun: null });
    const goals = await goalIssues(db, issue.id);
    const goalsRun = issue.goalsRunId ? await getRun(db, issue.goalsRunId) : undefined;
    const landRun = issue.landRunId ? await getRun(db, issue.landRunId) : undefined;
    const link = (r: typeof goalsRun) =>
      r && r.id !== run.id ? { id: r.id, displayId: r.displayId, status: r.status } : null;
    return NextResponse.json({ issue, goals, goalsRun: link(goalsRun), landRun: link(landRun) });
  } catch (err) {
    return dbError(err);
  }
}

import { NextResponse } from 'next/server';
import { apiError, dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getRun } from '@/lib/runs';
import { getIssue, goalIssues, issueForRun } from '@/lib/tracker/issues';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/runs/[id]/issue — the Linear issue a factory run concerns (D38, D39): the one a spec
 * run filed, or the one a goals run splits; the goals filed under it; and the goals run it
 * started. `issue` is null when there is none.
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
    if (!issue) return NextResponse.json({ issue: null, goals: [], goalsRun: null });
    const goals = await goalIssues(db, issue.id);
    const goalsRun = issue.goalsRunId ? await getRun(db, issue.goalsRunId) : undefined;
    return NextResponse.json({
      issue,
      goals,
      goalsRun:
        goalsRun && goalsRun.id !== run.id
          ? { id: goalsRun.id, displayId: goalsRun.displayId, status: goalsRun.status }
          : null,
    });
  } catch (err) {
    return dbError(err);
  }
}

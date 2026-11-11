import { NextResponse } from 'next/server';
import { apiError, dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getRun } from '@/lib/runs';
import { issueForRun } from '@/lib/tracker/issues';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/runs/[id]/issue — the Linear issue a spec run filed, or null (D38). */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const db = await getDb();
    const run = await getRun(db, id);
    if (!run) return apiError('not_found', 'No such run', 404);
    return NextResponse.json({ issue: (await issueForRun(db, run.id)) ?? null });
  } catch (err) {
    return dbError(err);
  }
}

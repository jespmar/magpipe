import { NextResponse } from 'next/server';
import { apiError, dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getEngine } from '@/lib/engine';
import { getRun } from '@/lib/runs';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/runs/[id]/cancel — aborts a queued, running or waiting run (spec §7.2 step 5, D30). */
export async function POST(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const db = await getDb();
    const run = await getRun(db, id);
    if (!run) return apiError('not_found', 'No such run', 404);
    if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'waiting') {
      return apiError(
        'not_running',
        `This run already ${run.status === 'done' ? 'finished' : run.status}.`,
        409,
      );
    }
    await getEngine().cancel(run.id);
    return NextResponse.json({ run: (await getRun(db, run.id)) ?? run });
  } catch (err) {
    return dbError(err);
  }
}

import { NextResponse } from 'next/server';
import { apiError, dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getEngine } from '@/lib/engine';
import { createRun, getRun } from '@/lib/runs';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/runs/[id]/refly — a new run with the same input, linked by parentRunId. */
export async function POST(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const db = await getDb();
    const parent = await getRun(db, id);
    if (!parent) return apiError('not_found', 'No such run', 404);
    const run = await createRun(db, parent.input, parent.id);
    getEngine().enqueue(run.id);
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    return dbError(err);
  }
}

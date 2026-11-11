import { NextResponse } from 'next/server';
import { apiError, dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getEngine } from '@/lib/engine';
import { FactoryNotReadyError, runDocument, templatePlan } from '@/lib/factory';
import { createRun, getRun } from '@/lib/runs';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/runs/[id]/refly — a new run with the same input, linked by parentRunId. A template
 * run starts from its template again, revising the draft its parent started from (D37).
 */
export async function POST(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const db = await getDb();
    const parent = await getRun(db, id);
    if (!parent) return apiError('not_found', 'No such run', 404);
    let preset: Awaited<ReturnType<typeof templatePlan>> | undefined;
    if (parent.input.template) {
      const source = parent.parentRunId ? await getRun(db, parent.parentRunId) : undefined;
      preset = await templatePlan(db, parent.input.template, {
        draft: source ? runDocument(source.plan) : undefined,
        projectId: parent.input.projectId,
      });
    }
    const run = await createRun(db, parent.input, parent.id, preset);
    getEngine().enqueue(run.id);
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    if (err instanceof FactoryNotReadyError) return apiError(err.code, err.message, 409);
    return dbError(err);
  }
}

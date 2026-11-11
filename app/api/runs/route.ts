import { NextResponse } from 'next/server';
import { apiError, dbError, parseBody, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getEngine } from '@/lib/engine';
import { FactoryNotReadyError, runDocument, templatePlan } from '@/lib/factory';
import { createRun, getRun, listRuns } from '@/lib/runs';
import { runCreateInput, runStatuses, type RunStatus } from '@/lib/schemas';
import { attachmentsFor, UploadError } from '@/lib/uploads';

export const dynamic = 'force-dynamic';

/** GET /api/runs?status=&q=&limit= — the list with counts for the filter pills (spec §8). */
export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  if (status && !(runStatuses as readonly string[]).includes(status)) {
    return apiError('validation', `status must be one of ${runStatuses.join(', ')}`);
  }
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
  try {
    const result = await listRuns(await getDb(), {
      status: (status as RunStatus | null) ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
      limit,
    });
    return NextResponse.json(result);
  } catch (err) {
    return dbError(err);
  }
}

/**
 * POST /api/runs { text, attachmentIds, parentRunId?, template? } — creates the run and hands it
 * to the engine. With `parentRunId` the run is a follow-up: that run's task and answer (and its
 * own ancestors') become the conversation the new run continues. With `template` the run starts
 * from the factory template's plan (D37); a follow-up revises the document its parent handed over.
 */
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await parseBody(req, runCreateInput);
  if (!body.ok) return body.res;
  try {
    const db = await getDb();
    const parent = body.data.parentRunId ? await getRun(db, body.data.parentRunId) : undefined;
    if (body.data.parentRunId && !parent) {
      return apiError('not_found', 'The run to follow up on no longer exists', 404);
    }
    const preset = body.data.template
      ? await templatePlan(db, body.data.template, {
          draft: parent ? runDocument(parent.plan) : undefined,
        })
      : undefined;
    const attachments = await attachmentsFor(body.data.attachmentIds);
    const run = await createRun(
      db,
      {
        text: body.data.text,
        attachments,
        ...(body.data.template ? { template: body.data.template } : {}),
      },
      body.data.parentRunId ?? null,
      preset,
    );
    getEngine().enqueue(run.id);
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    if (err instanceof UploadError) return apiError(err.code, err.message);
    if (err instanceof FactoryNotReadyError) return apiError(err.code, err.message, 409);
    return dbError(err);
  }
}

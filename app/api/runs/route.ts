import { NextResponse } from 'next/server';
import { apiError, dbError, parseBody, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getEngine } from '@/lib/engine';
import { createRun, listRuns } from '@/lib/runs';
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

/** POST /api/runs { text, attachmentIds } — creates the run and hands it to the engine. */
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await parseBody(req, runCreateInput);
  if (!body.ok) return body.res;
  try {
    const attachments = await attachmentsFor(body.data.attachmentIds);
    const run = await createRun(await getDb(), { text: body.data.text, attachments });
    getEngine().enqueue(run.id);
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    if (err instanceof UploadError) return apiError(err.code, err.message);
    return dbError(err);
  }
}

import { NextResponse } from 'next/server';
import { apiError, dbError, parseBody, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getRun, setRunDismissed } from '@/lib/runs';
import { runPatchInput } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/runs/[id] { dismissed } — close or reopen a finished run's card on Home. */
export async function PATCH(req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const body = await parseBody(req, runPatchInput);
  if (!body.ok) return body.res;
  try {
    const db = await getDb();
    const run = await getRun(db, id);
    if (!run) return apiError('not_found', 'No such run', 404);
    if (body.data.dismissed && (run.status === 'queued' || run.status === 'running')) {
      return apiError('conflict', 'A flight can be closed once it has landed', 409);
    }
    const updated = await setRunDismissed(db, run.id, body.data.dismissed);
    return NextResponse.json({ run: updated });
  } catch (err) {
    return dbError(err);
  }
}

/** GET /api/runs/[id] — by run id or display id. */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const run = await getRun(await getDb(), id);
    return run ? NextResponse.json({ run }) : apiError('not_found', 'No such run', 404);
  } catch (err) {
    return dbError(err);
  }
}

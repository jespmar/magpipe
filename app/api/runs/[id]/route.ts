import { NextResponse } from 'next/server';
import { apiError, dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getRun } from '@/lib/runs';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

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

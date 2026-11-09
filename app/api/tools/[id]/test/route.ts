import { NextResponse } from 'next/server';
import { apiError, dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { retestTool } from '@/lib/tools';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/tools/[id]/test — "Test again": probes the saved connection and records the result. */
export async function POST(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const result = await retestTool(await getDb(), id);
    return result ? NextResponse.json(result) : apiError('not_found', 'No such tool', 404);
  } catch (err) {
    return dbError(err);
  }
}

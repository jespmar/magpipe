import { NextResponse } from 'next/server';
import { apiError, dbError, parseBody, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { deleteMemory, getMemory, updateMemory } from '@/lib/memory';
import { memoryPatch } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const entry = await getMemory(await getDb(), id);
    return entry ? NextResponse.json({ entry }) : apiError('not_found', 'No such memory', 404);
  } catch (err) {
    return dbError(err);
  }
}

/** PATCH { value?, confidence?, source?, expiresAt?, data?, verified?: true }. */
export async function PATCH(req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const body = await parseBody(req, memoryPatch);
  if (!body.ok) return body.res;
  try {
    const entry = await updateMemory(await getDb(), id, body.data);
    return entry ? NextResponse.json({ entry }) : apiError('not_found', 'No such memory', 404);
  } catch (err) {
    return dbError(err);
  }
}

/** DELETE — "Forget". */
export async function DELETE(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const removed = await deleteMemory(await getDb(), id);
    return removed
      ? new NextResponse(null, { status: 204 })
      : apiError('not_found', 'No such memory', 404);
  } catch (err) {
    return dbError(err);
  }
}

import { NextResponse } from 'next/server';
import { apiError, dbError, parseBody, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { toolPatch } from '@/lib/schemas';
import { SecretKeyError } from '@/lib/secrets';
import { deleteTool, getTool, ToolValidationError, updateTool } from '@/lib/tools';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const tool = await getTool(await getDb(), id);
    return tool ? NextResponse.json({ tool }) : apiError('not_found', 'No such tool', 404);
  } catch (err) {
    return dbError(err);
  }
}

/** PATCH { …fields, auth: { token } } edits; a new token or address re-tests the connection. */
export async function PATCH(req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const body = await parseBody(req, toolPatch);
  if (!body.ok) return body.res;
  try {
    const result = await updateTool(await getDb(), id, body.data);
    return result ? NextResponse.json(result) : apiError('not_found', 'No such tool', 404);
  } catch (err) {
    if (err instanceof ToolValidationError || err instanceof SecretKeyError) {
      return apiError(err.code, err.message);
    }
    return dbError(err);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const removed = await deleteTool(await getDb(), id);
    return removed
      ? new NextResponse(null, { status: 204 })
      : apiError('not_found', 'No such tool', 404);
  } catch (err) {
    if (err instanceof ToolValidationError) return apiError(err.code, err.message);
    return dbError(err);
  }
}

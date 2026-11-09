import { NextResponse } from 'next/server';
import { AgentValidationError, deleteAgent, getAgent, updateAgent } from '@/lib/agents';
import { apiError, dbError, parseBody, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { agentPatch } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const agent = await getAgent(await getDb(), id);
    return agent ? NextResponse.json({ agent }) : apiError('not_found', 'No such agent', 404);
  } catch (err) {
    return dbError(err);
  }
}

/** PATCH { …fields } edits; PATCH { status: 'paused' | 'idle' } pauses or resumes. */
export async function PATCH(req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const body = await parseBody(req, agentPatch);
  if (!body.ok) return body.res;
  try {
    const agent = await updateAgent(await getDb(), id, body.data);
    return agent ? NextResponse.json({ agent }) : apiError('not_found', 'No such agent', 404);
  } catch (err) {
    if (err instanceof AgentValidationError) return apiError(err.code, err.message);
    return dbError(err);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  try {
    const removed = await deleteAgent(await getDb(), id);
    return removed
      ? new NextResponse(null, { status: 204 })
      : apiError('not_found', 'No such agent', 404);
  } catch (err) {
    return dbError(err);
  }
}

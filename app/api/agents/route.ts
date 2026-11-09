import { NextResponse } from 'next/server';
import { AgentValidationError, createAgent, listAgents } from '@/lib/agents';
import { apiError, dbError, parseBody, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { agentInput } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

/** GET /api/agents — every agent with its 7-day stats. */
export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    return NextResponse.json({ agents: await listAgents(await getDb()) });
  } catch (err) {
    return dbError(err);
  }
}

/** POST /api/agents — create an agent. */
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await parseBody(req, agentInput);
  if (!body.ok) return body.res;
  try {
    const agent = await createAgent(await getDb(), body.data);
    return NextResponse.json({ agent }, { status: 201 });
  } catch (err) {
    if (err instanceof AgentValidationError) return apiError(err.code, err.message);
    return dbError(err);
  }
}

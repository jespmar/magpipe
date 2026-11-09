import { NextResponse } from 'next/server';
import { parseBody, requireUser } from '@/lib/api';
import { toolConnectInput } from '@/lib/schemas';
import { testConnection } from '@/lib/tools';

export const dynamic = 'force-dynamic';

/** POST /api/tools/test — probes a connection described by the Connect JSON without saving it. */
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await parseBody(req, toolConnectInput);
  if (!body.ok) return body.res;
  return NextResponse.json({ probe: await testConnection(body.data) });
}

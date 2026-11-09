import { NextResponse } from 'next/server';
import { apiError, dbError, parseBody, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { toolConnectInput } from '@/lib/schemas';
import { SecretKeyError } from '@/lib/secrets';
import { connectTool, listTools, ToolValidationError } from '@/lib/tools';

export const dynamic = 'force-dynamic';

/** GET /api/tools — the registry. Credentials never leave the server; rows carry a `secretRef` only. */
export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    return NextResponse.json({ tools: await listTools(await getDb()) });
  } catch (err) {
    return dbError(err);
  }
}

/** POST /api/tools — "Connect & test": saves the tool with the status the probe found. */
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await parseBody(req, toolConnectInput);
  if (!body.ok) return body.res;
  try {
    const result = await connectTool(await getDb(), body.data);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ToolValidationError || err instanceof SecretKeyError) {
      return apiError(err.code, err.message);
    }
    return dbError(err);
  }
}

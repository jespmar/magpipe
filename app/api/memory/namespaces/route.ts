import { NextResponse } from 'next/server';
import { apiError, dbError, parseBody, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { createNamespace, listNamespaces, MemoryValidationError } from '@/lib/memory';
import { namespaceInput } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    return NextResponse.json({ namespaces: await listNamespaces(await getDb()) });
  } catch (err) {
    return dbError(err);
  }
}

/** POST /api/memory/namespaces { label } — namespaces are user-creatable (D8). */
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await parseBody(req, namespaceInput);
  if (!body.ok) return body.res;
  try {
    const namespace = await createNamespace(await getDb(), body.data.label);
    return NextResponse.json({ namespace }, { status: 201 });
  } catch (err) {
    if (err instanceof MemoryValidationError) return apiError(err.code, err.message);
    return dbError(err);
  }
}

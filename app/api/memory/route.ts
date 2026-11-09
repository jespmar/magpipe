import { NextResponse } from 'next/server';
import { apiError, dbError, parseBody, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import {
  listMemory,
  listNamespaces,
  memoryHealth,
  MemoryValidationError,
  writeMemory,
} from '@/lib/memory';
import { memoryInput } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

/** GET /api/memory?ns=&q= — entries (full-text search over key and value), namespaces, health. */
export async function GET(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const url = new URL(req.url);
  const ns = url.searchParams.get('ns') ?? undefined;
  const q = url.searchParams.get('q') ?? undefined;
  try {
    const db = await getDb();
    const [entries, namespaces, health] = await Promise.all([
      listMemory(db, { ns, q }),
      listNamespaces(db),
      memoryHealth(db),
    ]);
    return NextResponse.json({ entries, namespaces, health });
  } catch (err) {
    return dbError(err);
  }
}

/** POST /api/memory — write a fact; the same (ns, key) becomes a new version of that fact. */
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await parseBody(req, memoryInput);
  if (!body.ok) return body.res;
  try {
    const result = await writeMemory(await getDb(), body.data);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    if (err instanceof MemoryValidationError) return apiError(err.code, err.message);
    return dbError(err);
  }
}

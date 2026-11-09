import { NextResponse } from 'next/server';
import { dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { memoryHealth } from '@/lib/memory';

export const dynamic = 'force-dynamic';

/** GET /api/memory/health — facts, stale, conflicts, expired, verified %. Computed on read (D14). */
export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    return NextResponse.json({ health: await memoryHealth(await getDb()) });
  } catch (err) {
    return dbError(err);
  }
}

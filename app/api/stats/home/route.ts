import { NextResponse } from 'next/server';
import { dbError, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { homeStats } from '@/lib/runs';

export const dynamic = 'force-dynamic';

/** GET /api/stats/home — { activeAgents, runsToday, queued, tokensToday, spendToday }. */
export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    return NextResponse.json(await homeStats(await getDb()));
  } catch (err) {
    return dbError(err);
  }
}

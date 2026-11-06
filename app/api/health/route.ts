import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Public liveness probe. The Electron main process polls it before showing the window.
 * Opens the database on the first call (migrations + first-launch setup), so the window only
 * appears once Magpipe is ready. Stays 200 when the database fails, so the UI can explain why.
 */
export async function GET() {
  let db: 'up' | 'down' = 'down';
  try {
    await (await getDb()).execute(sql`select 1`);
    db = 'up';
  } catch {
    /* reported by the app shell banner */
  }
  return NextResponse.json({ ok: true, version: process.env.NEXT_PUBLIC_APP_VERSION, db });
}

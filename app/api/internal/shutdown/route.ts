import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { accessMode } from '@/lib/auth-mode';
import { closeDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Desktop only: the Electron main process calls this on quit so the embedded database is
 * flushed and closed before the server exits (killing the process outright is abrupt on
 * Windows). Middleware has already checked the desktop token.
 */
export async function POST() {
  if (accessMode() !== 'desktop') return apiError('not_found', 'Not found', 404);
  await closeDb();
  setTimeout(() => process.exit(0), 50);
  return NextResponse.json({ ok: true });
}

import { NextResponse } from 'next/server';
import { apiError, dbError, parseBody, requireUser } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getEngine } from '@/lib/engine';
import { settingsPatch } from '@/lib/schemas';
import { getSettings, updateSettings } from '@/lib/settings';
import { spendToday } from '@/lib/spend';

export const dynamic = 'force-dynamic';

/** GET /api/settings: the workspace settings and today's spend against the cap (D32). */
export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  try {
    const db = await getDb();
    const [settings, spend] = await Promise.all([getSettings(db), spendToday(db)]);
    return settings
      ? NextResponse.json({ settings, spendToday: spend })
      : apiError('not_found', 'The workspace has no settings yet', 404);
  } catch (err) {
    return dbError(err);
  }
}

/**
 * PATCH /api/settings { spendCapUsd?, maxRuns? }: the daily spend cap in dollars, 0 meaning no
 * cap (D32), and how many runs work at once (D41), which the engine takes at once.
 */
export async function PATCH(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const body = await parseBody(req, settingsPatch);
  if (!body.ok) return body.res;
  try {
    const settings = await updateSettings(await getDb(), body.data);
    if (settings && body.data.maxRuns !== undefined) getEngine().setConcurrency(settings.maxRuns);
    return settings
      ? NextResponse.json({ settings })
      : apiError('not_found', 'The workspace has no settings yet', 404);
  } catch (err) {
    return dbError(err);
  }
}

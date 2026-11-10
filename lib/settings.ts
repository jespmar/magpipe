/** Workspace settings: the single `settings` row. The spend cap is the first editable one (D32). */
import { eq } from 'drizzle-orm';
import type { Db } from './db';
import * as t from './db/schema';
import type { Settings, SettingsPatch } from './schemas';

export async function getSettings(db: Db): Promise<Settings | null> {
  const [row] = await db.select().from(t.settings).limit(1);
  return row ?? null;
}

/** Applies a validated patch (`settingsPatch`); null when the workspace has no settings row. */
export async function updateSettings(db: Db, patch: SettingsPatch): Promise<Settings | null> {
  const [row] = await db
    .update(t.settings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(t.settings.id, 'settings'))
    .returning();
  return row ?? null;
}

/** The daily spend cap (D32): today's spend in one query, the stop message, and editing the cap. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { newId } from '@/lib/ids';
import { SPEND_CAP_MAX_USD, settingsPatch, type Step } from '@/lib/schemas';
import { getSettings, updateSettings } from '@/lib/settings';
import { capReached, capText, spendCapMessage, spendToday, startOfLocalDay } from '@/lib/spend';

const usage = (costUsd: number) => ({ inputTokens: 10, outputTokens: 5, costUsd });

describe('settingsPatch', () => {
  const cap = (spendCapUsd: unknown) => settingsPatch.safeParse({ spendCapUsd });

  it('takes a non-negative number of dollars, rounded to the cent; 0 means no cap', () => {
    expect(cap(0).data).toEqual({ spendCapUsd: 0 });
    expect(cap(75).data).toEqual({ spendCapUsd: 75 });
    expect(cap(12.346).data).toEqual({ spendCapUsd: 12.35 });
    expect(cap(SPEND_CAP_MAX_USD).data).toEqual({ spendCapUsd: SPEND_CAP_MAX_USD });
  });

  it('refuses a negative cap, one past the bound, and anything that is not a number', () => {
    expect(cap(-1).error?.issues[0]?.message).toMatch(/can’t be negative/);
    expect(cap(SPEND_CAP_MAX_USD + 1).error?.issues[0]?.message).toBe(
      'The cap can be at most $10,000',
    );
    for (const bad of ['50', Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(cap(bad).success).toBe(false);
    }
    expect(settingsPatch.safeParse({}).success).toBe(false);
  });
});

describe('the stop message', () => {
  it('names the spend, the cap and what did not start', () => {
    const spend = { capUsd: 50, spentUsd: 50.123 };
    expect(capReached(spend)).toBe(true);
    expect(capReached({ capUsd: 50, spentUsd: 49.99 })).toBe(false);
    expect(capReached({ capUsd: null, spentUsd: 1_000 })).toBe(false);
    expect(spendCapMessage(spend, '“Draft the change”')).toBe(
      'Today’s spend ($50.12) reached the $50.00 cap, so the run stopped before “Draft the change”. Raise the cap in Settings to go on.',
    );
    expect(capText(0)).toBe('no cap');
    expect(capText(12.5)).toBe('$12.50');
  });

  it('starts the day at local midnight', () => {
    const day = startOfLocalDay(new Date(2026, 10, 10, 15, 42, 7));
    expect([day.getFullYear(), day.getMonth(), day.getDate(), day.getHours()]).toEqual([
      2026, 10, 10, 0,
    ]);
    expect(day.getMinutes() + day.getSeconds() + day.getMilliseconds()).toBe(0);
  });
});

describe('spendToday and the editable cap', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
  }, 30_000);
  afterAll(() => close());
  beforeEach(async () => {
    await db.delete(t.runs);
  });

  const insertRun = async (
    status: 'done' | 'running' | 'failed',
    costUsd: number,
    createdAt: Date,
    plan: Step[] = [],
  ) => {
    const id = newId('run');
    await db.insert(t.runs).values({
      id,
      displayId: `flight_${id.slice(4)}`,
      input: { text: 'spend', attachments: [] },
      status,
      plan,
      startedAt: createdAt,
      finishedAt: null,
      durationMs: null,
      usage: usage(costUsd),
      output: null,
      parentRunId: null,
      dismissedAt: null,
      createdBy: 'test',
      createdAt,
    });
  };

  it('sums today’s runs, adds the steps of a run still going, and leaves yesterday out', async () => {
    const now = new Date();
    const yesterday = new Date(startOfLocalDay(now).getTime() - 60 * 60 * 1000);
    await insertRun('done', 1.5, now);
    await insertRun('failed', 0.25, now);
    // A run still going holds its plan's cost in `usage` and its steps' cost on the steps.
    await insertRun('running', 0.2, now, [
      { id: 's1', agentId: null, title: 'a', dependsOn: [], status: 'done', usage: usage(0.3) },
      { id: 's2', agentId: null, title: 'b', dependsOn: [], status: 'live', usage: usage(0.4) },
      { id: 's3', agentId: null, title: 'c', dependsOn: [], status: 'todo' },
    ]);
    await insertRun('done', 100, yesterday);
    expect(await spendToday(db, now)).toEqual({ capUsd: 50, spentUsd: 2.65 });
  });

  it('reads no cap for 0, and the cap the operator saved', async () => {
    expect((await spendToday(db)).spentUsd).toBe(0);
    const saved = await updateSettings(db, settingsPatch.parse({ spendCapUsd: 0 }));
    expect(saved?.spendCapUsd).toBe(0);
    expect(await spendToday(db)).toEqual({ capUsd: null, spentUsd: 0 });

    const before = (await getSettings(db))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await updateSettings(db, settingsPatch.parse({ spendCapUsd: 75.5 }));
    const after = (await getSettings(db))!;
    expect(after.spendCapUsd).toBe(75.5);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    expect((await spendToday(db)).capUsd).toBe(75.5);
    await updateSettings(db, { spendCapUsd: 50 });
  });
});

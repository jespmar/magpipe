import { expect, test } from '@playwright/test';

// Shell smoke tests, run in file order against one fresh database. The three product flows
// (spec §10, PR 8) are added alongside them.

test('fresh workspace: nav reaches every screen, marks the active link, offers the demo data', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: 'No agents flying right now' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Magpipe/ }).first()).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    page.getByRole('region', { name: 'The nest' }).getByText('no runs yet'),
  ).toBeVisible();

  for (const link of ['Agents', 'Runs', 'Tools', 'Memory'] as const) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: link }).click();
    // The dev server compiles each route on its first visit; production answers in a beat.
    await expect(page.getByRole('heading', { level: 1, name: link })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('link', { name: link, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    if (link !== 'Agents') {
      await expect(page.getByRole('link', { name: 'Load demo data' })).toHaveAttribute(
        'href',
        '/settings#demo',
      );
    }
  }

  // Client-side navigation to the anchor scrolls the section in and focuses its heading.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Load demo data' }).click();
  // First visit of Settings in this file: a cold compile on the dev server.
  await expect(page.getByRole('heading', { level: 2, name: 'Demo data' })).toBeFocused({
    timeout: 15_000,
  });
  await expect(page.getByRole('heading', { level: 2, name: 'Demo data' })).toBeInViewport();
});

test('settings loads the demo data after a confirm step and reports the result', async ({
  page,
}) => {
  await page.goto('/settings');
  const trigger = page.getByRole('button', { name: 'Load demo data' });
  await trigger.click();
  await expect(
    page.getByText(/adds 9 example tools, 12 memories and 4 finished runs/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load it' })).toBeFocused();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole('button', { name: 'Load it' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Loaded 9 tools/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load it again' })).toBeFocused();
  await page.getByRole('link', { name: 'See the flights' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Runs' }).getByRole('listitem')).toHaveCount(4);

  await page.goto('/tools');
  await expect(page.getByRole('article', { name: 'Visma.net' })).toBeVisible();
  await expect(
    page.getByRole('article', { name: 'Younium' }).getByText('Needs auth'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Load demo data' })).toHaveCount(0);
  await page.goto('/memory');
  await expect(
    page
      .getByRole('navigation', { name: 'Namespaces' })
      .getByRole('button', { name: /^Rate limits/ }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Memories' }).getByRole('listitem')).toHaveCount(
    12,
  );
  await page.goto('/runs');
  // The latest flight is selected by default; its path and log open from the same card.
  await page.getByRole('link', { name: 'Open log' }).click();
  // First visit of the run page: the dev server compiles it while it also serves the ledger's
  // replayed trail, so the landing can take a few seconds here; production answers in a beat.
  await expect(page).toHaveURL(/\/runs\/flight_[0-9a-z]+$/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/^flight_/);
  await expect(page.getByText(/^took \d\d:\d\d$/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('done', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Flight path' }).getByRole('listitem'),
  ).not.toHaveCount(0);
  // The demo never touches workspace settings: the footer keeps its own region label.
  await expect(page.locator('footer')).not.toContainText('eu-north-1');
});

test('settings changes the daily spend cap and refuses one that is not a cap', async ({ page }) => {
  await page.goto('/settings');
  const spend = page.getByRole('region', { name: 'Spend cap' });
  const field = spend.getByRole('textbox', { name: 'Cap per day, in dollars' });
  const save = spend.getByRole('button', { name: 'Save cap' });
  await expect(field).toHaveValue('50.00');
  await expect(spend.getByRole('definition').filter({ hasText: '$50.00' })).toBeVisible();

  // Refused beside the field, before anything is sent.
  await field.fill('-5');
  await save.click();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(spend.getByRole('alert')).toContainText(
    'The cap can’t be negative. Use 0 for no cap',
  );

  await field.fill('75');
  await expect(field).not.toHaveAttribute('aria-invalid', 'true');
  await save.click();
  await expect(spend.getByRole('button', { name: 'Saved' })).toBeVisible();
  await expect(spend.getByRole('definition').filter({ hasText: '$75.00' })).toBeVisible();
  await page.reload();
  await expect(field).toHaveValue('75.00');
});

test('unknown addresses keep the shell, answer 404, and offer a way back', async ({ page }) => {
  const res = await page.goto('/no-such-page');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: 'This bird flew off' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Magpipe' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'No agents flying right now' }),
  ).toBeVisible();

  const run = await page.goto('/runs/flight_nope');
  expect(run?.status()).toBe(404);
  await expect(page).toHaveTitle(/Flight not found/);
  await expect(page.getByRole('heading', { level: 1, name: 'This bird flew off' })).toBeVisible();
});

test('keyboard users get a skip link straight to the content', async ({ page }) => {
  await page.goto('/agents');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await skip.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
});

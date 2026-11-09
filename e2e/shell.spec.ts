import { expect, test } from '@playwright/test';

// Shell smoke tests, run in file order against one fresh database. The three product flows
// (spec §10, PR 8) are added alongside them.

test('fresh workspace: nav reaches every screen, marks the active link, offers the demo data', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Birds on the wire' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Magpipe/ }).first()).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByText('no flights yet')).toBeVisible();

  for (const [link, eyebrow] of [
    ['Agents', 'The flock'],
    ['Runs', 'Flights'],
    ['Tools', 'Beaks & claws'],
    ['Memory', 'The nest'],
  ] as const) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: link }).click();
    await expect(page.getByRole('heading', { level: 1, name: link })).toBeVisible();
    await expect(page.getByText(eyebrow, { exact: true })).toBeVisible();
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

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
});

test('settings loads the demo data after a confirm step and reports the result', async ({
  page,
}) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Load demo data' }).click();
  await expect(
    page.getByText(/adds 9 example tools, 12 memories and 4 finished flights/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load it' })).toBeFocused();
  await page.getByRole('button', { name: 'Load it' }).click();
  const status = page.getByRole('status').filter({ hasText: /Loaded 9 tools/ });
  await expect(status).toBeVisible();
  await expect(status).toBeFocused();

  await page.goto('/tools');
  await expect(page.getByRole('heading', { level: 2, name: '9 tools in the kit' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Load demo data' })).toHaveCount(0);
  await page.goto('/memory');
  await expect(page.getByRole('heading', { level: 2, name: /holds 12 memories/ })).toBeVisible();
  await page.goto('/runs');
  await page.getByRole('link', { name: 'Open the latest flight' }).click();
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/^flight_/);
  await expect(page.getByText(/^took \d\d:\d\d$/)).toBeVisible();
});

test('unknown addresses keep the shell, answer 404, and offer a way back', async ({ page }) => {
  const res = await page.goto('/no-such-page');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: 'This bird flew off' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Magpipe' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Birds on the wire' })).toBeVisible();

  const run = await page.goto('/runs/flight_nope');
  expect(run?.status()).toBe(404);
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

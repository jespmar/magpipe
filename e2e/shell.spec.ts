import { expect, test } from '@playwright/test';

// Shell smoke test. The three product flows (spec §10, PR 8) are added alongside it.
test('nav reaches every screen and marks the active link', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Birds on the wire' })).toBeVisible();

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
  }

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
});

test('settings loads the demo data into the embedded database', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Load demo data' }).click();
  await page.waitForLoadState('networkidle');
  await page.goto('/tools');
  await expect(page.getByText('9 tools in the database')).toBeVisible();
  await page.goto('/memory');
  await expect(page.getByText(/1[2-9] memory entries in the database/)).toBeVisible();
});

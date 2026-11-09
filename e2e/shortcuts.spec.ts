import { expect, test } from '@playwright/test';

// Keyboard shortcuts (spec §10, PR 8): `?` lists them, `/` finds the search, `g` + a letter
// changes screen, `n` goes home with the prompt ready. None of them fire while typing.

test('the shortcuts reach every screen and stay out of text fields', async ({ page }) => {
  await page.goto('/agents');

  await page.keyboard.press('Shift+?');
  const sheet = page.getByRole('dialog', { name: 'Keyboard' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Go to Runs')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // `/` focuses the screen's search; while typing there, `g` is just a letter.
  await page.keyboard.press('/');
  const search = page.getByLabel('Search agents');
  await expect(search).toBeFocused();
  await page.keyboard.type('g r');
  await expect(search).toHaveValue('g r');
  await expect(page).toHaveURL(/\/agents$/);
  await search.blur();

  await page.keyboard.press('g');
  await page.keyboard.press('r');
  await expect(page).toHaveURL(/\/runs$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();

  await page.keyboard.press('g');
  await page.keyboard.press('m');
  await expect(page.getByRole('heading', { level: 1, name: 'Memory' })).toBeVisible();

  // `n` goes home with the cursor in the prompt, and the flag leaves the address.
  await page.keyboard.press('n');
  await expect(page.getByRole('heading', { level: 1, name: 'Birds on the wire' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Ask Magpipe' })).toBeFocused();
  await expect.poll(() => new URL(page.url()).searchParams.has('focus')).toBe(false);

  // Settings lists the same shortcuts.
  await page.goto('/settings');
  await expect(
    page
      .getByRole('region', { name: 'Keyboard' })
      .getByText('New run: go home with the prompt ready'),
  ).toBeVisible();
});

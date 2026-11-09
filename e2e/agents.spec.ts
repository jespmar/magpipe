import { expect, test } from '@playwright/test';

// The Agents screen (spec §3.3, PR 2): add a bird, inspect it, pause it, edit it, remove it.
// Independent of the demo data, so it can run beside the shell smoke tests.

test('add a bird, then pause, filter, edit and remove it', async ({ page }) => {
  // A unique name keeps reruns against the same database honest.
  const name = `Night Scout ${Date.now().toString(36)}`;
  await page.goto('/agents?new=1');
  const dialog = page.getByRole('dialog', { name: 'Add a bird' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Name')).toBeFocused();

  // Escape closes without saving; the deep link does not reopen it.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.has('new')).toBe(false);

  await page.getByRole('button', { name: '+ Add a bird' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Role').fill('Finds things after dark');
  await dialog.getByLabel('Model').selectOption('claude-haiku-5-5');
  await dialog.getByRole('checkbox', { name: 'web.search' }).check();
  await dialog.getByRole('button', { name: 'Add to the flock' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Added to the flock.' })).toBeVisible();
  const detail = page.getByRole('complementary', { name });
  await expect(detail).toBeVisible();
  await expect(detail.getByText('Finds things after dark')).toBeVisible();
  await expect(detail.getByText('web.search')).toBeVisible();
  await expect(detail.getByText('No memory access')).toBeVisible();
  // No runs yet: the numbers that cannot be computed say so instead of showing zero.
  await expect(detail.getByText('runs · 7d')).toBeVisible();
  await expect(detail.getByText('—')).toHaveCount(2);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('agent'))
    .toMatch(/^night-scout-[a-z0-9]+$/);

  // Pause flips the pill and the control; a paused bird files under Idle.
  await page.getByRole('button', { name: `Pause ${name}` }).click();
  await expect(page.getByRole('status').filter({ hasText: `${name} paused.` })).toBeVisible();
  const row = page.getByRole('button', { name: new RegExp(`^${name}`) });
  await expect(row).toContainText('paused');
  await expect(page.getByRole('button', { name: `Resume ${name}` })).toBeVisible();

  await page.getByRole('button', { name: /^Running/ }).click();
  await expect(page.getByText('No agents with this status.')).toBeVisible();
  await page.getByRole('button', { name: /^Idle/ }).click();
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: /^All/ }).click();

  await page.getByRole('searchbox', { name: 'Search agents' }).fill(name.slice(-5));
  await expect(page.getByRole('region', { name: 'Agents' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search agents' }).fill('');

  // Edit keeps everything that was not touched.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: `Edit ${name}` });
  await expect(edit).toBeVisible();
  await expect(edit.getByRole('checkbox', { name: 'web.search' })).toBeChecked();
  await edit.getByLabel('Role').fill('Finds things in the dark');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Changes saved.' })).toBeVisible();
  await expect(detail.getByText('Finds things in the dark')).toBeVisible();
  await expect(detail.getByText('web.search')).toBeVisible();

  // Removal asks once, then the bird is gone from the roster.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await edit.getByRole('button', { name: 'Remove from the flock' }).click();
  await expect(edit.getByText(`Remove ${name} from the flock?`)).toBeVisible();
  await edit.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: 'Removed from the flock.' }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
});

test('the editor names the problem when the server refuses a save', async ({ page }) => {
  await page.goto('/agents?new=1');
  const dialog = page.getByRole('dialog', { name: 'Add a bird' });
  await page.route('**/api/agents', (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'validation', message: 'Unknown tool: tool_nope' } }),
    }),
  );
  await dialog.getByLabel('Name').fill('Ghost');
  await dialog.getByRole('button', { name: 'Add to the flock' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Unknown tool: tool_nope');
  await expect(dialog).toBeVisible();
});

import { expect, test } from '@playwright/test';

// The Memory screen (spec §3.6, PR 4): add a fact, read it in full, narrow by namespace,
// search, edit it into a new version, verify it, forget it. Independent of the demo data
// except for the namespaces it creates; the test adds its own namespace too.

test('add a fact, browse, edit, verify and forget it', async ({ page }) => {
  const stamp = Date.now().toString(36);
  const key = `e2e.fact.${stamp}`;
  await page.goto('/memory?new=1');
  const dialog = page.getByRole('dialog', { name: 'Add a fact' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Key')).toBeFocused();

  // Validation speaks in the form, not in browser bubbles.
  await dialog.getByLabel('Value').fill('x');
  await dialog.getByRole('button', { name: 'Add to the nest' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Give the fact a key');

  await dialog.getByLabel('Namespace').selectOption('facts');
  await dialog.getByLabel('Key').fill(key);
  await dialog.getByLabel('Value').fill('Nightly SIE import runs at 02:00 UTC');
  await dialog.getByLabel('Confidence').fill('0.8');
  await dialog.getByLabel('Source').fill('ops runbook');
  await dialog.getByLabel('Expires').fill('2027-01-31');
  await dialog.getByRole('button', { name: 'Add to the nest' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Added to the nest.' })).toBeVisible();

  const detail = page.getByRole('complementary', { name: 'Nightly SIE import runs at 02:00 UTC' });
  await expect(detail).toBeVisible();
  await expect(detail.getByText(`facts / ${key}`)).toBeVisible();
  await expect(detail.getByText('0.80', { exact: true })).toBeVisible();
  await expect(detail.getByText('ops runbook', { exact: true })).toBeVisible();
  await expect(detail.getByText('2027-01-31', { exact: true })).toBeVisible();
  const row = page
    .getByRole('region', { name: 'Memories' })
    .getByRole('button', { name: new RegExp(key) });
  await expect(row).toContainText('you');

  // Narrowing by namespace and by search keeps the detail in step.
  const nav = page.getByRole('navigation', { name: 'Namespaces' });
  await nav.getByRole('button', { name: /^Decisions/ }).click();
  await expect(row).toHaveCount(0);
  await nav.getByRole('button', { name: /^All/ }).click();
  await page.getByRole('searchbox', { name: 'Search memory' }).fill(stamp);
  await expect(page.getByRole('region', { name: 'Memories' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search memory' }).fill('');

  // Editing writes a new version; the raw record counts it.
  await row.click();
  await detail.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: `Edit ${key}` });
  await expect(edit.getByLabel('Key')).toBeDisabled();
  await edit.getByLabel('Value').fill('Nightly SIE import runs at 03:00 UTC');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toBeHidden();
  const updated = page.getByRole('complementary', { name: 'Nightly SIE import runs at 03:00 UTC' });
  await expect(updated).toBeVisible();
  await expect(updated.getByText(/"history": 2/)).toBeVisible();

  await updated.getByRole('button', { name: 'Mark verified' }).click();
  await expect(page.getByRole('status').filter({ hasText: `${key} verified.` })).toBeVisible();

  // Forget asks once.
  await updated.getByRole('button', { name: 'Forget', exact: true }).click();
  await expect(updated.getByText(`Forget ${key}? Every bird stops reading it.`)).toBeVisible();
  await updated
    .getByRole('group', { name: 'Forget this memory' })
    .getByRole('button', { name: 'Forget' })
    .click();
  await expect(page.getByRole('status').filter({ hasText: `${key} forgotten.` })).toBeVisible();
  await expect(row).toHaveCount(0);
});

test('a new namespace can be created from the nav and used at once', async ({ page }) => {
  const label = `Runbooks ${Date.now().toString(36)}`;
  await page.goto('/memory');
  const nav = page.getByRole('navigation', { name: 'Namespaces' });
  await nav.getByRole('button', { name: '+ New namespace' }).click();
  await nav.getByLabel('New namespace').fill(label);
  await nav.getByRole('button', { name: 'Add', exact: true }).click();
  // The dev server compiles the namespaces route on first use; production answers in a beat.
  await expect(
    page.getByRole('status').filter({ hasText: `Namespace “${label}” added.` }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(nav.getByRole('button', { name: new RegExp(`^${label}`) })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // A fresh nest shows the shared empty state; a nest with facts elsewhere names the namespace.
  await expect(
    page.getByText(/Nothing in this namespace yet\. Add a fact to start it\.|The nest is empty/),
  ).toBeVisible();

  await page.getByRole('button', { name: '+ Add fact' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a fact' });
  await expect(dialog.getByLabel('Namespace')).toHaveValue(label.toLowerCase().replace(/ /g, '-'));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

import { expect, test } from '@playwright/test';

// Home (spec §3.2, PR 6): the prompt window attaches files and starts a run. Runs after the shell
// smoke tests, which expect a workspace with no runs.

test('the prompt window names a missing task, attaches a file and starts a flight', async ({
  page,
}) => {
  await page.goto('/');
  const composer = page.getByRole('region', { name: 'Ask Magpipe' });
  await expect(composer).toBeVisible();

  // Run with nothing typed: the problem is named and focus goes to the prompt.
  await composer.getByRole('button', { name: 'Run' }).click();
  await expect(composer.getByRole('alert')).toHaveText('Give Magpipe a task.');
  await expect(composer.getByLabel('Ask Magpipe')).toBeFocused();

  const task = `Summarise the attached note ${Date.now().toString(36)}`;
  await composer.getByLabel('Ask Magpipe').fill(task);
  await expect(composer.getByRole('alert')).toBeHidden();

  // A file chip shows its name and size and can be removed.
  const file = { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello, nest') };
  await composer.getByLabel('Attach files', { exact: true }).setInputFiles(file);
  const chips = composer.getByRole('list', { name: 'Attachments' });
  await expect(chips.getByText('note.txt')).toBeVisible();
  await expect(chips.getByText('11 B')).toBeVisible();
  await chips.getByRole('button', { name: 'Remove note.txt' }).click();
  await expect(chips).toBeHidden();
  await composer.getByLabel('Attach files', { exact: true }).setInputFiles(file);
  await expect(chips.getByText('11 B')).toBeVisible();

  // ⌘/Ctrl + Enter starts the flight and lands on it.
  await composer.getByLabel('Ask Magpipe').press('Control+Enter');
  await expect(page).toHaveURL(/\/runs\/flight_[0-9a-z]+$/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(task);
  await expect(page.getByText('Flight', { exact: true })).toBeVisible();
  // Without model credentials the flight fails at once and its log says why.
  await expect(page.getByRole('log')).toContainText('No model credentials', { timeout: 15_000 });
  await expect(page.getByRole('region', { name: 'Result' })).toContainText('No model credentials');

  // Home now counts the run: the nest no longer says there are none.
  await page.goto('/');
  await expect(
    page.getByRole('region', { name: 'The nest' }).getByText('no runs yet'),
  ).toBeHidden();
});

test('the flight table filters, finds the flight, shows its path and re-flies it', async ({
  page,
}) => {
  await page.goto('/runs');
  const table = page.getByRole('region', { name: 'Runs' });
  await expect(table.getByRole('listitem').first()).toBeVisible();

  // The Failed pill keeps only failed flights.
  await page.getByRole('button', { name: /^Failed/ }).click();
  await expect(table.getByText('failed', { exact: true }).first()).toBeVisible();
  await expect(table.getByText('done', { exact: true })).toHaveCount(0);

  // Search narrows to the flight started from the prompt window.
  await page.getByLabel('Search runs').fill('Summarise the attached note');
  await expect(table.getByRole('listitem')).toHaveCount(1);
  await table.getByRole('button').first().click();
  const selected = page.getByRole('region', { name: /Summarise the attached note/ });
  await expect(selected).toBeVisible();
  await expect(selected.getByRole('link', { name: 'Open log' })).toHaveAttribute(
    'href',
    /\/runs\/flight_[0-9a-z]+$/,
  );
  await expect(selected.getByText('No steps were planned.')).toBeVisible();

  // Re-fly starts a new flight with the same input and lands on it.
  await selected.getByRole('button', { name: 'Re-fly' }).click();
  await expect(page).toHaveURL(/\/runs\/flight_[0-9a-z]+$/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Summarise the attached note/);
  await expect(page.getByRole('log')).toContainText('No model credentials', { timeout: 15_000 });
});

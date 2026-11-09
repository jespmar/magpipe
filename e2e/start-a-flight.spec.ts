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

  // Home now counts the run: the nest no longer says there are none.
  await page.goto('/');
  await expect(
    page.getByRole('region', { name: 'The nest' }).getByText('no runs yet'),
  ).toBeHidden();
});

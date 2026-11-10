import { expect, test } from '@playwright/test';

// The product flow (spec §10, PR 8): create a run → see its events → done. The dev server runs
// with the scripted model (playwright.config.ts), so a flight plans one step, answers it and
// merges a result without credentials. Runs after the shell smoke tests, which expect a
// workspace with no runs.

test('the prompt window names a missing task, attaches a file and starts a flight that lands', async ({
  page,
  request,
}) => {
  // The demo data grants every starter agent a tool server that does not exist; a bird with no
  // tools gives the scripted model somewhere to route the step.
  const created = await request.post('/api/agents', {
    data: { name: 'Smoke Bird', role: 'Answers the smoke test', model: 'claude-haiku-5-5' },
  });
  expect(created.status()).toBe(201);

  await page.goto('/');
  const composer = page.getByRole('region', { name: 'Ask Magpipe' });
  await expect(composer).toBeVisible();

  // Run with nothing typed: the problem is named and focus goes to the prompt.
  await composer.getByRole('button', { name: 'Run' }).click();
  await expect(composer.getByRole('alert')).toContainText('Give Magpipe a task.');
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

  // The trail streams in and the flight lands: the path, the log and the result fill in.
  const log = page.getByRole('log');
  await expect(log).toContainText('Answer the task', { timeout: 20_000 });
  await expect(page.getByText('done', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('group', { name: 'Flight path' }).getByRole('listitem')).toHaveCount(
    2,
  );
  await expect(page.getByRole('region', { name: 'Result' })).toContainText(
    'Merged by the scripted model',
  );
  await expect(page.getByRole('list', { name: 'Attachments' }).getByText('note.txt')).toBeVisible();

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

  // The Done pill keeps only finished flights.
  await page.getByRole('button', { name: /^Done/ }).click();
  await expect(table.getByText('done', { exact: true }).first()).toBeVisible();
  await expect(table.getByText('failed', { exact: true })).toHaveCount(0);

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
  await expect(
    selected.getByRole('group', { name: 'Flight path' }).getByRole('listitem'),
  ).toHaveCount(2);

  // Re-fly starts a new flight with the same input and lands on it.
  await selected.getByRole('button', { name: 'Re-fly' }).click();
  await expect(page).toHaveURL(/\/runs\/flight_[0-9a-z]+$/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Summarise the attached note/);
  await expect(page.getByText('done', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
});

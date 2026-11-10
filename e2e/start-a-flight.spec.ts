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

  // ⌘/Ctrl + Enter starts the flight. Home stays put: the new flight is selected, its panel
  // opens beside the nest and the prompt empties, ready for a follow-up.
  await composer.getByLabel('Ask Magpipe').press('Control+Enter');
  const panel = page.getByRole('region', { name: /^flight_[0-9a-z]+$/ });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/$/);
  await expect(composer.getByLabel('Ask Magpipe')).toHaveValue('');
  await expect(panel).toContainText(task);
  const first = (await panel.getAttribute('aria-label'))!;
  const cards = page.getByRole('region', { name: 'Runs' });
  const cardOf = (id: string) =>
    cards.getByRole('listitem').filter({ has: page.getByText(id, { exact: true }) });
  await expect(cardOf(first).getByRole('button', { pressed: true })).toBeVisible();
  await expect(composer.getByText(`Follow-up to ${first}`)).toBeVisible();

  // The trail streams into the panel and the flight lands: the result and the files fill in.
  await expect(panel.getByRole('log')).toContainText('Answer the task', { timeout: 20_000 });
  await expect(panel.getByText('done', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole('region', { name: 'Result' })).toContainText(
    'Merged by the scripted model',
  );
  await expect(
    panel.getByRole('list', { name: 'Attachments' }).getByText('note.txt'),
  ).toBeVisible();
  await expect(cardOf(first)).toContainText('done');

  // The next message is a follow-up: the new flight opens with the thread it continues.
  await composer.getByLabel('Ask Magpipe').fill('And what does the note leave out?');
  await composer.getByRole('button', { name: 'Run' }).click();
  await expect(panel).not.toHaveAttribute('aria-label', first, { timeout: 15_000 });
  const second = (await panel.getAttribute('aria-label'))!;
  await expect(composer.getByText(`Follow-up to ${second}`)).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Earlier in this thread' })).toContainText(first);
  await expect(panel.getByText('done', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  // "New question" drops the thread; closing a landed card takes it off Home.
  await composer.getByRole('button', { name: 'New question' }).click();
  await expect(composer.getByText(/Follow-up to/)).toBeHidden();
  await page.getByRole('button', { name: `Close ${first}` }).click();
  await expect(cards.getByText(first, { exact: true })).toBeHidden();
  await expect(cards.getByText(second, { exact: true })).toBeVisible();

  // The nest counts the runs: it no longer says there are none.
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

  // Search narrows to the flight started from the prompt window; a closed card is still here.
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

test('a flight waits after a bird that waits for approval, and goes on with the note (D30)', async ({
  page,
  request,
}) => {
  const list = (await (await request.get('/api/agents')).json()) as {
    agents: { id: string; slug: string }[];
  };
  const smoke = list.agents.find((a) => a.slug === 'smoke-bird')!;
  expect(
    (await request.patch(`/api/agents/${smoke.id}`, { data: { pauseAfter: true } })).status(),
  ).toBe(200);

  try {
    await page.goto('/');
    const composer = page.getByRole('region', { name: 'Ask Magpipe' });
    const fresh = composer.getByRole('button', { name: 'New question' });
    if (await fresh.isVisible()) await fresh.click();
    const task = `Plan a careful change ${Date.now().toString(36)}`;
    await composer.getByLabel('Ask Magpipe').fill(task);
    await composer.getByRole('button', { name: 'Run' }).click();

    // The first step lands, then the flight waits for the operator.
    const approval = page.getByRole('region', { name: 'Approval' });
    await expect(approval).toBeVisible({ timeout: 20_000 });
    await expect(approval).toContainText('Waiting for you');
    await expect(approval).toContainText('Approve “Answer the task” to let the next steps start');
    const panel = page.getByRole('region', { name: /^flight_[0-9a-z]+$/ });
    await expect(panel.getByText('waiting', { exact: true }).first()).toBeVisible();

    await approval.getByLabel('Note for the next steps (optional)').fill('Keep it to one tenant.');
    await approval.getByRole('button', { name: 'Approve and go on' }).click();
    await expect(approval).toBeHidden({ timeout: 15_000 });
    await expect(panel.getByRole('log')).toContainText(
      'Approved by the operator: Keep it to one tenant.',
      { timeout: 20_000 },
    );
    await expect(panel.getByText('done', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  } finally {
    await request.patch(`/api/agents/${smoke.id}`, { data: { pauseAfter: false } });
  }
});

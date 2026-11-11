import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// The software factory, phase 1 (D37): load its nine agents from Settings onto a temp git
// repository, then "Send to the factory" on Home runs the spec template with the scripted model
// and hands over the spec with its review.
//
// Runs after the development flock (the name sorts after it): it adds nine agents, and the
// shell smoke tests expect a fresh workspace.

let dir: string;
/** The repository the factory is loaded onto; its tool is removed after the last test. */
let factoryRepo = '';

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-e2e-factory-'));
});

test.afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings loads the software factory, and Home sends a task to its spec template', async ({
  page,
}) => {
  const repo = path.join(dir, `mill-${Date.now().toString(36)}`);
  fs.mkdirSync(repo);
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'node -e 0', lint: 'node -e 0', test: 'node -e 0' } }),
  );
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  // A first commit: goal worktrees branch from it (D41).
  execFileSync(
    'git',
    [
      '-c',
      'user.email=e2e@example.com',
      '-c',
      'user.name=E2E',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ],
    { cwd: repo },
  );
  // A bare origin: the factory pushes goal branches there before opening pull requests (D42).
  const origin = path.join(dir, `${path.basename(repo)}-origin.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: repo });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo });
  factoryRepo = path.basename(repo);
  const name = factoryRepo;

  await page.goto('/settings');
  const section = page.getByRole('region', { name: 'Software factory' });
  await expect(section.getByLabel('Scripts agents may run')).toHaveValue('typecheck, lint, test');
  await section.getByLabel('Repository folder').fill(repo);
  await section.getByRole('button', { name: 'Load the software factory' }).click();
  await expect(
    section.getByText(new RegExp(`This binds ${name} as a repository tool`)),
  ).toBeVisible();
  await section.getByRole('button', { name: 'Load the factory' }).click();
  const status = section.getByRole('status');
  await expect(status).toContainText('Done.', { timeout: 15_000 });
  await expect(status).toContainText(
    'Created Spec Builder, Spec Review, Goal Builder, Goal Review, Test Agent, Code Agent, Code Review, Code Skeptic and Merge Agent.',
  );
  await expect(status).toContainText(`Bound ${name} as a repository tool.`);

  // Home now offers the factory beside Run.
  await page.goto('/');
  const composer = page.getByRole('region', { name: 'Ask Magpipe' });
  // Earlier specs leave a flight selected; ask a fresh question rather than follow it up.
  const fresh = composer.getByRole('button', { name: 'New question' });
  if (await fresh.isVisible()) await fresh.click();
  const task = `Let operators export runs as CSV ${Date.now().toString(36)}`;
  await composer.getByLabel('Ask Magpipe').fill(task);
  await composer.getByRole('button', { name: 'Send to the factory' }).click();

  const panel = page.getByRole('region', { name: /^flight_[0-9a-z]+$/ });
  await expect(panel).toContainText(task, { timeout: 15_000 });
  await expect(panel.getByRole('log')).toContainText('From the spec template', {
    timeout: 20_000,
  });
  await expect(panel.getByText('done', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const result = panel.getByRole('region', { name: 'Result' });
  await expect(result).toContainText('Scripted spec');
  await expect(result).toContainText('Acceptance criteria');
  await expect(result).toContainText('Review the spec');
});

// Linear (D38), against the scripted tracker the e2e server runs with: a refused key is named on
// its field, a good one is saved, the mapping is suggested and read back, and a spec that passes
// review is filed as an issue that Home approves.
test('settings connects Linear, a passing spec is filed, Home approves it, its goals are filed and the first is built', async ({
  page,
  request,
}) => {
  // Spec, goals and a build, end to end: longer than the default 30 s.
  test.setTimeout(120_000);
  await page.goto('/settings');
  const section = page.getByRole('region', { name: 'Linear' });
  const key = section.getByLabel('Personal API key');

  await key.fill('lin_api_bad_e2e');
  await section.getByRole('button', { name: 'Save key' }).click();
  await expect(key).toHaveAccessibleDescription(/did not accept the API key/, { timeout: 15_000 });

  await key.fill('lin_api_e2e_7f3a');
  await section.getByRole('button', { name: 'Save key' }).click();
  await expect(section.getByText(/Linear knows this key as Scripted Operator/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(section.getByText('ends in 7f3a')).toBeVisible();
  await expect(key).toBeHidden();

  await section.getByRole('button', { name: 'Map the statuses' }).click();
  await section.getByRole('combobox', { name: 'Team' }).click();
  await page.getByRole('option', { name: 'Magpipe (MAG)' }).click();
  // The first guess fills every state from the team's own status names.
  await expect(section.getByRole('combobox', { name: 'Spec ready' })).toContainText('Spec ready');
  await expect(section.getByRole('combobox', { name: 'Needs you' })).toContainText('Blocked');
  await section.getByRole('button', { name: 'Save and read back' }).click();
  await expect(section.getByText(/Read back from Linear: 7 statuses in Magpipe/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(section.getByText('made just now', { exact: false })).toBeVisible();

  await page.goto('/');
  const composer = page.getByRole('region', { name: 'Ask Magpipe' });
  const fresh = composer.getByRole('button', { name: 'New question' });
  if (await fresh.isVisible()) await fresh.click();
  await composer.getByLabel('Ask Magpipe').fill(`Filed spec ${Date.now().toString(36)}`);
  await composer.getByRole('button', { name: 'Send to the factory' }).click();

  const panel = page.getByRole('region', { name: /^flight_[0-9a-z]+$/ });
  await expect(panel.getByText('done', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole('region', { name: 'Result' })).toContainText(
    /Filed MAG-\d+ in Spec ready/,
  );
  const issue = panel.getByRole('region', { name: 'Linear issue' });
  await expect(issue).toContainText('spec ready');
  await expect(issue.getByRole('link', { name: /MAG-\d+/ })).toHaveAttribute(
    'href',
    /linear\.app\/scripted\/issue\/MAG-\d+/,
  );
  await issue.getByRole('button', { name: 'Approve the spec' }).click();
  await expect(issue).toContainText('approved');
  await expect(issue).toContainText(/Approved in Magpipe at \d\d:\d\d/);
  await expect(issue.getByRole('button', { name: 'Approve the spec' })).toBeHidden();

  // Approval starts the goals run (D39): it reads the spec from Linear, records the goals, has
  // them reviewed and files them as sub-issues; the spec moves to building.
  const goalsLink = issue.getByRole('link', { name: /^flight_[0-9a-z]+$/ });
  await expect(issue).toContainText('Goals: split in');
  await goalsLink.click();
  await expect(
    page.getByRole('heading', { level: 1, name: /^Split MAG-\d+ into goals/ }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('done', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const spec = page.getByRole('region', { name: 'Linear issue' });
  await expect(spec).toContainText('building');
  const goals = spec.getByRole('list', { name: 'Goals' });
  await expect(goals).toContainText('Meet criterion 1');
  await expect(goals.getByRole('link', { name: /MAG-\d+/ })).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Result' })).toContainText(
    /Filed 1 goal under MAG-\d+/,
  );

  // GitHub (D42): a refused token is named, a good one saved, the repository read back.
  await page.goto('/settings');
  const github = page.getByRole('region', { name: 'GitHub' });
  const token = github.getByLabel('Token');
  await token.fill('ghp_bad_e2e');
  await github.getByRole('button', { name: 'Save token' }).click();
  await expect(token).toHaveAccessibleDescription(/did not accept the token/, { timeout: 15_000 });
  await token.fill('ghp_e2e_9d1f');
  await github.getByRole('button', { name: 'Save token' }).click();
  await expect(github.getByText('ends in 9d1f')).toBeVisible({ timeout: 15_000 });
  await github.getByLabel('Repository').fill('magpipe-e2e/app');
  await github.getByRole('button', { name: 'Save and read back' }).click();
  await expect(
    github.getByText('Read back from GitHub: magpipe-e2e/app, default branch main.'),
  ).toBeVisible({ timeout: 15_000 });

  // The goal's turn (D40): Check now in Settings starts its build, which writes the tests, builds,
  // runs, reviews and tries to break it, then pushes, opens the pull request and asks to merge.
  const linear = page.getByRole('region', { name: 'Linear' });
  await linear.getByRole('button', { name: 'Check now' }).click();
  const started = linear.getByText(/Started MAG-\d+ → flight_[0-9a-z]+/);
  await expect(started).toBeVisible({ timeout: 15_000 });
  const buildId = /flight_[0-9a-z]+/.exec((await started.textContent()) ?? '')![0];
  await page.goto(`/runs/${buildId}`);
  await expect(page.getByRole('heading', { level: 1, name: /^Build MAG-\d+/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('done', { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  const goalBar = page.getByRole('region', { name: 'Linear issue' });
  await expect(goalBar).toContainText('merge question');
  await expect(goalBar.getByRole('link', { name: /PR #1/ })).toHaveAttribute(
    'href',
    'https://github.com/magpipe-e2e/app/pull/1',
  );
  await expect(page.getByRole('region', { name: 'Result' })).toContainText(
    /asks to merge pull request #1/,
  );

  // Gate G2 from Magpipe: Merge lands it, bringing the branch up to date and testing it again.
  await goalBar.getByRole('button', { name: 'Merge' }).click();
  const landing = goalBar.getByRole('link', { name: /^flight_[0-9a-z]+$/ });
  await expect(goalBar).toContainText('Merge: landing in');
  await landing.click();
  await expect(page.getByRole('heading', { level: 1, name: /^Land MAG-\d+/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('done', { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('region', { name: 'Linear issue' })).toContainText(/Merged at/);
  await expect(page.getByRole('region', { name: 'Result' })).toContainText(
    /Merged MAG-\d+'s pull request #1/,
  );

  // The factory screen (D43): the goal sits in Done with its merged pull request, its spec in
  // Building with the goal counted.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Factory' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Factory' })).toBeVisible({
    timeout: 15_000,
  });
  const doneColumn = page.getByRole('region', { name: 'Done' });
  await expect(doneColumn).toContainText('Meet criterion 1');
  await expect(doneColumn).toContainText('merged');
  await expect(doneColumn.getByRole('list', { name: /MAG-\d+ checks/ })).toContainText('pass');
  await expect(page.getByRole('region', { name: 'Building' })).toContainText('1 of 1 goals done');

  // Leave no tool card behind for a folder that is about to be deleted.
  const { tools } = (await (await request.get('/api/tools')).json()) as {
    tools: { id: string; name: string }[];
  };
  for (const tool of tools.filter((x) => x.name === factoryRepo)) {
    expect((await request.delete(`/api/tools/${tool.id}`)).ok()).toBe(true);
  }
});

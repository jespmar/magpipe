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
  await expect(status).toContainText('Done.', { timeout: 30_000 });
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
  await expect(panel).toContainText(task, { timeout: 30_000 });
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
test('signing in without pasting: Sign in with Linear and the GitHub CLI’s sign-in (D47)', async ({
  page,
  context,
}) => {
  await page.goto('/settings');
  // Hydrated before the first click: the buttons are the client's.
  await page.waitForLoadState('networkidle');
  const linear = page.getByRole('region', { name: 'Linear' });
  // The OAuth app comes from magpipe.env here, so the button is offered straight away.
  const signIn = linear.getByRole('button', { name: 'Sign in with Linear' });
  await expect(signIn).toBeVisible({ timeout: 30_000 });
  // Linear opens in the browser; the scripted stand-in comes straight back, as if allowed.
  const opened = context.waitForEvent('page');
  await signIn.click();
  const tab = await opened;
  await expect(tab.getByRole('status')).toContainText(
    'Signed in to Linear as Scripted Operator. You can close this tab and go back to Magpipe.',
    { timeout: 30_000 },
  );
  await tab.close();
  // The window notices on its own.
  await expect(linear.getByText('Signed in with Linear as Scripted Operator.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(linear.getByText('with Linear; the token renews by itself')).toBeVisible();

  // The GitHub CLI on this computer (a stand-in here) can stand in for a token.
  const github = page.getByRole('region', { name: 'GitHub' });
  await expect(github.getByText(/The GitHub CLI is on this computer/)).toBeVisible();
  await github.getByRole('button', { name: 'Use the GitHub CLI’s sign-in' }).click();
  await expect(
    github.getByText(/Using the GitHub CLI’s sign-in\. GitHub knows it as scripted-operator/),
  ).toBeVisible({ timeout: 30_000 });
  await expect(github.getByText('the GitHub CLI’s sign-in', { exact: true })).toBeVisible();

  // Back to pasted keys, which the factory flow after this one uses.
  await github.getByRole('button', { name: 'Stop using it' }).click();
  await expect(github.getByRole('button', { name: 'Use the GitHub CLI’s sign-in' })).toBeVisible({
    timeout: 30_000,
  });
  await linear.getByRole('button', { name: 'Sign out' }).click();
  await expect(linear.getByText(/^Signed out of Linear\./)).toBeVisible({ timeout: 30_000 });
  await expect(signIn).toBeVisible();
});

test('settings connects Linear, a passing spec is filed, Home approves it, its goals are filed and the first is built', async ({
  page,
  request,
}) => {
  // Spec, goals and a build, end to end: longer than the default 30 s.
  test.setTimeout(180_000);
  // The approve route compiles on its first request on the development server; have it ready
  // before the click that needs it (an unknown issue is simply not found).
  await request.post('/api/issues/iss_warmup/approve').catch(() => undefined);
  await page.goto('/settings');
  const section = page.getByRole('region', { name: 'Linear' });
  const key = section.getByLabel('Personal API key');

  await key.fill('lin_api_bad_e2e');
  await section.getByRole('button', { name: 'Save key' }).click();
  await expect(key).toHaveAccessibleDescription(/did not accept the API key/, { timeout: 30_000 });

  await key.fill('lin_api_e2e_7f3a');
  await section.getByRole('button', { name: 'Save key' }).click();
  await expect(section.getByText(/Linear knows this key as Scripted Operator/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(section.getByText('ends in 7f3a')).toBeVisible();
  await expect(key).toBeHidden();

  // GitHub (D42): a refused token is named, a good one saved. The token is shared by every
  // project (D46); the repository is the project's own.
  await page.goto('/settings');
  const github = page.getByRole('region', { name: 'GitHub' });
  const token = github.getByLabel('Token');
  await token.fill('ghp_bad_e2e');
  await github.getByRole('button', { name: 'Save token' }).click();
  await expect(token).toHaveAccessibleDescription(/did not accept the token/, { timeout: 30_000 });
  await token.fill('ghp_e2e_9d1f');
  await github.getByRole('button', { name: 'Save token' }).click();
  await expect(github.getByText('ends in 9d1f')).toBeVisible({ timeout: 30_000 });

  // The Default project (D46) owns its Linear project and repository: map them in its settings.
  await page.goto('/factory');
  await page.getByRole('link', { name: 'Default' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Default' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('region', { name: 'What this project needs' })).toContainText(
    'No Linear project yet',
  );
  await page.getByRole('main').getByRole('link', { name: 'Settings', exact: true }).click();
  // The project settings page compiles on its first visit.
  await expect(page.getByRole('heading', { level: 1, name: 'Default settings' })).toBeVisible({
    timeout: 30_000,
  });
  const linearPart = page.getByRole('region', { name: 'Linear' });
  await linearPart.getByRole('button', { name: 'Read the teams from Linear' }).click();
  await linearPart.getByRole('combobox', { name: 'Team' }).click();
  await page.getByRole('option', { name: 'Magpipe (MAG)' }).click();
  // The first guess fills every state from the team's own status names.
  await expect(linearPart.getByRole('combobox', { name: 'Spec ready' })).toContainText(
    'Spec ready',
  );
  await expect(linearPart.getByRole('combobox', { name: 'Needs you' })).toContainText('Blocked');
  await linearPart.getByRole('combobox', { name: 'Linear project' }).click();
  await page.getByRole('option', { name: 'Web app' }).click();
  const githubPart = page.getByRole('region', { name: 'GitHub' });
  await githubPart.getByLabel('Repository').fill('magpipe-e2e/app');
  // Unattended merges (D44) are off until turned on.
  await expect(
    githubPart.getByRole('checkbox', { name: 'Merge without asking when the rule holds' }),
  ).not.toBeChecked();
  await page.getByRole('button', { name: 'Save and read back' }).click();
  const saved = page.getByRole('status').filter({ hasText: 'Saved.' });
  await expect(saved).toContainText(
    /Read back from Linear: 7 statuses in Magpipe, project Web app, and the label magpipe, made just now\./,
    { timeout: 30_000 },
  );
  await expect(saved).toContainText('Read back from GitHub: magpipe-e2e/app, default branch main.');

  // The project's own Specification Agent (D46): a spec written on its page.
  await page.getByRole('link', { name: 'Back to Default' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Default' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('region', { name: 'What this project needs' })).toBeHidden();
  const specBox = page.getByRole('form', { name: 'Write a spec' });
  await specBox.getByLabel('An idea for Default').fill(`Filed spec ${Date.now().toString(36)}`);
  await specBox.getByRole('button', { name: 'Write the spec' }).click();
  const specRun = specBox.getByRole('link', { name: /^flight_[0-9a-z]+$/ });
  await expect(specRun).toBeVisible({ timeout: 30_000 });
  await specRun.click();
  await expect(page.getByRole('heading', { level: 1, name: /^Filed spec/ })).toBeVisible({
    timeout: 30_000,
  });

  const panel = page.getByRole('main');
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
  // The run page was just opened: a click before it hydrates is lost, so try until it lands.
  await expect(async () => {
    const approve = issue.getByRole('button', { name: 'Approve the spec' });
    if (await approve.isVisible()) await approve.click();
    // The result itself: the hint beside the button also says "approved status".
    await expect(issue).toContainText(/Approved in Magpipe at \d\d:\d\d/, { timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
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
    timeout: 30_000,
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

  await page.goto('/settings');
  // The goal's turn (D40): Check now in Settings starts its build, which writes the tests, builds,
  // runs, reviews and tries to break it, then pushes, opens the pull request and asks to merge.
  const linear = page.getByRole('region', { name: 'Linear' });
  await linear.getByRole('button', { name: 'Check now' }).click();
  const started = linear.getByText(/Started MAG-\d+ → flight_[0-9a-z]+/);
  await expect(started).toBeVisible({ timeout: 30_000 });
  const buildId = /flight_[0-9a-z]+/.exec((await started.textContent()) ?? '')![0];
  await page.goto(`/runs/${buildId}`);
  await expect(page.getByRole('heading', { level: 1, name: /^Build MAG-\d+/ })).toBeVisible({
    timeout: 30_000,
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
    timeout: 30_000,
  });
  await expect(page.getByText('done', { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('region', { name: 'Linear issue' })).toContainText(/Merged at/);
  await expect(page.getByRole('region', { name: 'Result' })).toContainText(
    /Merged MAG-\d+'s pull request #1/,
  );

  // The factory screen (D43): the goal sits in Done with its merged pull request, and its spec
  // counts it.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Factory' })
    .click();
  // The list's first visit compiles it on the development server.
  await expect(page.getByRole('heading', { level: 1, name: 'Factory' })).toBeVisible({
    timeout: 30_000,
  });
  // Each project's board is on its page (D46).
  await page.getByRole('link', { name: 'Default' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Default' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('region', { name: 'Runs' })).toContainText(/Land MAG-\d+/);
  const doneColumn = page.getByRole('region', { name: 'Done' });
  await expect(doneColumn).toContainText('Meet criterion 1');
  await expect(doneColumn).toContainText('merged');
  await expect(doneColumn.getByRole('list', { name: /MAG-\d+ checks/ })).toContainText('pass');
  // Its spec counts the goal; the watcher may already have moved the spec to Done.
  await expect(page.getByText('1 of 1 goals done')).toBeVisible();

  // Leave no tool card behind for a folder that is about to be deleted.
  const { tools } = (await (await request.get('/api/tools')).json()) as {
    tools: { id: string; name: string }[];
  };
  for (const tool of tools.filter((x) => x.name === factoryRepo)) {
    expect((await request.delete(`/api/tools/${tool.id}`)).ok()).toBe(true);
  }
});

test('factory projects: the Default project, a second one on its own Linear project and repository, and the Home picker', async ({
  page,
}) => {
  // New project pages compile on their first visit.
  test.setTimeout(90_000);
  const repo = path.join(dir, `second-${Date.now().toString(36)}`);
  fs.mkdirSync(repo);
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e 0' } }),
  );
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });

  await page.goto('/factory');
  await expect(page.getByRole('heading', { level: 1, name: 'Factory' })).toBeVisible();
  // The factory as it was is the Default project, on its own Linear project (D46).
  await expect(page.getByRole('link', { name: 'Default' })).toBeVisible();
  await expect(page.getByText('Web app (MAG)')).toBeVisible();

  await page.getByRole('link', { name: 'New project' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New project' })).toBeVisible({
    timeout: 30_000,
  });
  const repository = page.getByRole('region', { name: 'Repository' });
  await repository.getByLabel('Name').fill('API service');
  await repository.getByLabel('Folder').fill(repo);
  await page
    .getByRole('region', { name: 'Context for the agents' })
    .getByLabel('Brief')
    .fill('The public API. Every endpoint is versioned.');
  // A new project starts with the teams the shared key sees.
  const linear = page.getByRole('region', { name: 'Linear' });
  await linear.getByRole('combobox', { name: 'Team' }).click();
  await page.getByRole('option', { name: 'Magpipe (MAG)' }).click();
  await expect(linear.getByRole('combobox', { name: 'Needs you' })).toContainText('Blocked');
  // Web app belongs to Default: a second project on it is refused.
  await linear.getByRole('combobox', { name: 'Linear project' }).click();
  await page.getByRole('option', { name: 'Web app' }).click();
  const github = page.getByRole('region', { name: 'GitHub' });
  await github.getByLabel('Repository').fill('magpipe-e2e/api');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(linear.getByText('Default already files into that Linear project.')).toBeVisible({
    timeout: 30_000,
  });
  await linear.getByRole('combobox', { name: 'Linear project' }).click();
  await page.getByRole('option', { name: 'API' }).click();
  await page.getByRole('button', { name: 'Create project' }).click();
  // Created, it opens on its own page with its spec box and board.
  await expect(page.getByRole('heading', { level: 1, name: 'API service' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('The public API. Every endpoint is versioned.')).toBeVisible();
  await expect(page.getByText('files into API')).toBeVisible();
  await expect(page.getByText('lands in magpipe-e2e/api')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Write a spec' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Factory' })).toBeVisible();

  await page.goto('/factory');
  await expect(page.getByText('2 projects')).toBeVisible();
  await expect(page.getByText('API (MAG)', { exact: true })).toBeVisible();

  // Home asks which project a spec is for, now that there are two.
  await page.goto('/');
  const composer = page.getByRole('region', { name: 'Ask Magpipe' });
  // A follow-up keeps its thread's project; a new question picks one.
  const fresh = composer.getByRole('button', { name: 'New question' });
  if (await fresh.isVisible()) await fresh.click();
  await expect(composer.getByRole('combobox', { name: 'Factory project' })).toContainText(
    'Default',
  );

  // Leave one project, as the workspace had before.
  await page.goto('/factory');
  await page.getByRole('link', { name: 'API service' }).click();
  await page.getByRole('main').getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'API service settings' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Delete project' }).click();
  await page.getByRole('button', { name: 'Delete, keeping its issues' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Factory' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('one project')).toBeVisible();
});

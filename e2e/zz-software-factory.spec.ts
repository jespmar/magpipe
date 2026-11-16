import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// The software factory (D37, D50): its nine agents come with the first project the New project
// wizard makes, no folder asked for; then "Send to the factory" on Home runs the spec template
// with the scripted model and hands over the spec with its review.
//
// Runs after the development flock (the name sorts after it): it adds nine agents, and the
// shell smoke tests expect a fresh workspace.

let dir: string;
/** The first project's folder: a git repository with a bare origin, made before the tests. */
let mill = '';

// Each test builds on the one before: a failure skips the rest rather than retrying them alone.
test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-e2e-factory-'));
  mill = path.join(dir, `mill-${Date.now().toString(36)}`);
  fs.mkdirSync(mill);
  fs.writeFileSync(
    path.join(mill, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'node -e 0', lint: 'node -e 0', test: 'node -e 0' } }),
  );
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: mill });
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
    { cwd: mill },
  );
  // A bare origin: the factory pushes goal branches there before opening pull requests (D42).
  const origin = path.join(dir, `${path.basename(mill)}-origin.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: mill });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: mill });
});

test.afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('before any project, the factory is not installed and Home does not offer it', async ({
  page,
}) => {
  // No folder is asked for: the agents come with the first project (D50).
  await page.goto('/settings');
  const section = page.getByRole('region', { name: 'Software factory' });
  await expect(section.getByText(/^Not installed yet\./)).toBeVisible({ timeout: 30_000 });
  await expect(section.getByLabel('Repository folder')).toHaveCount(0);

  await page.goto('/factory');
  await expect(page.getByText('factory agents not installed yet')).toBeVisible({ timeout: 30_000 });

  await page.goto('/');
  const composer = page.getByRole('region', { name: 'Ask Magpipe' });
  await expect(composer.getByLabel('Ask Magpipe')).toBeVisible({ timeout: 30_000 });
  await expect(composer.getByRole('button', { name: 'Send to the factory' })).toHaveCount(0);
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
  test.setTimeout(240_000);
  // The approve route compiles on its first request on the development server; have it ready
  // before the click that needs it (an unknown issue is simply not found).
  await request.post('/api/issues/iss_warmup/approve').catch(() => undefined);
  await request.post('/api/issues/iss_warmup/merge').catch(() => undefined);
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

  // The first project, made with the wizard (D49): magpipe-e2e/app, the folder that holds it,
  // and the Web app Linear project. The factory's agents are installed with it (D50).
  await page.goto('/factory/new');
  await expect(page.getByRole('heading', { level: 1, name: 'New project' })).toBeVisible({
    timeout: 30_000,
  });
  const repos = page.getByRole('radiogroup', { name: 'Repositories' });
  await repos
    .getByRole('radio', { name: /^magpipe-e2e\/app\b/ })
    .check({ force: true, timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Use a folder that has it' }).click();
  await page.getByRole('textbox', { name: 'Folder', exact: true }).fill(mill);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('combobox', { name: 'Team' })).toContainText('Magpipe (MAG)', {
    timeout: 30_000,
  });
  // The first guess fills every state from the team's own status names.
  await expect(page.getByText('Needs you is Blocked')).toBeVisible();
  await page.getByRole('combobox', { name: 'Linear project' }).click();
  await page.getByRole('option', { name: 'Web app' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  // The scripts come from the folder's package.json, the usual ones ticked.
  await expect(page.getByRole('checkbox', { name: 'typecheck' })).toBeChecked({ timeout: 30_000 });
  await expect(page.getByRole('checkbox', { name: 'test' })).toBeChecked();
  await page.getByLabel('Project name').fill('Mill');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('The factory’s nine agents are installed with it.')).toBeVisible();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mill' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('region', { name: 'What this project needs' })).toBeHidden();
  await expect(page.getByText('files into Web app')).toBeVisible();
  await expect(page.getByText('lands in magpipe-e2e/app')).toBeVisible();

  // Settings says the agents are there, and brings them up to date without a folder.
  await page.goto('/settings');
  const factory = page.getByRole('region', { name: 'Software factory' });
  await expect(factory.getByText(/^Installed\./)).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    await factory.getByRole('button', { name: 'Bring the agents up to date' }).click();
    await expect(factory.getByRole('status')).toContainText('Done.', { timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
  await expect(factory.getByRole('status')).toContainText(
    'Spec Builder, Spec Review, Goal Builder, Goal Review, Test Agent, Code Agent, Code Review, Code Skeptic and Merge Agent',
  );

  // Home now offers the factory beside Run, for the one project there is.
  await page.goto('/');
  const composer = page.getByRole('region', { name: 'Ask Magpipe' });
  const fresh = composer.getByRole('button', { name: 'New question' });
  if (await fresh.isVisible()) await fresh.click();
  const task = `Let operators export runs as CSV ${Date.now().toString(36)}`;
  await composer.getByLabel('Ask Magpipe').fill(task);
  await composer.getByRole('button', { name: 'Send to the factory' }).click();
  const homePanel = page.getByRole('region', { name: /^flight_[0-9a-z]+$/ });
  await expect(homePanel).toContainText(task, { timeout: 30_000 });
  await expect(homePanel.getByRole('log')).toContainText('From the spec template', {
    timeout: 20_000,
  });
  await expect(homePanel.getByText('done', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  const result = homePanel.getByRole('region', { name: 'Result' });
  await expect(result).toContainText('Scripted spec');
  await expect(result).toContainText('Review the spec');

  // The project's own Specification Agent (D46): a spec written on its page.
  await page.goto('/factory');
  await page.getByRole('link', { name: 'Mill' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mill' })).toBeVisible({
    timeout: 30_000,
  });
  const specBox = page.getByRole('form', { name: 'Write a spec' });
  await specBox.getByLabel('An idea for Mill').fill(`Filed spec ${Date.now().toString(36)}`);
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
  // Check now starts the build, unless the watcher's own check got there first on a slow run:
  // either way, the build is found.
  let buildId = '';
  await expect(async () => {
    const said = await linear
      .getByText(/Started MAG-\d+ → flight_[0-9a-z]+/)
      .textContent({ timeout: 1_000 })
      .catch(() => null);
    if (said) {
      buildId = /flight_[0-9a-z]+/.exec(said)![0];
      return;
    }
    const { runs } = (await (await request.get('/api/runs?limit=50')).json()) as {
      runs: { displayId: string; input: { text: string } }[];
    };
    const build = runs.find((r) => /^Build MAG-\d+/.test(r.input.text));
    expect(build, 'a build run for the goal').toBeTruthy();
    buildId = build!.displayId;
  }).toPass({ timeout: 60_000 });
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
  // The page was just opened: a click before it hydrates is lost, so try until it lands.
  await expect(async () => {
    const merge = goalBar.getByRole('button', { name: 'Merge' });
    if (await merge.isVisible()) await merge.click();
    await expect(goalBar).toContainText('Merge: landing in', { timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
  const landing = goalBar.getByRole('link', { name: /^flight_[0-9a-z]+$/ });
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
  await page.getByRole('link', { name: 'Mill' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mill' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('region', { name: 'Runs' })).toContainText(/Land MAG-\d+/);
  const doneColumn = page.getByRole('region', { name: 'Done' });
  await expect(doneColumn).toContainText('Meet criterion 1');
  await expect(doneColumn).toContainText('merged');
  await expect(doneColumn.getByRole('list', { name: /MAG-\d+ checks/ })).toContainText('pass');
  // Its spec counts the goal; the watcher may already have moved the spec to Done.
  await expect(page.getByText('1 of 1 goals done')).toBeVisible();
});

test('factory projects: a second one made with the wizard, beside the first, and the Home picker', async ({
  page,
}) => {
  // New project pages compile on their first visit; the wizard clones a repository.
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const repoName = `api-${stamp}`;

  await page.goto('/factory');
  await expect(page.getByRole('heading', { level: 1, name: 'Factory' })).toBeVisible();
  // The first project, on its own Linear project (D46).
  await expect(page.getByRole('link', { name: 'Mill' })).toBeVisible();
  await expect(page.getByText('Web app (MAG)')).toBeVisible();

  await page.getByRole('link', { name: 'New project' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New project' })).toBeVisible({
    timeout: 30_000,
  });

  // 1. The repositories the account can push to, grouped by owner; Mill's is taken (D49).
  const repos = page.getByRole('radiogroup', { name: 'Repositories' });
  await expect(repos.getByRole('radio', { name: /^magpipe-e2e\/app\b/ })).toBeDisabled({
    timeout: 30_000,
  });
  await expect(repos.getByText('used by Mill')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search repositories' }).fill('dotfiles');
  await expect(repos.getByRole('radio')).toHaveCount(1);
  // A new one instead, made at the last step.
  await page.getByRole('button', { name: 'Make a new one' }).click();
  await page.getByRole('combobox', { name: 'Owner' }).click();
  await page.getByRole('option', { name: 'magpipe-e2e' }).click();
  await page.getByLabel('Name', { exact: true }).fill(repoName);
  await page.getByRole('button', { name: 'Continue' }).click();

  // 2. Cloned into a new folder inside the one picked.
  await expect(
    page.getByRole('heading', { name: 'Where does it live on this computer?' }),
  ).toBeVisible();
  await page.getByLabel('Clone into').fill(dir);
  await expect(page.getByLabel('New folder’s name')).toHaveValue(repoName);
  await page.getByRole('button', { name: 'Continue' }).click();

  // 3. The only team is chosen; Web app belongs to Mill, so a new Linear project.
  await expect(page.getByRole('heading', { name: 'Where are its specs filed?' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('combobox', { name: 'Team' })).toContainText('Magpipe (MAG)', {
    timeout: 30_000,
  });
  await page.getByRole('combobox', { name: 'Linear project' }).click();
  await expect(page.getByRole('option', { name: 'Web app (used by Mill)' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Make a new one' }).click();
  await page.getByLabel('New Linear project’s name').fill(`API ${stamp}`);
  await expect(page.getByText('Needs you is Blocked')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // 4. A new repository has no package.json yet: no scripts, said so.
  await expect(page.getByText('The repository has no package.json yet')).toBeVisible();
  await page.getByLabel('Project name').fill('API service');
  await page
    .getByLabel('Brief for the agents')
    .fill('The public API. Every endpoint is versioned.');
  await page.getByRole('button', { name: 'Continue' }).click();

  // 5. Made in order, then saved and read back; it opens on its own page.
  await expect(page.getByText(`magpipe-e2e/${repoName}, new and private`)).toBeVisible();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'API service' })).toBeVisible({
    timeout: 60_000,
  });
  expect(fs.existsSync(path.join(dir, repoName, 'README.md'))).toBe(true);
  await expect(page.getByText('The public API. Every endpoint is versioned.')).toBeVisible();
  await expect(page.getByText(`files into API ${stamp}`)).toBeVisible();
  await expect(page.getByText(`lands in magpipe-e2e/${repoName}`)).toBeVisible();
  await expect(page.getByText('No scripts yet')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Write a spec' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Factory', exact: true })).toBeVisible();

  await page.goto('/factory');
  await expect(page.getByText('2 projects')).toBeVisible();
  await expect(page.getByText(`API ${stamp} (MAG)`, { exact: true })).toBeVisible();

  // Home asks which project a spec is for, now that there are two.
  await page.goto('/');
  const composer = page.getByRole('region', { name: 'Ask Magpipe' });
  // A follow-up keeps its thread's project; a new question picks one.
  const fresh = composer.getByRole('button', { name: 'New question' });
  if (await fresh.isVisible()) await fresh.click();
  await expect(composer.getByRole('combobox', { name: 'Factory project' })).toContainText('Mill');

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

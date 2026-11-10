import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// Settings → Load the development flock (D35): refuse a folder outside git, then load the flock
// onto a temp git repository and find Planner and Verifier on the Agents screen.
//
// Runs last on purpose (the name sorts after every other spec): it rewrites the starter agents,
// adds decisions entries and pauses Operator, and the shell smoke tests expect a fresh workspace
// and the demo's exact memory count.

let dir: string;

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-e2e-flock-'));
});

test.afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings loads the development flock onto a repository after a confirm step', async ({
  page,
  request,
}) => {
  const scripts = { typecheck: 'node -e 0', lint: 'node -e 0', test: 'node -e 0' };
  const loose = path.join(dir, 'loose');
  fs.mkdirSync(loose);
  fs.writeFileSync(path.join(loose, 'package.json'), JSON.stringify({ scripts }));
  const repo = path.join(dir, `shop-${Date.now().toString(36)}`);
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const name = path.basename(repo);

  await page.goto('/settings');
  const section = page.getByRole('region', { name: 'Development flock' });
  const folder = section.getByLabel('Repository folder');
  const trigger = section.getByRole('button', { name: 'Load the development flock' });
  await expect(section.getByLabel('Scripts agents may run')).toHaveValue('typecheck, lint, test');

  // A relative path is named before anything is asked.
  await folder.fill('code/app');
  await trigger.click();
  // The field's error is part of its description, so a screen reader hears it on focus.
  await expect(folder).toHaveAccessibleDescription(
    /Give the folder as an absolute path, such as \/Users\/you\/code\/app\./,
  );
  await expect(folder).toBeFocused();

  // A folder outside git is refused by the server, on its field, after the confirm step.
  await folder.fill(loose);
  await trigger.click();
  const load = section.getByRole('button', { name: 'Load the flock' });
  await expect(load).toBeFocused();
  await expect(section.getByText(/This binds loose and its docs\/plans folder/)).toBeVisible();
  await load.click();
  // The first action on a cold dev server compiles the route; production answers in a beat.
  await expect(folder).toHaveAccessibleDescription(/is not inside a git repository\./, {
    timeout: 15_000,
  });
  await expect(folder).toBeFocused();
  expect(fs.existsSync(path.join(loose, 'docs'))).toBe(false);

  // Cancel goes back to the trigger without writing anything.
  await folder.fill(repo);
  await trigger.click();
  await section.getByRole('button', { name: 'Cancel' }).click();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(section.getByText(new RegExp(`This binds ${name} and its`))).toBeVisible();
  await load.click();
  const status = section.getByRole('status');
  await expect(status).toContainText('Done.', { timeout: 15_000 });
  await expect(status).toContainText(repo);
  await expect(status).toContainText(
    'Created Planner and Verifier. Updated Researcher, Coder and Reviewer. Paused Operator.',
  );
  await expect(status).toContainText(`Bound ${name} and ${name} plans as repository tools.`);
  await expect(status).toContainText('Created the namespaces plans and reviews.');
  await expect(status).toContainText('Wrote 6 decisions entries.');
  await expect(section.getByRole('button', { name: 'Load it again' })).toBeFocused();
  expect(fs.statSync(path.join(repo, 'docs', 'plans')).isDirectory()).toBe(true);

  await section.getByRole('link', { name: 'See the agents' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible({
    timeout: 15_000,
  });
  const roster = page.getByRole('region', { name: 'Agents' });
  await expect(roster.getByRole('button', { name: /^Planner/ })).toBeVisible();
  await expect(roster.getByRole('button', { name: /^Verifier/ })).toBeVisible();
  await expect(roster.getByRole('button', { name: /^Operator/ })).toContainText('paused');
  const planner = page.getByRole('complementary', { name: 'Planner' });
  await expect(planner.getByText('Turns a task into a plan file')).toBeVisible();
  await expect(planner).toContainText(`${name}-plans`);

  // Leave no tool cards behind for a folder that is about to be deleted.
  const { tools } = (await (await request.get('/api/tools')).json()) as {
    tools: { id: string; name: string }[];
  };
  for (const tool of tools.filter((x) => x.name.startsWith(name))) {
    expect((await request.delete(`/api/tools/${tool.id}`)).ok()).toBe(true);
  }
});

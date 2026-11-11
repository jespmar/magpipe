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

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-e2e-factory-'));
});

test.afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('settings loads the software factory, and Home sends a task to its spec template', async ({
  page,
  request,
}) => {
  const repo = path.join(dir, `mill-${Date.now().toString(36)}`);
  fs.mkdirSync(repo);
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'node -e 0', lint: 'node -e 0', test: 'node -e 0' } }),
  );
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const name = path.basename(repo);

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

  // Leave no tool card behind for a folder that is about to be deleted.
  const { tools } = (await (await request.get('/api/tools')).json()) as {
    tools: { id: string; name: string }[];
  };
  for (const tool of tools.filter((x) => x.name === name)) {
    expect((await request.delete(`/api/tools/${tool.id}`)).ok()).toBe(true);
  }
});

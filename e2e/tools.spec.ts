import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// The Tools screen (spec §3.5, PR 3): connect a real local MCP server, see it tested and listed,
// manage it, remove it. Independent of the demo data.

type Rpc = { id?: number; method: string };

let server: http.Server;
let url: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'DELETE') return void res.writeHead(200).end(); // session teardown
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body) as Rpc;
      if (msg.id === undefined) return void res.writeHead(202).end();
      const result =
        msg.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 'Echo', version: '1' },
            }
          : { tools: [{ name: 'echo' }, { name: 'ping' }] };
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  url = `http://127.0.0.1:${port}/mcp`;
});

test.afterAll(() => {
  server.close();
});

test('connect a local MCP server, test it, grant it, remove it', async ({ page }) => {
  const name = `Local Echo ${Date.now().toString(36)}`;
  await page.goto('/tools');
  await expect(page.getByRole('heading', { level: 1, name: 'Tools' })).toBeVisible();

  // The panel opens from the primary action, validates as you type, and refuses bad JSON.
  await page.getByRole('button', { name: 'Connect tool' }).click();
  const panel = page.getByRole('region', { name: 'Connect a tool' });
  await expect(panel).toBeVisible();
  const editor = panel.getByLabel('Connection JSON');
  await editor.fill('{"name": "x", "transport": "http"}');
  await expect(panel.getByText('An http server needs a url')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Connect and test' })).toBeDisabled();

  await editor.fill(
    JSON.stringify({
      name,
      transport: 'http',
      url,
      auth: { type: 'bearer', token: 'secret-token' },
      grant: ['coder'],
    }),
  );
  await panel.getByRole('button', { name: 'Connect and test' }).click();
  await expect(panel).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: `${name} connected · 2 tools found.` }),
  ).toBeVisible();

  const card = page.getByRole('article', { name });
  await expect(card).toBeVisible();
  await expect(card.getByText('Connected', { exact: true })).toBeVisible();
  await expect(card.getByText('MCP · Echo')).toBeVisible();
  await expect(card.getByRole('list', { name: 'Tool names' }).getByRole('listitem')).toHaveText([
    'echo',
    'ping',
  ]);
  await expect(card.getByRole('list', { name: 'Granted to' })).toContainText('Coder');
  await expect(card.getByText('0 calls · 24h')).toBeVisible();

  // The grant shows up on the agent side too, naming the tools it allows.
  const slug = name.toLowerCase().replace(/ /g, '-');
  await page.goto('/agents?agent=coder');
  const detail = page.getByRole('complementary', { name: 'Coder' });
  await expect(detail.getByText(slug)).toContainText('echo ping');

  // Unticking every tool takes the server away rather than granting all of it (D25).
  await detail.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Coder' });
  await edit.getByRole('checkbox', { name: 'echo', exact: true }).uncheck();
  await edit.getByRole('checkbox', { name: 'ping', exact: true }).uncheck();
  await expect(
    edit.getByText('Nothing ticked, so this agent gets no tools from this server.'),
  ).toBeVisible();
  await edit.getByRole('button', { name: 'Save changes' }).click();
  // The first save on a cold dev server can take longer than the default wait.
  await expect(edit).toBeHidden({ timeout: 15_000 });
  await expect(detail.getByText(slug)).toContainText('no tools');

  // Manage: test again, then remove after a confirm step.
  await page.goto('/tools');
  await card.getByRole('button', { name: 'Manage' }).click();
  await card.getByRole('button', { name: 'Test again' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `${name} connected · 2 tools found.` }),
  ).toBeVisible();
  await card.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(card.getByText(`Remove ${name} and every agent’s grant to it?`)).toBeVisible();
  await card.getByRole('button', { name: 'Remove', exact: true }).last().click();
  // The dev server compiles the delete route on first use; allow for that latency.
  await expect(page.getByRole('status').filter({ hasText: `${name} removed.` })).toBeVisible({
    timeout: 15_000,
  });
  await expect(card).toHaveCount(0);
});

test('a server that cannot be reached is saved with an honest error', async ({ page }) => {
  const name = `Ghost ${Date.now().toString(36)}`;
  await page.goto('/tools?connect=1');
  const panel = page.getByRole('region', { name: 'Connect a tool' });
  await expect(panel).toBeVisible();
  await panel
    .getByLabel('Connection JSON')
    .fill(JSON.stringify({ name, transport: 'http', url: 'http://127.0.0.1:9/mcp' }));
  await panel.getByRole('button', { name: 'Connect and test' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `${name} saved · Could not reach 127.0.0.1:9` }),
  ).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => new URL(page.url()).searchParams.has('connect')).toBe(false);

  const card = page.getByRole('article', { name });
  await expect(card.getByText('Error', { exact: true })).toBeVisible();
  await expect(card.getByText(/Could not reach 127\.0\.0\.1:9/)).toBeVisible();
  await expect(card.getByText('No tool names discovered yet.')).toBeVisible();

  await card.getByRole('button', { name: 'Manage' }).click();
  await card.getByRole('button', { name: 'Remove', exact: true }).click();
  await card.getByRole('button', { name: 'Remove', exact: true }).last().click();
  await expect(card).toHaveCount(0);
});

test('a repository is bound from its own example, with the scripts agents may run (D27)', async ({
  page,
}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-e2e-repo-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e "0"', lint: 'node -e "0"' } }),
  );
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const name = `App ${Date.now().toString(36)}`;

  await page.goto('/tools?connect=1');
  const panel = page.getByRole('region', { name: 'Connect a tool' });
  await panel.getByRole('button', { name: 'Use the repository example' }).click();
  const editor = panel.getByLabel('Connection JSON');
  await expect(editor).toHaveValue(/"transport": "repository"/);
  await expect(panel.getByText(/an absolute folder inside a git repository/)).toBeVisible();

  await editor.fill(
    JSON.stringify({ name, transport: 'repository', path: dir, scripts: ['test', 'lint'] }),
  );
  await panel.getByRole('button', { name: 'Connect and test' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `${name} connected · 9 tools found.` }),
  ).toBeVisible({ timeout: 15_000 });

  const card = page.getByRole('article', { name });
  await expect(card.getByText('Repository · npm')).toBeVisible();
  await expect(card.getByText(`Folder ${dir}`)).toBeVisible();
  await expect(card.getByText('scripts: test, lint · stops a run after 600 s')).toBeVisible();
  await expect(card.getByRole('list', { name: 'Tool names' }).getByRole('listitem')).toHaveText([
    'read',
    'search',
    'write',
    'run',
    'git_status',
    'git_diff',
    'git_log',
    'git_branch',
    'git_commit',
  ]);

  await card.getByRole('button', { name: 'Manage' }).click();
  await card.getByRole('button', { name: 'Remove', exact: true }).click();
  await card.getByRole('button', { name: 'Remove', exact: true }).last().click();
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  fs.rmSync(dir, { recursive: true, force: true });
});

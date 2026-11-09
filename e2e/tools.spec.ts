import http from 'node:http';
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
  await page.getByRole('button', { name: '+ Connect tool' }).click();
  const panel = page.getByRole('region', { name: 'Connect an MCP server' });
  await expect(panel).toBeVisible();
  const editor = panel.getByLabel('Connection JSON');
  await editor.fill('{"name": "x", "transport": "http"}');
  await expect(panel.getByText('An http server needs a url')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Connect & test' })).toBeDisabled();

  await editor.fill(
    JSON.stringify({
      name,
      transport: 'http',
      url,
      auth: { type: 'bearer', token: 'secret-token' },
      grant: ['coder'],
    }),
  );
  await panel.getByRole('button', { name: 'Connect & test' }).click();
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

  // The grant shows up on the agent side too.
  await page.goto('/agents?agent=coder');
  await expect(
    page
      .getByRole('complementary', { name: 'Coder' })
      .getByText(name.toLowerCase().replace(/ /g, '-')),
  ).toBeVisible();

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
  await expect(page.getByRole('status').filter({ hasText: `${name} removed.` })).toBeVisible();
  await expect(card).toHaveCount(0);
});

test('a server that cannot be reached is saved with an honest error', async ({ page }) => {
  const name = `Ghost ${Date.now().toString(36)}`;
  await page.goto('/tools?connect=1');
  const panel = page.getByRole('region', { name: 'Connect an MCP server' });
  await expect(panel).toBeVisible();
  await panel
    .getByLabel('Connection JSON')
    .fill(JSON.stringify({ name, transport: 'http', url: 'http://127.0.0.1:9/mcp' }));
  await panel.getByRole('button', { name: 'Connect & test' }).click();
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

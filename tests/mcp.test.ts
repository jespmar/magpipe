import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { probeMcp, splitCommand } from '@/lib/mcp';

type Rpc = { id?: number; method: string; params?: { cursor?: string } };

function reply(req: Rpc): unknown {
  if (req.method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'echo', version: '1.2' },
    };
  }
  if (req.method === 'tools/list') {
    return req.params?.cursor
      ? { tools: [{ name: 'ping' }] }
      : { tools: [{ name: 'echo', description: 'Echoes input' }], nextCursor: 'p2' };
  }
  return {};
}

/** A tiny Streamable HTTP server: JSON or SSE answers, optional bearer check. */
function serve(opts: { sse?: boolean; token?: string }) {
  const server = http.createServer((req, res) => {
    if (req.method === 'DELETE') return void res.writeHead(200).end(); // session teardown
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(401).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body) as Rpc;
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: reply(msg) });
      if (opts.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
        res.write(`event: message\r\ndata: ${payload}\r\n\r\n`);
        // Keep the stream open: the client must stop at the matching response, not at EOF.
        setTimeout(() => res.end(), 2000);
      } else {
        res
          .writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' })
          .end(payload);
      }
    });
  });
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => server.close() });
    });
  });
}

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((fn) => fn()));

describe('probeMcp over http', () => {
  it('initialises, lists every page of tools and reports the server', async () => {
    const s = await serve({});
    cleanups.push(s.close);
    const probe = await probeMcp({ transport: 'http', url: s.url });
    expect(probe).toEqual({
      ok: true,
      server: { name: 'echo', version: '1.2' },
      tools: [{ name: 'echo', description: 'Echoes input' }, { name: 'ping' }],
    });
  });

  it('reads SSE answers without waiting for the stream to close', async () => {
    const s = await serve({ sse: true });
    cleanups.push(s.close);
    const started = Date.now();
    const probe = await probeMcp({ transport: 'http', url: s.url });
    expect(probe.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('maps 401 to needs_auth and passes a bearer token through', async () => {
    const s = await serve({ token: 't0k' });
    cleanups.push(s.close);
    const denied = await probeMcp({ transport: 'http', url: s.url });
    expect(denied).toMatchObject({ ok: false, status: 'needs_auth' });
    const allowed = await probeMcp({
      transport: 'http',
      url: s.url,
      headers: { authorization: 'Bearer t0k' },
    });
    expect(allowed.ok).toBe(true);
  });

  it('names the host it could not reach', async () => {
    const probe = await probeMcp(
      { transport: 'http', url: 'http://127.0.0.1:9/mcp' },
      { timeoutMs: 3000 },
    );
    expect(probe).toMatchObject({ ok: false, status: 'error' });
    if (!probe.ok) expect(probe.error).toMatch(/Could not reach 127\.0\.0\.1:9/);
  });
});

describe('probeMcp over stdio', () => {
  it('speaks line-delimited JSON-RPC to a child process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-mcp-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const script = path.join(dir, 'server with space.js');
    fs.writeFileSync(
      script,
      `
      let buf = '';
      process.stdin.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.id === undefined) continue;
          const result = msg.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'local', version: '0' } }
            : { tools: [{ name: 'fs_read' }, { name: 'fs_write' }] };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
        }
      });
      `,
    );
    const probe = await probeMcp({
      transport: 'stdio',
      command: `"${process.execPath}" "${script}"`,
    });
    expect(probe).toEqual({
      ok: true,
      server: { name: 'local', version: '0' },
      tools: [{ name: 'fs_read' }, { name: 'fs_write' }],
    });
  });

  it('reports a missing command', async () => {
    const probe = await probeMcp({ transport: 'stdio', command: 'no-such-mcp-binary --flag' });
    expect(probe).toMatchObject({ ok: false, status: 'error' });
    if (!probe.ok) expect(probe.error).toMatch(/Command not found/);
  });
});

describe('splitCommand', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(splitCommand(`node "/a b/server.js" --port 3 'x y'`)).toEqual([
      'node',
      '/a b/server.js',
      '--port',
      '3',
      'x y',
    ]);
    expect(splitCommand('  npx   -y  pkg ')).toEqual(['npx', '-y', 'pkg']);
    expect(splitCommand('a\\ b c')).toEqual(['a b', 'c']);
    expect(splitCommand('')).toEqual([]);
  });
});

describe('connectMcp', () => {
  it('keeps a session open to list and call tools', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'DELETE') return void res.writeHead(200).end();
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = JSON.parse(body) as Rpc & {
          params?: { name?: string; arguments?: { text?: string } };
        };
        if (msg.id === undefined) return void res.writeHead(202).end();
        const result =
          msg.method === 'initialize'
            ? {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'echo', version: '1' },
              }
            : msg.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'echo',
                      description: 'Echo',
                      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
                    },
                  ],
                }
              : msg.params?.name === 'echo'
                ? { content: [{ type: 'text', text: `echo: ${msg.params.arguments?.text}` }] }
                : { content: [{ type: 'text', text: 'no such tool' }], isError: true };
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => server.close());
    const { port } = server.address() as { port: number };
    const { connectMcp } = await import('@/lib/mcp');
    const conn = await connectMcp({ transport: 'http', url: `http://127.0.0.1:${port}/mcp` });
    expect(conn.server).toEqual({ name: 'echo', version: '1' });
    const tools = await conn.listTools();
    expect(tools[0]).toMatchObject({ name: 'echo', inputSchema: { type: 'object' } });
    expect(await conn.callTool('echo', { text: 'hi' })).toEqual({
      content: [{ type: 'text', text: 'echo: hi' }],
      isError: false,
    });
    expect((await conn.callTool('nope', {})).isError).toBe(true);
    await conn.close();
  });
});

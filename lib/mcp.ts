/**
 * A minimal MCP client for the registry: enough of the protocol to shake hands with a server and
 * list the tools it exposes, over Streamable HTTP or stdio, with no SDK dependency. The names it
 * returns become the tool's `scopes`. docs/decisions.md D13.
 */
import { spawn } from 'node:child_process';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export type McpTool = { name: string; description?: string };

export type McpProbe =
  | { ok: true; server: { name: string; version: string } | null; tools: McpTool[] }
  | { ok: false; status: 'needs_auth' | 'error'; error: string };

export type McpTarget =
  | { transport: 'http'; url: string; headers?: Record<string, string> }
  | { transport: 'stdio'; command: string };

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

type Session = {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
};

/** A tool as `tools/list` describes it, schema included — what the engine hands to the model. */
export type McpToolDef = McpTool & { inputSchema?: Record<string, unknown> };

/** One block of a tool result; only text is forwarded to the model, other kinds are named. */
export type McpContent = { type: string; text?: string; [k: string]: unknown };

export type McpCallResult = { content: McpContent[]; isError: boolean };

/** Thrown by a connected server for a failed request; transport failures are plain Errors. */
export class McpToolError extends Error {}

export type McpConnection = {
  server: { name: string; version: string } | null;
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
};

/**
 * Connects and initialises a server for repeated use (a run step). Throws when the server
 * cannot be reached or refuses the credentials; the caller owns `close()`.
 */
export async function connectMcp(
  target: McpTarget,
  opts: { timeoutMs?: number } = {},
): Promise<McpConnection> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const session =
    target.transport === 'http'
      ? await httpSession(target, timeoutMs)
      : await stdioSession(target, timeoutMs);
  const init = (await session.request('initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'magpipe', version: '0.1' },
  })) as { serverInfo?: { name?: string; version?: string } } | null;
  await session.notify('notifications/initialized');
  const info = init?.serverInfo;
  return {
    server: info?.name ? { name: info.name, version: info.version ?? '' } : null,
    async listTools() {
      const tools: McpToolDef[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = (await session.request('tools/list', cursor ? { cursor } : {})) as {
          tools?: unknown;
          nextCursor?: string;
        } | null;
        for (const item of Array.isArray(res?.tools) ? res.tools : []) {
          if (item && typeof item === 'object' && typeof (item as McpTool).name === 'string') {
            const { name, description, inputSchema } = item as McpToolDef;
            tools.push({
              name,
              ...(typeof description === 'string' ? { description } : {}),
              ...(inputSchema && typeof inputSchema === 'object' ? { inputSchema } : {}),
            });
          }
        }
        if (!res?.nextCursor) break;
        cursor = res.nextCursor;
      }
      return tools;
    },
    async callTool(name, args) {
      const res = (await session.request('tools/call', { name, arguments: args })) as {
        content?: unknown;
        isError?: boolean;
      } | null;
      const content = (Array.isArray(res?.content) ? res.content : []).filter(
        (c): c is McpContent =>
          !!c && typeof c === 'object' && typeof (c as McpContent).type === 'string',
      );
      return { content, isError: res?.isError === true };
    },
    close: () => session.close(),
  };
}

class McpAuthError extends Error {}

/** Connects, initialises and lists tools. Never throws: failures come back as `ok: false`. */
export async function probeMcp(
  target: McpTarget,
  opts: { timeoutMs?: number } = {},
): Promise<McpProbe> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  try {
    const session =
      target.transport === 'http'
        ? await httpSession(target, timeoutMs)
        : await stdioSession(target, timeoutMs);
    try {
      const init = (await session.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'magpipe', version: '0.1' },
      })) as { serverInfo?: { name?: string; version?: string } } | null;
      await session.notify('notifications/initialized');

      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = (await session.request('tools/list', cursor ? { cursor } : {})) as {
          tools?: unknown;
          nextCursor?: string;
        } | null;
        for (const item of Array.isArray(res?.tools) ? res.tools : []) {
          if (item && typeof item === 'object' && typeof (item as McpTool).name === 'string') {
            const { name, description } = item as McpTool;
            tools.push(typeof description === 'string' ? { name, description } : { name });
          }
        }
        if (!res?.nextCursor) break;
        cursor = res.nextCursor;
      }
      const info = init?.serverInfo;
      return {
        ok: true,
        server: info?.name ? { name: info.name, version: info.version ?? '' } : null,
        tools,
      };
    } finally {
      await session.close();
    }
  } catch (err) {
    if (err instanceof McpAuthError) return { ok: false, status: 'needs_auth', error: err.message };
    return { ok: false, status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Streamable HTTP ────────────────────────────────────────────────────────

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickResponse(msg: unknown, id: number): JsonRpcMessage | null {
  const list = Array.isArray(msg) ? msg : [msg];
  return (
    (list.find((m) => m && typeof m === 'object' && (m as JsonRpcMessage).id === id) as
      JsonRpcMessage | undefined) ?? null
  );
}

/** Reads one JSON-RPC response, from a JSON body or from an SSE stream, stopping at the match. */
async function readResponse(res: Response, id: number): Promise<JsonRpcMessage | null> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream')) {
    const text = await res.text();
    return text.trim() ? pickResponse(safeJson(text), id) : null;
  }
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data) continue;
      const found = pickResponse(safeJson(data), id);
      if (found) {
        reader.cancel().catch(() => {});
        return found;
      }
    }
    if (done) return null;
  }
}

async function httpSession(
  target: Extract<McpTarget, { transport: 'http' }>,
  timeoutMs: number,
): Promise<Session> {
  const url = target.url;
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  let sessionId: string | null = null;
  let nextId = 1;

  async function post(body: JsonRpcMessage): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      ...(target.headers ?? {}),
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: control.signal,
        cache: 'no-store',
      });
    } catch (err) {
      if (control.signal.aborted) {
        throw new Error(`${hostOf(url)} did not answer within ${Math.round(timeoutMs / 1000)} s`);
      }
      const code = (err as { cause?: { code?: string } })?.cause?.code;
      throw new Error(`Could not reach ${hostOf(url)}${code ? ` (${code})` : ''}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new McpAuthError(`${hostOf(url)} refused the credentials (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`${hostOf(url)} answered HTTP ${res.status}`);
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    return res;
  }

  return {
    async request(method, params) {
      const id = nextId++;
      const res = await post({ jsonrpc: '2.0', id, method, params });
      const msg = await readResponse(res, id);
      if (!msg) throw new Error(`${hostOf(url)} sent no response to ${method}`);
      if (msg.error) throw new Error(msg.error.message || `${method} failed`);
      return msg.result;
    },
    async notify(method, params) {
      const res = await post({ jsonrpc: '2.0', method, params });
      await res.body?.cancel().catch(() => {});
    },
    async close() {
      clearTimeout(timer);
      if (!sessionId) return;
      try {
        await fetch(url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': sessionId, ...(target.headers ?? {}) },
          signal: AbortSignal.timeout(2000),
          cache: 'no-store',
        });
      } catch {
        /* a server that does not support DELETE still closed on its own */
      }
    },
  };
}

// ─── stdio ──────────────────────────────────────────────────────────────────

/** `node "/path with spaces/server.js" --flag` → ['node', '/path with spaces/server.js', '--flag'] */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) out.push(current);
      current = '';
      has = false;
    } else if (ch === '\\' && i + 1 < command.length) {
      current += command[++i];
    } else {
      current += ch;
    }
  }
  if (has || current) out.push(current);
  return out;
}

async function stdioSession(
  target: Extract<McpTarget, { transport: 'stdio' }>,
  timeoutMs: number,
): Promise<Session> {
  const [file, ...args] = splitCommand(target.command);
  if (!file) throw new Error('The command is empty');
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  child.stdin.on('error', () => {});

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });

  const pending = new Map<
    number,
    { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }
  >();
  const failAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const msg = safeJson(line) as JsonRpcMessage | null;
      if (msg && typeof msg.id === 'number' && pending.has(msg.id)) {
        pending.get(msg.id)!.resolve(msg);
        pending.delete(msg.id);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', (err: NodeJS.ErrnoException) =>
      reject(new Error(err.code === 'ENOENT' ? `Command not found: ${file}` : err.message)),
    );
  });
  child.on('error', (err) => failAll(err));
  const onExit = (code: number | null) => {
    const last = stderr.trim().split('\n').pop();
    failAll(new Error(`${file} exited with code ${code ?? '?'}${last ? `: ${last}` : ''}`));
  };
  child.on('exit', onExit);
  const timer = setTimeout(
    () => failAll(new Error(`${file} did not answer within ${Math.round(timeoutMs / 1000)} s`)),
    timeoutMs,
  );

  let nextId = 1;
  const write = (msg: JsonRpcMessage) =>
    new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(msg)}\n`, (err) => (err ? reject(err) : resolve()));
    });

  return {
    async request(method, params) {
      const id = nextId++;
      const reply = new Promise<JsonRpcMessage>((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
      await write({ jsonrpc: '2.0', id, method, params });
      const msg = await reply;
      if (msg.error) throw new Error(msg.error.message || `${method} failed`);
      return msg.result;
    },
    async notify(method, params) {
      await write({ jsonrpc: '2.0', method, params });
    },
    async close() {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.kill();
    },
  };
}

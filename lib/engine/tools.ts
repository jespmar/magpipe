/**
 * What a step may touch: the built-in tools the agent was given (spec §7.4), scoped memory
 * (§7.3), the workspace sandbox (D6), and every MCP server granted to it, called over the
 * app's own MCP client. Tool names must match /^[a-zA-Z0-9_-]{1,64}$/ on the wire.
 */
import fs from 'node:fs/promises';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import * as t from '../db/schema';
import { connectMcp, type McpConnection, type McpTarget } from '../mcp';
import { listMemory, markRead, writeMemory } from '../memory';
import { formatConfidence } from '../memory-util';
import { memoryInput, type Agent, type Attachment, type RunEventKind } from '../schemas';
import { readSecret } from '../secrets';
import { authHeaders } from '../tools';
import { fsRead, fsWrite, shellRun } from './sandbox';
import type { ModelTool } from './model';

export type ToolOutcome = {
  text: string;
  isError?: boolean;
  memoryWrite?: { ns: string; key: string };
};

export type ToolRuntime = {
  tools: ModelTool[];
  /** Client tools by wire name; server tools (web search/fetch) have no entry. */
  dispatch: Map<string, (input: Record<string, unknown>) => Promise<ToolOutcome>>;
  /** Hints for events: the registry tool a wire name belongs to. */
  labels: Map<string, string>;
  close(): Promise<void>;
};

/** Where a step's events go: the run's trail, with the step and agent already filled in. */
export type Trail = {
  emit(kind: RunEventKind, text: string, payload?: unknown): Promise<void>;
};

/**
 * Calls one of the step's tools and writes the call, its result (or error) and any memory
 * write to the trail. Both backends go through here, so the trail reads the same whichever
 * model made the call.
 */
export async function invokeTool(
  runtime: ToolRuntime,
  trail: Trail,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const label = runtime.labels.get(name) ?? name;
  await trail.emit('tool_call', `${label}: ${JSON.stringify(input).slice(0, 300)}`, {
    tool: name,
    input,
  });
  const handler = runtime.dispatch.get(name);
  let outcome: ToolOutcome;
  if (!handler) outcome = { text: `Unknown tool ${name}`, isError: true };
  else {
    try {
      outcome = await handler(input);
    } catch (err) {
      outcome = { text: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
  await trail.emit(
    outcome.isError ? 'error' : 'tool_result',
    `${label} → ${outcome.text.slice(0, 300)}`,
    { tool: name, isError: outcome.isError ?? false },
  );
  if (outcome.memoryWrite) {
    await trail.emit(
      'memory_write',
      `${outcome.memoryWrite.ns}/${outcome.memoryWrite.key}`,
      outcome.memoryWrite,
    );
  }
  return outcome;
}

export type ToolSetup = {
  db: Db;
  agent: Agent;
  attachments: Attachment[];
  sandboxDir: string;
  signal: AbortSignal;
  /** Called when the agent tries to write outside its memory scope (rejected and logged, §7.3). */
  onRejectedWrite: (text: string) => Promise<void>;
  /** Called when a granted tool server cannot be reached: the step goes on without it (D19). */
  onToolUnavailable: (text: string) => Promise<void>;
};

export function wireName(...parts: string[]): string {
  return parts
    .join('__')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64);
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[],
): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
} => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

function clientTool(
  name: string,
  description: string,
  schema: ReturnType<typeof objectSchema>,
  strict = true,
): ModelTool {
  return { name, description, input_schema: schema, ...(strict ? { strict: true } : {}) };
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === 'string' ? v : '';
}

/** Builds the tool list and dispatch table for one step. */
export async function setupTools(setup: ToolSetup): Promise<ToolRuntime> {
  const { db, agent } = setup;
  const tools: ModelTool[] = [];
  const dispatch: ToolRuntime['dispatch'] = new Map();
  const labels = new Map<string, string>();
  const connections: McpConnection[] = [];

  // ── built-ins by name ─────────────────────────────────────────────────────
  if (agent.builtins.includes('web.search')) {
    tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 8 });
  }
  if (agent.builtins.includes('web.fetch')) {
    tools.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 });
  }
  if (agent.builtins.includes('files.read')) {
    tools.push(
      clientTool(
        'files_read',
        'Read a file attached to this run. Call without a name to list the attachments.',
        objectSchema(
          { name: { type: 'string', description: 'Attachment file name; omit to list' } },
          [],
        ),
        false,
      ),
    );
    dispatch.set('files_read', async (input) => {
      const name = str(input, 'name');
      if (!name) {
        return {
          text: setup.attachments.length
            ? setup.attachments.map((a) => `${a.name} (${a.mime}, ${a.size} bytes)`).join('\n')
            : 'No attachments on this run.',
        };
      }
      const file = setup.attachments.find((a) => a.name === name);
      if (!file) return { text: `No attachment called ${name}`, isError: true };
      if (!/^(text\/|application\/(json|xml|csv|javascript))/.test(file.mime)) {
        return {
          text: `${name} is ${file.mime}; only text files can be read here.`,
          isError: true,
        };
      }
      const text = await fs.readFile(file.blobUrl, 'utf8');
      return { text: text.length > 200_000 ? `${text.slice(0, 200_000)}\n… (truncated)` : text };
    });
  }

  // ── memory, scoped (§7.3) ────────────────────────────────────────────────
  const readable = agent.memoryScope.read;
  const writable = agent.memoryScope.write;
  if (readable.length > 0) {
    tools.push(
      clientTool(
        'memory_search',
        `Search the shared memory the flock keeps. Namespaces you may read: ${readable.join(', ')}.`,
        objectSchema(
          {
            query: { type: 'string', description: 'Words to look for in keys and values' },
            ns: { type: 'string', description: 'Limit to one namespace (optional)' },
          },
          ['query'],
        ),
        false,
      ),
      clientTool(
        'memory_get',
        'Read one memory entry by namespace and key.',
        objectSchema({ ns: { type: 'string' }, key: { type: 'string' } }, ['ns', 'key']),
      ),
    );
    dispatch.set('memory_search', async (input) => {
      const ns = str(input, 'ns');
      if (ns && !readable.includes(ns))
        return { text: `You may not read the ${ns} namespace.`, isError: true };
      const all = await listMemory(db, { ns: ns || undefined, q: str(input, 'query') });
      const entries = all.filter((e) => readable.includes(e.ns)).slice(0, 20);
      await markRead(
        db,
        entries.map((e) => e.id),
        agent.id,
      );
      return {
        text: entries.length
          ? entries
              .map(
                (e) =>
                  `${e.ns}/${e.key} = ${e.value} (confidence ${formatConfidence(e.confidence)}, source ${e.source})`,
              )
              .join('\n')
          : 'No memory matches.',
      };
    });
    dispatch.set('memory_get', async (input) => {
      const ns = str(input, 'ns');
      if (!readable.includes(ns))
        return { text: `You may not read the ${ns} namespace.`, isError: true };
      const [entry] = (await listMemory(db, { ns })).filter((e) => e.key === str(input, 'key'));
      if (!entry) return { text: `No entry ${ns}/${str(input, 'key')}.`, isError: true };
      await markRead(db, [entry.id], agent.id);
      return {
        text: JSON.stringify({
          ns: entry.ns,
          key: entry.key,
          value: entry.value,
          data: entry.data,
          confidence: entry.confidence,
          source: entry.source,
          expires: entry.expiresAt,
        }),
      };
    });
  }
  if (writable.length > 0) {
    tools.push(
      clientTool(
        'memory_write',
        `Record a durable fact for every agent to read later. Namespaces you may write: ${writable.join(', ')}. Use a dotted, stable key; say where it came from.`,
        objectSchema(
          {
            ns: { type: 'string' },
            key: { type: 'string' },
            value: { type: 'string' },
            confidence: { type: 'number', description: '0 to 1' },
            source: { type: 'string' },
            expiresAt: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null for never' },
          },
          ['ns', 'key', 'value', 'confidence', 'source', 'expiresAt'],
        ),
      ),
    );
    dispatch.set('memory_write', async (input) => {
      const parsed = memoryInput.safeParse(input);
      if (!parsed.success)
        return { text: `Invalid memory write: ${parsed.error.issues[0]?.message}`, isError: true };
      if (!writable.includes(parsed.data.ns)) {
        const text = `${agent.name} tried to write ${parsed.data.ns}/${parsed.data.key} outside its memory scope; rejected.`;
        await setup.onRejectedWrite(text);
        return { text: `You may not write the ${parsed.data.ns} namespace.`, isError: true };
      }
      const { entry, created } = await writeMemory(db, parsed.data, agent.id);
      return {
        text: `${created ? 'Wrote' : 'Updated'} ${entry.ns}/${entry.key}${entry.conflict ? ' (flagged as a conflict: confidence moved by more than 0.3)' : ''}.`,
        memoryWrite: { ns: entry.ns, key: entry.key },
      };
    });
  }

  // ── registry tools: the workspace built-in and MCP servers ───────────────
  const grants = agent.tools;
  const rows = grants.length
    ? await db
        .select()
        .from(t.tools)
        .where(
          inArray(
            t.tools.id,
            grants.map((g) => g.toolId),
          ),
        )
    : [];
  const closeAll = async () => {
    await Promise.all(connections.map((c) => c.close().catch(() => {})));
  };

  try {
    for (const tool of rows) {
      const grant = grants.find((g) => g.toolId === tool.id)!;
      const allowed = (scope: string) => grant.scopes.length === 0 || grant.scopes.includes(scope);

      if (tool.kind === 'builtin') {
        if (allowed('fs:r') || allowed('fs:rw')) {
          tools.push(
            clientTool(
              'fs_read',
              'Read a file or list a folder in this run’s workspace.',
              objectSchema({ path: { type: 'string' } }, ['path']),
            ),
          );
          dispatch.set('fs_read', async (input) => ({
            text: await fsRead(setup.sandboxDir, str(input, 'path')),
          }));
          labels.set('fs_read', tool.name);
        }
        if (allowed('fs:rw')) {
          tools.push(
            clientTool(
              'fs_write',
              'Write a text file in this run’s workspace.',
              objectSchema({ path: { type: 'string' }, contents: { type: 'string' } }, [
                'path',
                'contents',
              ]),
            ),
          );
          dispatch.set('fs_write', async (input) => ({
            text: await fsWrite(setup.sandboxDir, str(input, 'path'), str(input, 'contents')),
          }));
          labels.set('fs_write', tool.name);
        }
        if (allowed('shell:run')) {
          tools.push(
            clientTool(
              'shell_run',
              'Run a read-only command in the workspace (ls, cat, grep, find, head, tail, wc, diff, sort, uniq, stat, echo, pwd).',
              objectSchema({ command: { type: 'string' } }, ['command']),
            ),
          );
          dispatch.set('shell_run', async (input) => {
            const res = await shellRun(setup.sandboxDir, str(input, 'command'), {
              signal: setup.signal,
            });
            return {
              text: [res.stdout, res.stderr && `stderr:\n${res.stderr}`, `exit ${res.code ?? '?'}`]
                .filter(Boolean)
                .join('\n'),
              isError: res.code !== 0,
            };
          });
          labels.set('shell_run', tool.name);
        }
        continue;
      }

      // MCP server: connect once per step, list its tools, expose the granted ones.
      const token = tool.auth.secretRef ? await readSecret(db, tool.auth.secretRef) : null;
      const target: McpTarget | null =
        tool.transport === 'http' && tool.url
          ? { transport: 'http', url: tool.url, headers: authHeaders(tool.auth.type, token) }
          : tool.transport === 'stdio' && tool.command
            ? { transport: 'stdio', command: tool.command }
            : null;
      if (!target) continue;
      // A server that is down loses the step its tools, not the step itself: the trail says so
      // and the agent works with what remains (D19).
      let conn: McpConnection;
      let defs: Awaited<ReturnType<McpConnection['listTools']>>;
      try {
        conn = await connectMcp(target);
        connections.push(conn);
        defs = (await conn.listTools()).filter((d) => allowed(d.name));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await setup.onToolUnavailable(
          `${tool.name} is unreachable (${reason}); the step runs without its tools.`,
        );
        continue;
      }
      for (const def of defs) {
        const name = wireName(tool.slug, def.name);
        tools.push({
          name,
          description: `${tool.name}: ${def.description ?? def.name}`.slice(0, 1024),
          input_schema: toolInputSchema(def.inputSchema),
        });
        labels.set(name, `${tool.name} · ${def.name}`);
        dispatch.set(name, async (input) => {
          const res = await conn.callTool(def.name, input);
          void db
            .update(t.tools)
            .set({
              stats: {
                ...tool.stats,
                calls24h: tool.stats.calls24h + 1,
                lastCallAt: new Date().toISOString(),
              },
            })
            .where(eq(t.tools.id, tool.id))
            .catch(() => {});
          const text = res.content
            .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : `[${c.type}]`))
            .join('\n');
          return { text: text || '(empty result)', isError: res.isError };
        });
      }
    }
  } catch (err) {
    // A server that fails to connect or list must not leave the ones before it running.
    await closeAll();
    throw err;
  }

  return { tools, dispatch, labels, close: closeAll };
}

type ClientToolSchema = Extract<ModelTool, { input_schema: unknown }>['input_schema'];

/**
 * An MCP server's JSON Schema, trimmed to what the Messages API accepts: the object shape, its
 * properties and required list. Draft markers (`$schema`, `$id`), titles and the rest are dropped.
 */
export function toolInputSchema(schema: Record<string, unknown> | undefined): ClientToolSchema {
  const src = schema ?? {};
  const out: Record<string, unknown> = { type: 'object' };
  out.properties = src.properties && typeof src.properties === 'object' ? src.properties : {};
  if (Array.isArray(src.required)) out.required = src.required;
  if (typeof src.description === 'string') out.description = src.description;
  if (src.additionalProperties === false) out.additionalProperties = false;
  return out as ClientToolSchema;
}

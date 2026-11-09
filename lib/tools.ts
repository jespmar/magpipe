import 'server-only';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from './db';
import * as t from './db/schema';
import { slugify } from './agents-util';
import { newId } from './ids';
import { probeMcp, type McpProbe, type McpTarget } from './mcp';
import type { Tool, ToolAuthInput, ToolConnectInput, ToolPatch } from './schemas';
import { deleteSecret, readSecret, storeSecret } from './secrets';
import { glyphOf } from './tools-util';

/** A request that is well-formed but refers to things that do not exist or are not allowed. */
export class ToolValidationError extends Error {
  readonly code = 'validation';
}

export type AgentChip = { id: string; slug: string; name: string; initials: string };

export async function listTools(db: Db): Promise<Tool[]> {
  return db.select().from(t.tools).orderBy(asc(t.tools.name));
}

export async function getTool(db: Db, id: string): Promise<Tool | undefined> {
  const [row] = await db.select().from(t.tools).where(eq(t.tools.id, id));
  return row;
}

export async function listAgentChips(db: Db): Promise<AgentChip[]> {
  return db
    .select({
      id: t.agents.id,
      slug: t.agents.slug,
      name: t.agents.name,
      initials: t.agents.initials,
    })
    .from(t.agents)
    .orderBy(asc(t.agents.name));
}

// ─── connection ─────────────────────────────────────────────────────────────

/** bearer and oauth2 tokens travel as `Authorization: Bearer`; API keys as `X-API-Key` (D13). */
export function authHeaders(type: Tool['auth']['type'], token: string | null): Record<string, string> {
  if (!token || type === 'none') return {};
  return type === 'apikey' ? { 'x-api-key': token } : { authorization: `Bearer ${token}` };
}

function targetFor(
  tool: Pick<Tool, 'transport' | 'url' | 'command' | 'auth'>,
  token: string | null,
): McpTarget | null {
  if (tool.transport === 'http' && tool.url) {
    return { transport: 'http', url: tool.url, headers: authHeaders(tool.auth.type, token) };
  }
  if (tool.transport === 'stdio' && tool.command)
    return { transport: 'stdio', command: tool.command };
  return null;
}

/** Tests a connection described by the Connect panel's JSON, without saving anything. */
export async function testConnection(input: ToolConnectInput): Promise<McpProbe> {
  const target = targetFor(
    {
      transport: input.transport,
      url: input.url ?? null,
      command: input.command ?? null,
      auth: input.auth,
    },
    input.auth.token ?? null,
  );
  if (!target) return { ok: false, status: 'error', error: 'Nothing to connect to' };
  return probeMcp(target);
}

async function probeStored(db: Db, tool: Tool): Promise<McpProbe> {
  if (tool.transport === 'builtin')
    return { ok: true, server: null, tools: tool.scopes.map((name) => ({ name })) };
  const token = tool.auth.secretRef ? await readSecret(db, tool.auth.secretRef) : null;
  if (tool.auth.type !== 'none' && !token) {
    return { ok: false, status: 'needs_auth', error: 'No credentials stored yet' };
  }
  const target = targetFor(tool, token);
  if (!target) return { ok: false, status: 'error', error: 'Nothing to connect to' };
  return probeMcp(target);
}

function applyProbe(tool: Tool, probe: McpProbe, now: Date): Tool {
  return {
    ...tool,
    status: probe.ok ? 'connected' : probe.status,
    scopes: probe.ok ? probe.tools.map((x) => x.name) : tool.scopes,
    stats: probe.ok
      ? { calls24h: tool.stats.calls24h, lastCallAt: tool.stats.lastCallAt }
      : { ...tool.stats, lastError: probe.error },
    updatedAt: now,
  };
}

// ─── grants (the tool side of `agents.tools`) ──────────────────────────────

async function agentIdsForSlugs(db: Db, slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select({ id: t.agents.id, slug: t.agents.slug })
    .from(t.agents)
    .where(inArray(t.agents.slug, slugs));
  const missing = slugs.filter((s) => !rows.some((r) => r.slug === s));
  if (missing.length > 0) throw new ToolValidationError(`Unknown agent: ${missing.join(', ')}`);
  return slugs.map((s) => rows.find((r) => r.slug === s)!.id);
}

/** Grants every current scope to `agentIds` and removes the tool from everyone else. */
async function setAgentGrants(db: Db, tool: Pick<Tool, 'id' | 'scopes'>, agentIds: string[]) {
  const agents = await db.select({ id: t.agents.id, tools: t.agents.tools }).from(t.agents);
  for (const agent of agents) {
    const has = agent.tools.some((g) => g.toolId === tool.id);
    const should = agentIds.includes(agent.id);
    if (has === should) continue;
    const next = should
      ? [...agent.tools, { toolId: tool.id, scopes: [...tool.scopes] }]
      : agent.tools.filter((g) => g.toolId !== tool.id);
    await db
      .update(t.agents)
      .set({ tools: next, updatedAt: new Date() })
      .where(eq(t.agents.id, agent.id));
  }
}

async function uniqueSlug(db: Db, base: string, exceptId?: string): Promise<string> {
  const rows = await db.select({ id: t.tools.id, slug: t.tools.slug }).from(t.tools);
  const taken = new Set(rows.filter((r) => r.id !== exceptId).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 44)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function authFromInput(
  db: Db,
  input: ToolAuthInput,
  previous?: Tool['auth'],
): Promise<Tool['auth']> {
  const auth: Tool['auth'] = { type: input.type };
  if (input.scopes) auth.scopes = input.scopes;
  else if (previous?.scopes) auth.scopes = previous.scopes;
  if (input.token) {
    if (previous?.secretRef) await deleteSecret(db, previous.secretRef);
    auth.secretRef = await storeSecret(db, input.token);
  } else if (previous?.secretRef && input.type !== 'none') {
    auth.secretRef = previous.secretRef;
  } else if (previous?.secretRef) {
    await deleteSecret(db, previous.secretRef);
  }
  return auth;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/** "Connect & test": stores the credential, probes the server, saves the tool with its real status. */
export async function connectTool(
  db: Db,
  input: ToolConnectInput,
): Promise<{ tool: Tool; probe: McpProbe }> {
  const agentIds = await agentIdsForSlugs(db, input.grant);
  const auth = await authFromInput(db, input.auth);
  const now = new Date();
  const host = input.url ? new URL(input.url).host : null;
  const base: Tool = {
    id: newId('tool'),
    slug: await uniqueSlug(db, slugify(input.name)),
    name: input.name,
    glyph: (input.glyph ?? glyphOf(input.name)).toUpperCase(),
    kind: 'mcp',
    category: input.category ?? 'Server',
    description:
      input.description ??
      (input.transport === 'http' ? `MCP server at ${host}` : `Local MCP server: ${input.command}`),
    transport: input.transport,
    url: input.url ?? null,
    command: input.command ?? null,
    auth,
    status: 'error',
    scopes: [],
    grantedAgents: agentIds,
    stats: { calls24h: 0, lastCallAt: null },
    createdAt: now,
    updatedAt: now,
  };
  const probe = await probeStored(db, base);
  const tool = applyProbe(base, probe, now);
  if (probe.ok && !input.category && probe.server?.name) tool.category = probe.server.name;
  await db.insert(t.tools).values(tool);
  await setAgentGrants(db, tool, agentIds);
  return { tool, probe };
}

/** Probes a saved tool again and records what it found. */
export async function retestTool(
  db: Db,
  id: string,
): Promise<{ tool: Tool; probe: McpProbe } | undefined> {
  const current = await getTool(db, id);
  if (!current) return undefined;
  const probe = await probeStored(db, current);
  const tool = applyProbe(current, probe, new Date());
  await db.update(t.tools).set(tool).where(eq(t.tools.id, id));
  return { tool, probe };
}

export async function updateTool(
  db: Db,
  id: string,
  patch: ToolPatch,
): Promise<{ tool: Tool; probe: McpProbe | null } | undefined> {
  const current = await getTool(db, id);
  if (!current) return undefined;
  if (current.kind === 'builtin' && (patch.url || patch.command || patch.auth || patch.transport)) {
    throw new ToolValidationError('Built-in tools have no connection to edit');
  }
  const agentIds = patch.grant ? await agentIdsForSlugs(db, patch.grant) : current.grantedAgents;
  const auth = patch.auth ? await authFromInput(db, patch.auth, current.auth) : current.auth;
  const reconnect =
    patch.auth !== undefined ||
    patch.url !== undefined ||
    patch.command !== undefined ||
    patch.transport !== undefined;

  let tool: Tool = {
    ...current,
    name: patch.name ?? current.name,
    slug:
      patch.name && patch.name !== current.name
        ? await uniqueSlug(db, slugify(patch.name), id)
        : current.slug,
    glyph: (patch.glyph ?? current.glyph).toUpperCase(),
    category: patch.category ?? current.category,
    description: patch.description ?? current.description,
    transport: patch.transport ?? current.transport,
    url: patch.url !== undefined ? patch.url : current.url,
    command: patch.command !== undefined ? patch.command : current.command,
    auth,
    grantedAgents: agentIds,
    updatedAt: new Date(),
  };
  const probe = reconnect ? await probeStored(db, tool) : null;
  if (probe) tool = applyProbe(tool, probe, tool.updatedAt);
  await db.update(t.tools).set(tool).where(eq(t.tools.id, id));
  if (patch.grant) await setAgentGrants(db, tool, agentIds);
  return { tool, probe };
}

/** Removes the tool, its credential and every agent's grant to it. */
export async function deleteTool(db: Db, id: string): Promise<boolean> {
  const current = await getTool(db, id);
  if (!current) return false;
  if (current.kind === 'builtin') throw new ToolValidationError('Built-in tools cannot be removed');
  await setAgentGrants(db, current, []);
  if (current.auth.secretRef) await deleteSecret(db, current.auth.secretRef);
  await db.delete(t.tools).where(eq(t.tools.id, id));
  return true;
}

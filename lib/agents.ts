import 'server-only';
import { asc, eq, gte, inArray } from 'drizzle-orm';
import type { Db } from './db';
import * as t from './db/schema';
import { computeAgentStats, initialsOf, slugify, type AgentStats } from './agents-util';
import { newId } from './ids';
import type { Agent, AgentInput, AgentPatch } from './schemas';

export type AgentRow = Agent & { stats: AgentStats };

export type ToolOption = { id: string; name: string; slug: string; scopes: string[] };
export type NamespaceOption = { id: string; label: string };

/** A request that is well-formed but refers to things that do not exist or are not allowed. */
export class AgentValidationError extends Error {
  readonly code = 'validation';
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function listAgents(db: Db, now = new Date()): Promise<AgentRow[]> {
  const [agents, recentRuns] = await Promise.all([
    db.select().from(t.agents).orderBy(asc(t.agents.name)),
    db
      .select({ id: t.runs.id, createdAt: t.runs.createdAt, plan: t.runs.plan })
      .from(t.runs)
      .where(gte(t.runs.createdAt, new Date(now.getTime() - WEEK_MS))),
  ]);
  return agents.map((a) => ({ ...a, stats: computeAgentStats(a.id, recentRuns, now) }));
}

export async function getAgent(db: Db, id: string): Promise<Agent | undefined> {
  const [row] = await db.select().from(t.agents).where(eq(t.agents.id, id));
  return row;
}

export async function listToolOptions(db: Db): Promise<ToolOption[]> {
  return db
    .select({ id: t.tools.id, name: t.tools.name, slug: t.tools.slug, scopes: t.tools.scopes })
    .from(t.tools)
    .orderBy(asc(t.tools.name));
}

export async function listNamespaceOptions(db: Db): Promise<NamespaceOption[]> {
  return db
    .select({ id: t.memoryNamespaces.id, label: t.memoryNamespaces.label })
    .from(t.memoryNamespaces)
    .orderBy(asc(t.memoryNamespaces.label));
}

/** Every granted tool must exist and every scope must be one the tool offers. */
async function validateGrants(db: Db, grants: AgentInput['tools']): Promise<void> {
  if (grants.length === 0) return;
  const ids = grants.map((g) => g.toolId);
  const tools = await db
    .select({ id: t.tools.id, name: t.tools.name, scopes: t.tools.scopes })
    .from(t.tools)
    .where(inArray(t.tools.id, ids));
  for (const grant of grants) {
    const tool = tools.find((x) => x.id === grant.toolId);
    if (!tool) throw new AgentValidationError(`Unknown tool: ${grant.toolId}`);
    for (const scope of grant.scopes) {
      if (!tool.scopes.includes(scope)) {
        throw new AgentValidationError(`${tool.name} does not offer the scope "${scope}"`);
      }
    }
  }
}

async function validateNamespaces(db: Db, scope: AgentInput['memoryScope']): Promise<void> {
  const wanted = Array.from(new Set([...scope.read, ...scope.write]));
  if (wanted.length === 0) return;
  const rows = await db
    .select({ id: t.memoryNamespaces.id })
    .from(t.memoryNamespaces)
    .where(inArray(t.memoryNamespaces.id, wanted));
  const known = new Set(rows.map((r) => r.id));
  const missing = wanted.filter((ns) => !known.has(ns));
  if (missing.length > 0) {
    throw new AgentValidationError(`Unknown memory namespace: ${missing.join(', ')}`);
  }
}

async function uniqueSlug(db: Db, base: string, exceptId?: string): Promise<string> {
  const rows = await db.select({ id: t.agents.id, slug: t.agents.slug }).from(t.agents);
  const taken = new Set(rows.filter((r) => r.id !== exceptId).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 44)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Keep `tools.grantedAgents` in step with the agents' grants (spec §6). */
async function syncGrantedAgents(db: Db, agentId: string, grantedToolIds: string[]) {
  const tools = await db
    .select({ id: t.tools.id, grantedAgents: t.tools.grantedAgents })
    .from(t.tools);
  for (const tool of tools) {
    const has = tool.grantedAgents.includes(agentId);
    const should = grantedToolIds.includes(tool.id);
    if (has === should) continue;
    const next = should
      ? [...tool.grantedAgents, agentId]
      : tool.grantedAgents.filter((id) => id !== agentId);
    await db
      .update(t.tools)
      .set({ grantedAgents: next, updatedAt: new Date() })
      .where(eq(t.tools.id, tool.id));
  }
}

export async function createAgent(db: Db, input: AgentInput): Promise<Agent> {
  await validateGrants(db, input.tools);
  await validateNamespaces(db, input.memoryScope);
  const now = new Date();
  const agent: Agent = {
    id: newId('agt'),
    slug: await uniqueSlug(db, slugify(input.name)),
    name: input.name,
    role: input.role,
    description: input.description,
    initials: (input.initials ?? initialsOf(input.name)).toUpperCase(),
    model: input.model,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    builtins: input.builtins,
    memoryScope: input.memoryScope,
    limits: input.limits,
    pauseAfter: input.pauseAfter,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(t.agents).values(agent);
  await syncGrantedAgents(
    db,
    agent.id,
    agent.tools.map((g) => g.toolId),
  );
  return agent;
}

export async function updateAgent(
  db: Db,
  id: string,
  patch: AgentPatch,
): Promise<Agent | undefined> {
  const current = await getAgent(db, id);
  if (!current) return undefined;
  if (patch.tools) await validateGrants(db, patch.tools);
  if (patch.memoryScope) await validateNamespaces(db, patch.memoryScope);

  const next: Agent = {
    ...current,
    ...patch,
    initials: (patch.initials ?? current.initials).toUpperCase(),
    slug:
      patch.name && patch.name !== current.name
        ? await uniqueSlug(db, slugify(patch.name), id)
        : current.slug,
    // Pausing a running agent is a request the engine honours between steps (PR 5); for now
    // the status flips directly.
    status: patch.status ?? current.status,
    updatedAt: new Date(),
  };
  await db.update(t.agents).set(next).where(eq(t.agents.id, id));
  if (patch.tools) {
    await syncGrantedAgents(
      db,
      id,
      next.tools.map((g) => g.toolId),
    );
  }
  return next;
}

export async function deleteAgent(db: Db, id: string): Promise<boolean> {
  const current = await getAgent(db, id);
  if (!current) return false;
  await syncGrantedAgents(db, id, []);
  await db.delete(t.agents).where(eq(t.agents.id, id));
  return true;
}

/**
 * Loading a roster of agents onto a bound repository: the pieces the development flock (D35) and
 * the software factory (D37) share. A roster is agents with grants on named repository roles
 * (`app`, `plans`), the namespaces they use and, for the flock, standing instructions. Each piece
 * changes only what differs, so loading twice changes nothing the second time.
 */
import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { and, eq } from 'drizzle-orm';
import type { Db } from './db';
import * as t from './db/schema';
import { NAMESPACES } from './db/seed-data';
import { createAgent, listAgents, updateAgent } from './agents';
import { plural } from './format';
import { updateMemory, writeMemory } from './memory';
import { inspectRepository, isScriptName, REPO_TOOLS, type RepoToolName } from './repo';
import type { Agent, Tool, ToolGrant } from './schemas';
import { connectTool, listTools, retestTool, updateTool } from './tools';

/** One agent of a roster: its settings, and the operations it holds on each repository role. */
export type RosterAgent<Role extends string = string> = Pick<
  Agent,
  | 'slug'
  | 'name'
  | 'initials'
  | 'role'
  | 'description'
  | 'model'
  | 'builtins'
  | 'memoryScope'
  | 'limits'
  | 'systemPrompt'
  | 'pauseAfter'
  | 'sendBackRounds'
  | 'templateOnly'
> & { grants: Record<Role, RepoToolName[]> };

/** A folder or script list a roster cannot use. `field` names the form field to fix. */
export class RosterValidationError extends Error {
  readonly code = 'validation';
  constructor(
    message: string,
    readonly field: 'path' | 'scripts',
  ) {
    super(message);
  }
}

export type RosterOutcome = 'created' | 'updated' | 'unchanged';

/** Splits "typecheck, lint test" into script names, keeping the order and dropping repeats. */
export function parseScripts(text: string): string[] {
  return Array.from(new Set(text.split(/[\s,]+/).filter(Boolean)));
}

/**
 * The repository folder and scripts a roster is loaded with, checked before anything is written:
 * at least one script, each a script name `package.json` has, in a git work tree.
 * `noScripts` is the refusal when none is named, in the roster's own words.
 */
export async function checkRepository(opts: {
  path: string;
  scripts: string[];
  noScripts: string;
}): Promise<{ path: string; scripts: string[] }> {
  const scripts = Array.from(new Set(opts.scripts.map((s) => s.trim()).filter(Boolean)));
  if (scripts.length === 0) throw new RosterValidationError(opts.noScripts, 'scripts');
  const badName = scripts.find((s) => !isScriptName(s));
  if (badName) throw new RosterValidationError(`“${badName}” is not a script name.`, 'scripts');

  const found = await inspectRepository(opts.path.trim());
  if (!found.ok) {
    const message = found.error.endsWith('.') ? found.error : `${found.error}.`;
    throw new RosterValidationError(message, 'path');
  }
  const missing = scripts.filter((s) => !found.scripts.includes(s));
  if (missing.length > 0) {
    throw new RosterValidationError(
      `package.json has no script named ${missing.join(', ')}. It has ${found.scripts.join(', ') || 'none'}.`,
      'scripts',
    );
  }
  return { path: found.path, scripts };
}

async function samePath(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) return true;
  const real = (p: string) => fs.realpath(p).catch(() => path.resolve(p));
  return (await real(a)) === (await real(b));
}

/**
 * Reuses a repository tool already bound to `opts.path`, or binds a new one. A reused folder
 * takes the scripts asked for (when given); a new tool gets a name no other tool has.
 */
export async function bindRepository(
  db: Db,
  opts: { name: string; path: string; scripts?: string[] },
): Promise<{ tool: Tool; outcome: RosterOutcome }> {
  const tools = await listTools(db);
  let existing: Tool | undefined;
  for (const tool of tools) {
    if (tool.kind === 'repository' && tool.repository) {
      if (await samePath(tool.repository.path, opts.path)) {
        existing = tool;
        break;
      }
    }
  }

  let tool: Tool;
  let outcome: RosterOutcome;
  if (existing) {
    const current = existing.repository!.scripts;
    const scripts = opts.scripts;
    if (
      scripts &&
      (current.length !== scripts.length || current.some((s, i) => s !== scripts[i]))
    ) {
      tool = (await updateTool(db, existing.id, { scripts }))!.tool;
      outcome = 'updated';
    } else if (existing.status !== 'connected') {
      tool = (await retestTool(db, existing.id))!.tool;
      outcome = 'unchanged';
    } else {
      tool = existing;
      outcome = 'unchanged';
    }
  } else {
    const names = new Set(tools.map((x) => x.name));
    let name = opts.name;
    for (let n = 2; names.has(name); n++) name = `${opts.name} ${n}`;
    ({ tool } = await connectTool(db, {
      name,
      transport: 'repository',
      path: opts.path,
      scripts: opts.scripts ?? [],
      auth: { type: 'none' },
      grant: [],
    }));
    outcome = 'created';
  }
  if (tool.status !== 'connected') {
    throw new Error(
      `${tool.name} could not be bound: ${tool.stats.lastError ?? 'the folder did not answer'}`,
    );
  }
  return { tool, outcome };
}

export type NamespaceOutcome = { id: string; outcome: 'created' | 'unchanged' };

/**
 * Every namespace a roster agent reads or writes, plus `also`; creates what is missing, labelled
 * from `labels`, then the starter namespaces, then the id itself.
 */
export async function ensureNamespaces(
  db: Db,
  agents: readonly Pick<RosterAgent, 'memoryScope'>[],
  opts: { also?: string[]; labels?: readonly { id: string; label: string }[] } = {},
): Promise<NamespaceOutcome[]> {
  const ids = new Set<string>(opts.also ?? []);
  for (const a of agents) {
    for (const ns of [...a.memoryScope.read, ...a.memoryScope.write]) ids.add(ns);
  }
  const labels = new Map<string, string>([
    ...NAMESPACES.map((n) => [n.key, n.label] as const),
    ...(opts.labels ?? []).map((n) => [n.id, n.label] as const),
  ]);
  const out: NamespaceOutcome[] = [];
  for (const id of ids) {
    const inserted = await db
      .insert(t.memoryNamespaces)
      .values({ id, label: labels.get(id) ?? id, createdAt: new Date() })
      .onConflictDoNothing()
      .returning({ id: t.memoryNamespaces.id });
    out.push({ id, outcome: inserted.length > 0 ? 'created' : 'unchanged' });
  }
  return out;
}

/** Standing instructions in `decisions`, written by the operator with confidence 1. */
export async function writeDecisions(
  db: Db,
  decisions: readonly { key: string; value: string }[],
): Promise<{ key: string; outcome: RosterOutcome }[]> {
  const out: { key: string; outcome: RosterOutcome }[] = [];
  for (const d of decisions) {
    const [existing] = await db
      .select({
        id: t.memory.id,
        value: t.memory.value,
        confidence: t.memory.confidence,
        source: t.memory.source,
      })
      .from(t.memory)
      .where(and(eq(t.memory.ns, 'decisions'), eq(t.memory.key, d.key)));
    if (!existing) {
      await writeMemory(
        db,
        {
          ns: 'decisions',
          key: d.key,
          value: d.value,
          confidence: 1,
          source: 'operator',
          expiresAt: null,
        },
        'user',
      );
      out.push({ key: d.key, outcome: 'created' });
    } else if (
      existing.value !== d.value ||
      existing.confidence !== 1 ||
      existing.source !== 'operator'
    ) {
      // A new version in its history, verified, so a confidence change is not left as a conflict.
      await updateMemory(db, existing.id, {
        value: d.value,
        confidence: 1,
        source: 'operator',
        verified: true,
      });
      out.push({ key: d.key, outcome: 'updated' });
    } else {
      out.push({ key: d.key, outcome: 'unchanged' });
    }
  }
  return out;
}

/** A grant per repository the agent may use, in the editor's order; never an empty one (D25). */
function repositoryGrants<Role extends string>(
  agent: RosterAgent<Role>,
  bindings: Record<Role, Tool>,
): ToolGrant[] {
  const ordered = (ops: RepoToolName[]) => REPO_TOOLS.filter((op) => ops.includes(op));
  return (Object.keys(bindings) as Role[])
    .map((role) => ({ toolId: bindings[role].id, scopes: ordered(agent.grants[role] ?? []) }))
    .filter((g) => g.scopes.length > 0);
}

/**
 * Creates or updates the roster's agents by slug. Grants on the bound repositories are set as
 * the roster says; grants on any other tool (the operator's GitHub, say) are kept.
 */
export async function upsertAgents<Role extends string>(
  db: Db,
  roster: readonly RosterAgent<Role>[],
  bindings: Record<Role, Tool>,
): Promise<{ name: string; outcome: RosterOutcome }[]> {
  const current = await listAgents(db);
  const bound = new Set(Object.values<Tool>(bindings).map((tool) => tool.id));
  const out: { name: string; outcome: RosterOutcome }[] = [];
  for (const def of roster) {
    const existing = current.find((a) => a.slug === def.slug);
    const fields = {
      name: def.name,
      role: def.role,
      description: def.description,
      model: def.model,
      systemPrompt: def.systemPrompt,
      builtins: def.builtins,
      memoryScope: def.memoryScope,
      limits: def.limits,
      pauseAfter: def.pauseAfter,
      sendBackRounds: def.sendBackRounds,
      templateOnly: def.templateOnly,
      tools: [
        ...(existing?.tools ?? []).filter((g) => !bound.has(g.toolId)),
        ...repositoryGrants(def, bindings),
      ],
    };
    if (!existing) {
      await createAgent(db, { ...fields, initials: def.initials });
      out.push({ name: def.name, outcome: 'created' });
      continue;
    }
    // The same fields as they are now. Key order is not compared: JSONB keeps its own.
    const before = Object.fromEntries(
      Object.keys(fields).map((k) => [k, existing[k as keyof typeof fields]]),
    );
    if (isDeepStrictEqual(before, fields)) {
      out.push({ name: def.name, outcome: 'unchanged' });
      continue;
    }
    await updateAgent(db, existing.id, fields);
    out.push({ name: def.name, outcome: 'updated' });
  }
  return out;
}

// ─── summary lines ─────────────────────────────────────────────────────────

/** "a", "a and b", "a, b and c". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export type RosterLine = { label: string; text: string };

const named = <T extends { outcome: string }>(
  rows: readonly T[],
  outcome: string,
  key: (r: T) => string,
) => rows.filter((r) => r.outcome === outcome).map(key);

/** "Created A and B. Updated C. No changes to D." */
export function agentsText(agents: readonly { name: string; outcome: RosterOutcome }[]): string[] {
  const out: string[] = [];
  const created = named(agents, 'created', (a) => a.name);
  const updated = named(agents, 'updated', (a) => a.name);
  const same = named(agents, 'unchanged', (a) => a.name);
  if (created.length) out.push(`Created ${andList(created)}.`);
  if (updated.length) out.push(`Updated ${andList(updated)}.`);
  if (same.length) out.push(`No changes to ${andList(same)}.`);
  return out;
}

/** "Bound A as a repository tool. Updated the scripts of B. Reused C." */
export function toolsText(tools: readonly { name: string; outcome: RosterOutcome }[]): string {
  const out: string[] = [];
  const bound = named(tools, 'created', (x) => x.name);
  const rescripted = named(tools, 'updated', (x) => x.name);
  const reused = named(tools, 'unchanged', (x) => x.name);
  if (bound.length) {
    const as = bound.length === 1 ? 'a repository tool' : 'repository tools';
    out.push(`Bound ${andList(bound)} as ${as}.`);
  }
  if (rescripted.length) out.push(`Updated the scripts of ${andList(rescripted)}.`);
  if (reused.length) out.push(`Reused ${andList(reused)}.`);
  return out.join(' ');
}

/** "Created the namespace x. Wrote 2 decisions entries." */
export function memoryText(
  namespaces: readonly NamespaceOutcome[],
  entries: readonly { key: string; outcome: RosterOutcome }[] = [],
): string {
  const out: string[] = [];
  const newNs = named(namespaces, 'created', (n) => n.id);
  if (newNs.length) {
    out.push(`Created the ${newNs.length === 1 ? 'namespace' : 'namespaces'} ${andList(newNs)}.`);
  }
  const entry = (n: number) => plural(n, 'decisions entry', 'decisions entries');
  const wrote = named(entries, 'created', (e) => e.key).length;
  const rewrote = named(entries, 'updated', (e) => e.key).length;
  const kept = named(entries, 'unchanged', (e) => e.key).length;
  if (wrote) out.push(`Wrote ${entry(wrote)}.`);
  if (rewrote) out.push(`Updated ${entry(rewrote)}.`);
  if (kept) out.push(`${entry(kept)} unchanged.`.replace(/^./, (c) => c.toUpperCase()));
  if (out.length === 0) out.push('Every namespace was already there.');
  return out.join(' ');
}

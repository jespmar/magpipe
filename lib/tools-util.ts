/** Pure helpers for the Tools screen, safe on the client. Tested in tests/tools-util.test.ts. */
import { initialsOf } from './agents-util';
import type { McpProbe } from './mcp';
import { plural } from './format';
import {
  toolConnectInput,
  type Tool,
  type ToolConnectInput,
  type ToolGrant,
  type ToolStatus,
} from './schemas';

/**
 * Whether a grant lets an agent call one of a server's tools (D25). A grant names the tools it
 * allows, and an empty grant allows none: unticking every box takes the server away rather than
 * handing over everything it exposes.
 */
export function grantAllows(grant: Pick<ToolGrant, 'scopes'>, name: string): boolean {
  return grant.scopes.includes(name);
}

/**
 * A grant made before Magpipe could list a server's tools has no names in it. When a probe first
 * finds them, each such grant gets every tool found, as granting a server with known tools does.
 * Returns the agent's new grants, or null when it had nothing waiting for this tool.
 */
export function fillPendingGrant(
  grants: readonly ToolGrant[],
  toolId: string,
  found: readonly string[],
): ToolGrant[] | null {
  if (found.length === 0) return null;
  let changed = false;
  const next = grants.map((g) => {
    if (g.toolId !== toolId || g.scopes.length > 0) return g;
    changed = true;
    return { ...g, scopes: [...found] };
  });
  return changed ? next : null;
}

/** The Connect panel's starting text — the example from the design, spec §3.5. */
export const CONNECT_EXAMPLE = `{
  "name": "younium",
  "transport": "http",
  "url": "https://mcp.younium.example/v1",
  "auth": { "type": "oauth2", "scopes": ["invoices:read", "customers:read"] },
  "grant": ["researcher", "coder"]
}`;

/** A two-letter tile for a tool, as initials are for an agent; the JSON may set `glyph`. */
export function glyphOf(name: string): string {
  return initialsOf(name);
}

/** "MCP · ERP" / "Built-in · Files". */
export function kindLabel(tool: Pick<Tool, 'kind' | 'category'>): string {
  return `${tool.kind === 'mcp' ? 'MCP' : 'Built-in'} · ${tool.category}`;
}

export const TOOL_STATUS: Record<
  ToolStatus,
  { variant: 'connected' | 'needs-auth' | 'failed'; label: string }
> = {
  connected: { variant: 'connected', label: 'Connected' },
  needs_auth: { variant: 'needs-auth', label: 'Needs auth' },
  error: { variant: 'failed', label: 'Error' },
};

export function matchesToolQuery(
  tool: Pick<Tool, 'name' | 'slug' | 'category' | 'description' | 'scopes'>,
  q: string,
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [tool.name, tool.slug, tool.category, tool.description, ...tool.scopes].some((s) =>
    s.toLowerCase().includes(needle),
  );
}

export type ParsedConnect = { ok: true; data: ToolConnectInput } | { ok: false; error: string };

/** JSON text → a validated connect body, or the first problem in plain words. */
export function parseConnectJson(text: string): ParsedConnect {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message.replace(/^JSON\.parse: /, '') : '';
    return { ok: false, error: `Not valid JSON${detail ? `: ${detail}` : ''}` };
  }
  const parsed = toolConnectInput.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue?.message ?? 'Invalid input';
    const field = issue?.path.join('.') ?? '';
    const names = field && !message.toLowerCase().includes(field.toLowerCase());
    return { ok: false, error: names ? `${message} (${field})` : message };
  }
  return { ok: true, data: parsed.data };
}

/** The one line the screen says after a connect or a test. */
export function describeProbe(probe: McpProbe, name: string, justSaved: boolean): string {
  if (probe.ok) {
    const found =
      probe.tools.length === 0 ? 'no tools exposed' : `${plural(probe.tools.length, 'tool')} found`;
    return `${name} connected · ${found}.`;
  }
  if (probe.status === 'needs_auth') {
    return `${name} ${justSaved ? 'saved · ' : ''}needs auth: ${probe.error}.`;
  }
  return justSaved ? `${name} saved · ${probe.error}.` : `${name}: ${probe.error}.`;
}

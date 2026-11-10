/**
 * Tool sessions (D22): while a step runs through Claude Code, its tools are reachable over the
 * app's own MCP endpoint (`/api/mcp`) under a one-time bearer token. The registry lives on
 * `globalThis` so it survives dev HMR; the backend registers a session before the step and
 * drops it after, whatever happened.
 */
import { randomBytes } from 'node:crypto';
import type { McpCallResult } from '../mcp';
import { invokeTool, type ToolRuntime, type Trail } from './tools';

export type ToolSession = {
  token: string;
  runtime: ToolRuntime;
  trail: Trail;
  agentName: string;
  createdAt: number;
};

const g = globalThis as unknown as { __magpipeToolSessions?: Map<string, ToolSession> };
const sessions = () => (g.__magpipeToolSessions ??= new Map());

/** Nothing outlives a step by more than this; a crash mid-step still cannot leave a door open. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function registerToolSession(
  input: Pick<ToolSession, 'runtime' | 'trail' | 'agentName'>,
): ToolSession {
  const now = Date.now();
  for (const [token, s] of sessions()) if (now - s.createdAt > MAX_AGE_MS) sessions().delete(token);
  const session: ToolSession = {
    ...input,
    token: randomBytes(24).toString('base64url'),
    createdAt: now,
  };
  sessions().set(session.token, session);
  return session;
}

export function getToolSession(token: string): ToolSession | undefined {
  return sessions().get(token);
}

export function unregisterToolSession(token: string): void {
  sessions().delete(token);
}

/** The step's client tools as MCP describes them; server tools (web search, fetch) have no schema and stay out. */
export function describeSessionTools(
  runtime: ToolRuntime,
): { name: string; description?: string; inputSchema: Record<string, unknown> }[] {
  const out: { name: string; description?: string; inputSchema: Record<string, unknown> }[] = [];
  for (const tool of runtime.tools) {
    if (!('input_schema' in tool) || !runtime.dispatch.has(tool.name)) continue;
    out.push({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.input_schema as Record<string, unknown>,
    });
  }
  return out;
}

/** `tools/call` for a session: the same dispatch and the same trail lines as the API tool loop. */
export async function callSessionTool(
  session: ToolSession,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const outcome = await invokeTool(session.runtime, session.trail, name, args);
  return { content: [{ type: 'text', text: outcome.text }], isError: outcome.isError === true };
}

/**
 * POST /api/mcp — the app as an MCP server for one step at a time (D22). Claude Code reaches a
 * step's memory tools and tool grants here, with the step's one-time bearer token; nothing
 * else answers without it. Streamable HTTP with JSON answers (no server-initiated stream).
 */
import { MCP_PROTOCOL_VERSION } from '@/lib/mcp';
import { callSessionTool, describeSessionTools, getToolSession } from '@/lib/engine/tool-sessions';

export const dynamic = 'force-dynamic';

type Rpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown };

const ok = (id: Rpc['id'], result: unknown) =>
  Response.json({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Rpc['id'], code: number, message: string) =>
  Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function POST(req: Request) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const session = token ? getToolSession(token) : undefined;
  if (!session) {
    return Response.json(
      { error: { code: 'unauthorized', message: 'Unknown or expired tool session.' } },
      { status: 401 },
    );
  }

  let msg: Rpc;
  try {
    msg = (await req.json()) as Rpc;
  } catch {
    return fail(null, -32700, 'Parse error');
  }
  if (Array.isArray(msg)) return fail(null, -32600, 'Batches are not supported');
  // Notifications (no id) are acknowledged and otherwise ignored.
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 });

  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<
    string,
    unknown
  >;
  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'magpipe', version: '0.1' },
      });
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: describeSessionTools(session.runtime) });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (
        params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
      ) as Record<string, unknown>;
      if (!name) return fail(msg.id, -32602, 'tools/call needs a name');
      return ok(msg.id, await callSessionTool(session, name, args));
    }
    default:
      return fail(msg.id, -32601, `Method not found: ${msg.method ?? '(none)'}`);
  }
}

export function GET() {
  return new Response('This endpoint answers MCP requests over POST.', { status: 405 });
}

/** Session teardown: there is nothing to tear down, the step's token simply expires with the step. */
export function DELETE() {
  return new Response(null, { status: 200 });
}

#!/usr/bin/env node
/**
 * A fake `claude` for the Claude Code backend's tests: it speaks print mode's JSON and
 * stream-json shapes, reads the prompt from stdin like the real thing, and, for a step, uses
 * the MCP server named in --mcp-config exactly as Claude Code would (initialize, tools/list,
 * tools/call). Behaviour is steered by FAKE_CLAUDE_* environment variables.
 *
 *   FAKE_CLAUDE_FAIL=auth | max_turns | crash   fail the call that way
 *   FAKE_CLAUDE_HANG=1                           never answer (cancellation tests)
 *   FAKE_CLAUDE_TURNS=<n>                        assistant turns before the result (default 2)
 *   FAKE_CLAUDE_WRITE=<json>                     memory_write arguments to call through MCP
 */
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const format = flag('--output-format') ?? 'text';
const schema = flag('--json-schema');
const mcpConfig = flag('--mcp-config');
const model = flag('--model') ?? 'fake';

if (args.includes('--version')) {
  console.log('2.1.322 (Claude Code)');
  process.exit(0);
}

const prompt = await new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => resolve(data));
});

if (process.env.FAKE_CLAUDE_HANG === '1') {
  // A timer keeps the loop alive: a bare unsettled top-level await makes node exit with 13.
  await new Promise((resolve) => setTimeout(resolve, 120_000));
}
if (process.env.FAKE_CLAUDE_FAIL === 'crash') {
  console.error('fake claude: boom');
  process.exit(2);
}

const usage = {
  input_tokens: 300,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 50,
  output_tokens: 80,
};
const result = (extra) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 12,
  num_turns: 1,
  session_id: 'fake-session',
  total_cost_usd: 0.0123,
  usage,
  stop_reason: 'end_turn',
  ...extra,
});
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (process.env.FAKE_CLAUDE_FAIL === 'auth') {
  emit(
    result({ is_error: true, result: 'Authentication error · Not logged in', total_cost_usd: 0 }),
  );
  process.exit(0);
}

if (format === 'json') {
  if (schema) {
    const structured = process.env.FAKE_CLAUDE_PLAN
      ? JSON.parse(process.env.FAKE_CLAUDE_PLAN)
      : {
          steps: [
            {
              id: 's1',
              agent: 'researcher',
              title: 'Answer the task',
              instructions: 'Answer it in one line.',
              dependsOn: [],
              optional: false,
            },
          ],
        };
    emit(result({ result: JSON.stringify(structured), structured_output: structured }));
  } else {
    emit(result({ result: `## Merged by the fake claude\n\n${prompt.slice(0, 60)}` }));
  }
  process.exit(0);
}

// ── a step over stream-json, with the MCP round trip ───────────────────────
emit({
  type: 'system',
  subtype: 'init',
  model,
  tools: [],
  mcp_servers: [{ name: 'magpipe', status: 'connected' }],
});

let rpcId = 0;
async function rpc(server, method, params) {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(server.headers ?? {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`mcp ${method} → HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`mcp ${method} → ${body.error.message}`);
  return body.result;
}

const server = mcpConfig ? JSON.parse(mcpConfig).mcpServers?.magpipe : null;
let toolLines = [];
if (server) {
  await rpc(server, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fake-claude', version: '0' },
  });
  const { tools } = await rpc(server, 'tools/list', {});
  toolLines.push(`tools: ${tools.map((t) => t.name).join(', ')}`);
  const write = process.env.FAKE_CLAUDE_WRITE ? JSON.parse(process.env.FAKE_CLAUDE_WRITE) : null;
  if (write && tools.some((t) => t.name === 'memory_write')) {
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'mcp__magpipe__memory_write', input: write },
        ],
        usage,
      },
    });
    const out = await rpc(server, 'tools/call', { name: 'memory_write', arguments: write });
    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: out.content, is_error: out.isError },
        ],
      },
    });
    toolLines.push(`wrote: ${out.content.map((c) => c.text).join('')}`);
  }
}

const turns = Number(process.env.FAKE_CLAUDE_TURNS ?? '2');
for (let i = 1; i < turns; i++) {
  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `Working, turn ${i}.` }], usage },
  });
}
if (process.env.FAKE_CLAUDE_FAIL === 'max_turns') {
  emit(result({ is_error: true, subtype: 'error_max_turns', result: 'Reached max turns' }));
  process.exit(0);
}
const finalText = `Fake answer to: ${
  prompt
    .split('\n')
    .find((l) => l.startsWith('Your step:'))
    ?.slice(11)
    .trim() ?? 'the step'
}. ${toolLines.join(' ')}`.trim();
emit({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: finalText }], usage },
});
emit(result({ result: finalText, num_turns: turns }));

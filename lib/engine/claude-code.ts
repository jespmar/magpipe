/**
 * The Claude Code backend (D22): a plan, a step or a merge is one `claude -p` on the operator's
 * machine, with the login Claude Code already has. A step's tools are served back to the CLI by
 * the app's own MCP endpoint (tool-sessions.ts), so memory scope and tool grants hold exactly as
 * they do on the API path. The CLI's own tools stay off except WebSearch and WebFetch, and only
 * when the agent holds those built-ins.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../env';
import type { Usage } from '../schemas';
import { ZERO_USAGE } from '../pricing';
import type { RunBackend, StepRequest } from './backend';
import { abortError, EngineError, withRetries } from './model';
import { registerToolSession, unregisterToolSession } from './tool-sessions';
import type { Trail } from './tools';

const execFileAsync = promisify(execFile);

export type ClaudeCli = {
  path: string;
  /** Arguments that go before Claude Code's own (tests run the fake CLI through node). */
  argsPrefix?: string[];
  version?: string;
};

/** The oldest CLI the adapter was built against: print mode with `--bare`, `--json-schema` and `--strict-mcp-config`. */
export const CLI_MIN_VERSION = '2.1.0';

export const CLI_MISSING_MESSAGE =
  'Claude Code was not found on this machine. Install it, or set MAGPIPE_CLAUDE_PATH in magpipe.env (File → Open Config File) to the claude command, then restart Magpipe.';
export const CLI_LOGIN_MESSAGE =
  'Claude Code is not signed in. Run `claude` once in Terminal, sign in, then try again.';

/** The MCP server name Claude Code sees; its tools arrive as `mcp__magpipe__<name>`. */
const MCP_SERVER = 'magpipe';
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

// ─── finding the CLI ──────────────────────────────────────────────────────

function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1];
}

function olderThan(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

async function executable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `command -v claude` in a login shell: an app launched from Finder or a launcher gets no PATH of its own. */
async function fromLoginShell(): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('where', ['claude'], { timeout: 5000 });
      return (
        stdout
          .split(/\r?\n/)
          .find((l) => l.trim())
          ?.trim() ?? null
      );
    }
    const shell =
      process.env.SHELL && (await executable(process.env.SHELL)) ? process.env.SHELL : '/bin/sh';
    const { stdout } = await execFileAsync(shell, ['-lc', 'command -v claude'], { timeout: 5000 });
    const found = stdout.trim().split('\n').pop()?.trim();
    return found && (await executable(found)) ? found : null;
  } catch {
    return null;
  }
}

/** Where the installers put it when it is not on the PATH. */
function usualPlaces(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd'),
      path.join(home, '.claude', 'local', 'claude.exe'),
    ];
  }
  return [
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.npm-global', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
}

export async function cliVersion(cli: ClaudeCli): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(cli.path, [...(cli.argsPrefix ?? []), '--version'], {
      timeout: 10_000,
      env: childEnv(),
    });
    return parseVersion(stdout);
  } catch {
    return undefined;
  }
}

let discovered: Promise<ClaudeCli | null> | null = null;

/** The `claude` command for this machine, found once per process. `null` when there is none. */
export function findClaudeCli(): Promise<ClaudeCli | null> {
  discovered ??= (async () => {
    const candidates = [
      ...(env.MAGPIPE_CLAUDE_PATH ? [env.MAGPIPE_CLAUDE_PATH] : []),
      ...((await fromLoginShell()) ? [(await fromLoginShell())!] : []),
      ...usualPlaces(),
    ];
    for (const file of candidates) {
      if (!(await executable(file))) continue;
      const cli: ClaudeCli = { path: file };
      cli.version = await cliVersion(cli);
      return cli;
    }
    return null;
  })();
  return discovered;
}

export type BackendInfo = {
  backend: 'api' | 'claude-code';
  cli: ClaudeCli | null;
  /** What stands in the way, when something does. */
  problem?: string;
};

/** The facts the Settings screen shows about how runs reach Claude. */
export async function describeModelBackend(): Promise<BackendInfo> {
  if (env.MAGPIPE_MODEL_BACKEND !== 'claude-code') return { backend: 'api', cli: null };
  const cli = await findClaudeCli();
  if (!cli) return { backend: 'claude-code', cli, problem: CLI_MISSING_MESSAGE };
  if (cli.version && olderThan(cli.version, CLI_MIN_VERSION)) {
    return {
      backend: 'claude-code',
      cli,
      problem: `Claude Code ${cli.version} is older than ${CLI_MIN_VERSION}; update it.`,
    };
  }
  return { backend: 'claude-code', cli };
}

// ─── running it ───────────────────────────────────────────────────────────

/**
 * The CLI gets a clean environment: nothing of Magpipe's, and no ANTHROPIC_* either, so it
 * uses its own login rather than a key that happens to be in magpipe.env. The nested-session
 * markers go too, in case Magpipe itself was started from a Claude Code terminal.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const out = { ...process.env };
  for (const k of Object.keys(out)) {
    if (
      /^(ANTHROPIC_|MAGPIPE_|AUTH_|NEXTAUTH_|DATABASE_URL$|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$)/.test(
        k,
      )
    )
      delete out[k];
  }
  return out;
}

type CliUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

/** The CLI's final `result` line (print mode, `json` and `stream-json` alike). */
export type CliResult = {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  usage?: CliUsage;
  total_cost_usd?: number;
  num_turns?: number;
  stop_reason?: string | null;
  structured_output?: unknown;
};

type StreamLine =
  | { type: 'assistant'; message?: { content?: unknown; usage?: CliUsage } }
  | { type: 'user'; message?: { content?: unknown } }
  | CliResult
  | { type: string };

export function usageFrom(u: CliUsage | undefined, costUsd: number | undefined): Usage {
  if (!u) return { ...ZERO_USAGE, costUsd: costUsd ?? 0 };
  return {
    inputTokens:
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    costUsd: costUsd ?? 0,
  };
}

/** What a failed result means for the step: a stable code, copy that says what to do, whether to retry. */
export function failureFrom(res: CliResult, who: string): EngineError {
  const text = (res.result ?? '').trim();
  if (
    /authentication|not logged in|log ?in|sign ?in|invalid api key|oauth|credential/i.test(text)
  ) {
    return new EngineError('no_api_key', CLI_LOGIN_MESSAGE);
  }
  if (res.subtype === 'error_max_turns') {
    return new EngineError('limit_steps', `${who} used all of its allowed tool rounds.`);
  }
  if (res.subtype === 'error_max_budget_usd') {
    return new EngineError('limit_budget', `${who} hit the spend limit Claude Code was given.`);
  }
  if (res.stop_reason === 'refusal') {
    return new EngineError('refusal', `${who} declined this step.`);
  }
  return new EngineError(
    'provider_error',
    `Claude Code reported: ${text || res.subtype || 'an unknown error'}`,
    true,
  );
}

type RunOptions = {
  cwd?: string;
  /** Written to the CLI's stdin: the user message. */
  input: string;
  signal: AbortSignal;
  /** Each JSON line of `stream-json` as it arrives; may stop the run by throwing. */
  onLine?: (line: StreamLine) => Promise<void> | void;
};

/** Spawns the CLI once and resolves with its `result` line; throws `EngineError` when it never produced one. */
export async function runCli(cli: ClaudeCli, args: string[], opts: RunOptions): Promise<CliResult> {
  if (opts.signal.aborted) throw abortError();
  const shell = process.platform === 'win32' && /\.cmd$/i.test(cli.path);
  const child = spawn(cli.path, [...(cli.argsPrefix ?? []), ...args], {
    cwd: opts.cwd,
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell,
  });

  let stderr = '';
  let result: CliResult | null = null;
  let pending = Promise.resolve();
  let lineError: unknown = null;
  let buffer = '';

  const handle = (line: string) => {
    if (!line.trim()) return;
    let parsed: StreamLine;
    try {
      parsed = JSON.parse(line) as StreamLine;
    } catch {
      return; // the CLI's own chatter, not an event
    }
    if (parsed.type === 'result') result = parsed as CliResult;
    if (opts.onLine) {
      pending = pending
        .then(() => opts.onLine!(parsed))
        .catch((err) => {
          lineError ??= err;
          child.kill('SIGTERM');
        });
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf('\n');
    while (at !== -1) {
      handle(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  const onAbort = () => child.kill('SIGTERM');
  opts.signal.addEventListener('abort', onAbort, { once: true });
  const killTimer = setTimeout(() => {
    if (opts.signal.aborted && child.exitCode === null) child.kill('SIGKILL');
  }, 5000);

  try {
    const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once('error', (error) => resolve({ code: null, error }));
      child.once('close', (code) => resolve({ code }));
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input);
    });
    if (buffer) handle(buffer);
    await pending;
    if (lineError) throw lineError;
    if (opts.signal.aborted) throw abortError();
    if (exit.error) {
      const code = (exit.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES')
        throw new EngineError('no_cli', CLI_MISSING_MESSAGE);
      throw new EngineError(
        'transport',
        `Claude Code could not start: ${exit.error.message}`,
        true,
      );
    }
    if (!result) {
      throw new EngineError(
        'transport',
        `Claude Code exited with code ${exit.code ?? '?'} without a result${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : '.'}`,
        true,
      );
    }
    return result;
  } finally {
    clearTimeout(killTimer);
    opts.signal.removeEventListener('abort', onAbort);
  }
}

// ─── the backend ──────────────────────────────────────────────────────────

export type ClaudeCodeOptions = {
  /** The CLI to run; defaults to whatever `findClaudeCli` turns up. */
  cli?: () => Promise<ClaudeCli | null>;
  /** The app's own origin, where `/api/mcp` answers; defaults to this server's port. */
  serverUrl?: string;
};

function selfUrl(): string {
  if (env.MAGPIPE_SELF_URL) return env.MAGPIPE_SELF_URL;
  return `http://127.0.0.1:${process.env.PORT ?? '3456'}`;
}

const COMMON_ARGS = ['-p', '--bare'];

/** Text and tool blocks of one stream line, in Claude Code's message shape. */
type Block = {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};
function blocksOf(line: StreamLine): Block[] {
  const content = (line as { message?: { content?: unknown } }).message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((c) =>
        c && typeof c === 'object' && typeof (c as Block).text === 'string'
          ? (c as Block).text
          : '',
      )
      .filter(Boolean)
      .join('\n');
  return '';
}

export function claudeCodeBackend(options: ClaudeCodeOptions = {}): RunBackend {
  const getCli = async (): Promise<ClaudeCli> => {
    const cli = await (options.cli ?? findClaudeCli)();
    if (!cli) throw new EngineError('no_cli', CLI_MISSING_MESSAGE);
    return cli;
  };
  const mcpUrl = () => `${(options.serverUrl ?? selfUrl()).replace(/\/$/, '')}/api/mcp`;

  async function single(
    req: { model: string; system: string; user: string },
    extra: string[],
    signal: AbortSignal,
  ): Promise<{ res: CliResult; text: string; usage: Usage }> {
    const cli = await getCli();
    const res = await runCli(
      cli,
      [
        ...COMMON_ARGS,
        '--output-format',
        'json',
        '--tools',
        '',
        '--model',
        req.model,
        '--system-prompt',
        req.system,
        ...extra,
      ],
      { input: req.user, signal },
    );
    if (res.is_error) throw failureFrom(res, 'The orchestrator');
    return {
      res,
      text: (res.result ?? '').trim(),
      usage: usageFrom(res.usage, res.total_cost_usd),
    };
  }

  return {
    name: 'claude-code',

    async plan(req, signal) {
      const { res, text, usage } = await single(
        req,
        ['--json-schema', JSON.stringify(req.schema)],
        signal,
      );
      const structured = res.structured_output;
      return { text: structured !== undefined ? JSON.stringify(structured) : text, usage };
    },

    async merge(req, signal) {
      const { text, usage } = await single(req, [], signal);
      return { text, usage };
    },

    async step(req, signal) {
      const cli = await getCli();
      return withRetries(() => runStepOnce(cli, req, mcpUrl(), signal), {
        signal,
        onRetry: (f, n) => req.trail.emit('error', `Retry ${n}: ${f.message}`),
      });
    },
  };
}

async function runStepOnce(
  cli: ClaudeCli,
  req: StepRequest,
  mcpUrl: string,
  signal: AbortSignal,
): Promise<{ summary: string; usage: Usage }> {
  const { agent, trail } = req;
  const session = registerToolSession({ runtime: req.runtime, trail, agentName: agent.name });
  try {
    const cliTools = [
      ...(agent.builtins.includes('web.search') ? ['WebSearch'] : []),
      ...(agent.builtins.includes('web.fetch') ? ['WebFetch'] : []),
    ];
    const mcpConfig = {
      mcpServers: {
        [MCP_SERVER]: {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: `Bearer ${session.token}` },
        },
      },
    };
    const args = [
      ...COMMON_ARGS,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      agent.model,
      '--system-prompt',
      req.system,
      '--permission-mode',
      'dontAsk',
      '--tools',
      ...(cliTools.length ? cliTools : ['']),
      '--allowedTools',
      ...cliTools,
      `mcp__${MCP_SERVER}`,
      '--disallowedTools',
      'Bash',
      'Edit',
      'Write',
      'NotebookEdit',
      '--mcp-config',
      JSON.stringify(mcpConfig),
      '--strict-mcp-config',
    ];

    // Limits are enforced from the stream, turn by turn: the CLI has no per-call cap for them.
    let turns = 0;
    let usage = ZERO_USAGE;
    let lastText = '';
    const toolNames = new Map<string, string>();
    const onLine = async (line: StreamLine) => {
      if (line.type === 'assistant') {
        turns += 1;
        if (turns > agent.limits.maxSteps) {
          throw new EngineError(
            'limit_steps',
            `${agent.name} used all ${agent.limits.maxSteps} allowed tool rounds.`,
          );
        }
        const u = (line as { message?: { usage?: CliUsage } }).message?.usage;
        if (u) {
          const turn = usageFrom(u, 0);
          usage = {
            inputTokens: usage.inputTokens + turn.inputTokens,
            outputTokens: usage.outputTokens + turn.outputTokens,
            costUsd: 0,
          };
          if (usage.inputTokens + usage.outputTokens > agent.limits.maxTokens) {
            throw new EngineError(
              'limit_tokens',
              `${agent.name} exceeded its ${agent.limits.maxTokens}-token limit.`,
            );
          }
        }
        for (const block of blocksOf(line)) {
          if (block.type === 'text' && block.text?.trim()) {
            lastText = block.text.trim();
            await trail.emit('message', lastText);
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            if (block.id) toolNames.set(block.id, block.name);
            // Magpipe's own tools are recorded by the MCP endpoint as they are called.
            if (block.name.startsWith(MCP_PREFIX)) continue;
            await trail.emit(
              'tool_call',
              `${block.name}: ${JSON.stringify(block.input ?? {}).slice(0, 300)}`,
              { tool: block.name, input: block.input ?? {} },
            );
          }
        }
      } else if (line.type === 'user') {
        for (const block of blocksOf(line)) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const name = toolNames.get(block.tool_use_id) ?? 'tool';
          if (name.startsWith(MCP_PREFIX)) continue;
          await trail.emit(
            block.is_error ? 'error' : 'tool_result',
            `${name} → ${textOfContent(block.content).slice(0, 300)}`,
            { tool: name, isError: block.is_error === true },
          );
        }
      }
    };

    const res = await runCli(cli, args, { cwd: req.sandboxDir, input: req.user, signal, onLine });
    if (res.is_error) throw failureFrom(res, agent.name);
    const final = usageFrom(res.usage, res.total_cost_usd);
    // The result line is the authority on tokens and cost when it carries them.
    const total: Usage = {
      inputTokens: final.inputTokens || usage.inputTokens,
      outputTokens: final.outputTokens || usage.outputTokens,
      costUsd: final.costUsd,
    };
    if (total.inputTokens + total.outputTokens > agent.limits.maxTokens) {
      throw new EngineError(
        'limit_tokens',
        `${agent.name} exceeded its ${agent.limits.maxTokens}-token limit.`,
      );
    }
    return { summary: (res.result ?? '').trim() || lastText, usage: total };
  } finally {
    unregisterToolSession(session.token);
  }
}

export type { Trail };

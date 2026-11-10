# Claude Code as a second model backend (scope)

Status: built (D22 in `decisions.md` records what changed against this scope). The code is `lib/engine/backend.ts`, `lib/engine/claude-code.ts`, `lib/engine/tool-sessions.ts` and `app/api/mcp/route.ts`; the tests are `tests/claude-code.test.ts` with the fake CLI in `tests/stubs/claude.mjs`.

## Goal

Let a flight run through the Claude Code that is installed on the operator's machine, so the
login Claude Code already has (a Claude subscription, or an API key it was given) powers Magpipe
without an `ANTHROPIC_API_KEY` in `magpipe.env`. The API backend stays and the two are
selectable; Claude Code is the default (changed from the scope's "API by default" when it was
built, so a fresh install needs no key). Nothing about what a run is changes: plan, steps, merge, the trail, the
limits and the memory rules are the same whichever backend answers.

## Not in scope

- Hosted mode. The CLI lives on the operator's machine; a server has no Claude Code login.
- Bundling Claude Code. The app uses the `claude` the operator installed.
- A settings editor. The backend is chosen in `magpipe.env`; Settings shows the facts. The first
  editable setting is its own change.
- Giving agents Claude Code's `Bash`, `Edit` or `Write`. Agents reach the world through the
  tools Magpipe grants (spec §7.4, §11); the CLI's own tools stay off except where a grant maps
  onto one (below).

## Confirm before building

1. **Terms.** Whether a Claude Pro or Max login may power the Agent SDK or the CLI's print mode
   from another app on the operator's own machine. The CLI itself accepts either login; what we
   must know is whether the subscription case is allowed. If it is not, this backend only moves
   an API key from `magpipe.env` into Claude Code and is not worth building.
2. **Print-mode details on the pinned CLI** (2.1.x): that `--system-prompt` replaces the CLI's
   own prompt entirely, the field that carries `--json-schema` output in the JSON result
   (`structured_output`), and that `stream-json` carries every assistant message and tool block.
   One afternoon with the real binary settles all three.

## Design

### A backend seam above the model client

Today `planRun`, `runStep` and `mergeRun` take a `ModelClient` (one Messages API call) and the
engine owns the tool loop. Claude Code owns its own loop, so the seam moves one level up:

```ts
// lib/engine/backend.ts
export interface RunBackend {
  plan(input: PlanInput, signal: AbortSignal): Promise<{ json: unknown; usage: Usage }>;
  step(
    input: StepInput,
    trail: Trail,
    signal: AbortSignal,
  ): Promise<{ summary: string; usage: Usage }>;
  merge(input: MergeInput, signal: AbortSignal): Promise<{ markdown: string; usage: Usage }>;
}
```

- `apiBackend(client)` wraps the three functions as they are (no behaviour change; the scripted
  stub keeps working through it, so unit and e2e tests do not move).
- `claudeCodeBackend(cli)` implements them with the CLI.
- `Engine.execute` calls the backend; everything around it (durable plan, fan-out, retries,
  cancel, resume, spend cap, status updates) stays where it is.

### A step is one `claude -p`

Per step, one child process in the run's sandbox folder (so `Read` sees the attachments):

```
claude -p --setting-sources "" --no-session-persistence --disable-slash-commands
  --output-format stream-json --verbose
  --model <agent.model>
  --system-prompt <the same system text runStep builds today>
  --tools <built-ins by grant, or "" for none>
  --allowedTools <the same list> mcp__magpipe__*
  --disallowedTools Bash Edit Write NotebookEdit
  --permission-mode dontAsk
  --mcp-config '<inline JSON for the Magpipe MCP server>' --strict-mcp-config
```

(As built: `--bare` is out because it never reads the keychain login; the limits are enforced
from the stream because print mode has no turn cap. D22 lists every deviation.)

- **Grants map onto CLI tools:** `web.search` → `WebSearch`, `web.fetch` → `WebFetch`,
  `files.read` → `Read`, `Glob`, `Grep` (confined to the sandbox by `--bare`). Anything else is
  refused by `dontAsk` instead of prompting; nothing is reachable that was not granted.
- **The user message** is today's: the task, the step, earlier results, attached file names.
- **Trail:** `stream-json` events become `message`, `tool_call` and `tool_result` events through
  `emitEvent`, as the API loop writes them now; the CLI's final `result` carries the summary,
  `usage`, `total_cost_usd`, `num_turns` and an error subtype.
- **Limits:** `maxSteps` is `--max-turns`; `timeoutSec` kills the process; `maxTokens` is checked
  from the reported usage after the step (the CLI cannot stop mid-turn on tokens), failing the
  step with the same `limit_tokens` error.
- **Failures map to `EngineError` codes:** `error_max_turns` → `limit_steps`, a refusal → `refusal`,
  a non-zero exit before any result → `transport` (retried by `withRetries`, like a network error
  today), a login problem → `no_api_key` with backend-specific copy.
- **Cancel** aborts the signal, which kills the child; a restart resumes from `runs.plan` as now.
- **Fan-out** runs steps as parallel processes, capped at three.

### Magpipe's tools over MCP

Claude Code reaches Magpipe's memory and the agent's MCP grants through one MCP server that
the app itself serves: `app/api/mcp/route.ts`, Streamable HTTP, JSON-RPC `initialize`,
`tools/list`, `tools/call`. Each step gets a one-time token in the server URL that names the run,
the step and the agent, so the route applies that agent's memory scope and tool grants and
nothing else can call it.

- `memory_search`, `memory_get`, `memory_write`: the handlers `setupTools` builds today, moved
  behind the route so both backends share them; rejected writes and memory writes land in the
  trail as they do now.
- Granted MCP tools: proxied through `connectMcp` under `wireName(slug, name)`; a server that is
  down costs the step its tools and logs it (D19), not the step.
- Claude Code sees them as `mcp__magpipe__<name>`; the config is `--mcp-config` inline with
  `--strict-mcp-config`, so the operator's own MCP servers never leak into a flight.
- The route is also a small self-check: `lib/mcp.ts` is an MCP client, so a unit test connects to
  our own server with our own client.

### Plan and merge

The orchestrator's two calls are single prompts, so they are `claude -p --bare --tools ""`:

- **Plan:** `--output-format json --json-schema <PLAN_JSON_SCHEMA>`, the same system prompt,
  validated by the existing zod `planOutput`, then the same checks (unknown agents, cycles).
- **Merge:** plain text result, the same prompt. Both use `settings.models.orchestrator`.

### Usage and cost

Tokens come from the result's `usage` (cache reads count as input, as the API path counts them).
Cost comes from `total_cost_usd`; on a subscription that figure is notional, so the run's cost
is stored as reported and the Runs screen says "as metered by Claude Code" next to spend when
this backend was used. The daily spend cap applies to that number.

### Choosing the backend and finding the CLI

- `MAGPIPE_MODEL_BACKEND=api|claude-code` in `magpipe.env` (default `claude-code`), and
  `MAGPIPE_CLAUDE_PATH` to point at a binary.
- Discovery on desktop: `MAGPIPE_CLAUDE_PATH`, then `claude` on the login shell's `PATH` (an app
  launched from Finder gets a minimal `PATH`, so `electron/config.ts` asks `/bin/zsh -lc
'command -v claude'` once at start), then the usual places (`~/.claude/local/claude`,
  `/opt/homebrew/bin`, `/usr/local/bin`). Windows and Linux work the same way wherever
  `claude` is installed.
- Pin a minimum CLI version (the one the adapter was built against) and read `claude --version`
  at start; an older binary fails the first run with a clear line.
- Settings → Models shows the backend, the CLI path and version, and the last check. The failure
  copy for a missing login becomes backend-specific: "Claude Code is not signed in: run `claude`
  once in Terminal and sign in, then try again."

### Tests

- Unit: a `StubBackend` scripts plan, step and merge; the CLI adapter is tested against a fake
  `claude` (`tests/stubs/claude.mjs`) that emits canned `stream-json`, including a refusal, a
  max-turns stop and a crash. The MCP route is tested with `connectMcp`.
- E2E: unchanged; the Playwright server keeps the scripted model through the API backend.
- Nothing needs credentials (CLAUDE.md).

## Risks

- **Terms** (above) decide whether the change is worth making at all.
- **CLI drift.** The adapter leans on print-mode flags and the `stream-json` shape; keep it
  small, pin a minimum version, and keep the API backend as the fallback.
- **Two system prompts.** Claude Code wraps conversations in its own instructions; if
  `--system-prompt` does not replace them fully, agents answer in Claude Code's register. The
  check in "Confirm before building" covers it.
- **Shared rate limits.** A subscription's limits are shared with the operator's own Claude Code
  sessions; a four-step flight is four turns of their quota.
- **Different tool semantics.** `WebSearch` and `WebFetch` are Claude Code's tools, not the
  API's server tools; results may differ in shape and the trail names them by the CLI's names.

## Size and order

One PR of roughly the engine's size, in this order so each step is reviewable and the first
two are useful alone:

1. The backend seam and `apiBackend` (pure refactor; tests unchanged).
2. The Magpipe MCP route with the memory tools and proxied grants (useful to any MCP client).
3. The CLI adapter: step, then plan and merge; the fake `claude` and its tests.
4. Selection and discovery in `lib/env.ts` and `electron/config.ts`; Settings facts; the
   failure copy; README "Using your Claude Code login".
5. Docs: D22 updated from "scoped" to "built", DESIGN.md untouched.

If review size matters, split after step 2.

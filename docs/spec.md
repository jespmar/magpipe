# Magpipe — Agent Orchestrator · Application Spec

> Hand-off spec for Claude Code. Build the application described here in a fresh repo.
> Design source of truth: the Design canvas at https://claude.ai/code/artifact/09ab71eb-323f-435b-8646-4a89660253a3
> (artboards: `Main`, `Wide`, `Agents`, `Runs`, `Tools`, `Memory` + `*Wide` variants, `Logos`).
> Logo source: `magpipe-magpie-logo-03.svg` (dark magpie, white plumage, blue-green wing). Put it in `public/brand/`.
>
> **Repo note:** the app ships first as a self-contained Electron desktop app (embedded Postgres,
> in-app run engine, no sign-in on desktop). `docs/decisions.md` overrides §2 and §6's MongoDB
> details accordingly.

---

## 1. What Magpipe is

Magpipe is a web app that orchestrates a small fleet of AI agents ("the flock"). A user types a task in a prompt box (with file attachments); the orchestrator ("Magpipe") splits it into subtasks, routes each to an agent, runs them (in parallel where possible), merges the results, and writes durable learnings into shared memory ("the nest"). Everything is observable: every run ("flight") has a step-by-step trail of which agent did what, when, with which tool, at what cost.

Bird vocabulary is **UI copy only**. Code uses plain names: `Agent`, `Run`, `Step`, `Tool`, `MemoryEntry`.

| UI term        | Code term     |
| -------------- | ------------- |
| The flock      | agents        |
| Bird           | agent         |
| Flight         | run           |
| Flight log     | run events    |
| The nest       | memory        |
| Shiny bit      | memory entry  |
| Beaks & claws  | tools         |

### Non-goals (v1)
- No multi-user orgs / RBAC beyond a single workspace with login.
- No billing. Cost is displayed, not charged.
- No visual workflow builder. Routing is done by the orchestrator agent.

---

## 2. Stack

- **Next.js 15 (App Router) + TypeScript**, deployed on **Vercel**.
- **MongoDB Atlas** via Mongoose (or the native driver with zod schemas — pick one and stay consistent).
- **Inngest** for run execution (durable steps, retries, fan-out, cancellation). One Inngest function per run; each agent step is an Inngest `step.run`.
- **VoltAgent** for agent definitions, tool calling and MCP client. Model provider: Anthropic (Claude) by default; model per agent is configurable.
- **Tailwind CSS v4** with design tokens from §4 as CSS variables. **Inter** (Google Fonts) + system mono stack.
- **Auth.js** (GitHub + email magic link) — single workspace, any signed-in user is admin in v1.
- **Vercel Blob** for uploaded files.
- Realtime: **Server-Sent Events** from `/api/runs/[id]/events` backed by a change stream / polling on the `run_events` collection. No websockets.
- Tests: Vitest (unit), Playwright (3 smoke flows). ESLint + Prettier.

---

## 3. Screens

All screens share the shell in §3.1. Layouts are fluid; two reference widths exist on the canvas: **1280** (desktop) and **2560 × 1440** (wide). Implement with responsive CSS, not two codebases. Breakpoints: `<768` stack everything; `768–1279` as desktop; `≥1600` switch to the wide arrangements.

### 3.1 App shell
- **Top nav** (sticky, frosted: `rgba(16,16,16,.72)` + `backdrop-filter: blur(14px)`, bottom hairline `rgba(34,193,220,.28)`):
  - Left: logo on a 36 px white disc + "Magpipe" (16/600) + "agent orchestrator" (12/500 mute). Links to `/`.
  - Center: links **Agents · Runs · Tools · Memory**. Active link: white, 600, 2 px bottom border `#22c1dc`.
  - Right: live pill "N active" (pulsing white dot, hairline pill) + outline **Settings** button.
- **Footer**: "Magpipe · agent orchestrator" left, `v{version} · {region}` right in mono.
- **Page background**: `#101010` with the ambient layer: radial cyan glow top-center (`rgba(34,193,220,.14)`), faint emerald glow bottom-right (`rgba(22,163,94,.10)`), 24 px dot grid (`rgba(255,255,255,.045)` 1 px dots).
- Container: `max-width: 1200px` (desktop), `2300px` (wide), gutters 32 / 48 px.

### 3.2 Home `/` (artboards `Main`, `Wide`)
Three zones. Desktop stacks them; wide puts **agents | core | flight log** in a row with the prompt full-width underneath.

1. **Agents on duty** — grid of `AgentCard`s (2×2 desktop). Eyebrow "THE FLOCK", h1 "Birds on the wire", ghost button "+ Add a bird" → `/agents?new=1`.
2. **The nest (orchestrator core)** — the orb: white 68 px disc with the logo, three concentric translucent cyan rings, a dashed rotating orbit (16 s) and a counter-rotating conic arc (26 s), faint cyan grid behind it masked radially. Under it: eyebrow "THE NEST", h2 "Magpipe is flying {activeCount} agents", one-line description, three mono counters: **runs today · queued · tokens used**.
3. **Flight log** (wide only on Home; desktop shows it on `/runs/[id]`) — streaming list of run events: `time · agent · text`, with a "streaming" pulse when a run is live.
4. **Prompt window** — `PromptComposer` (§5.6): label "ASK MAGPIPE", textarea, attachment chips, "Attach files" outline button, hint "PDF, CSV, images, code · up to 25 MB", `⌘ + Enter` hint, white **Run** button with cyan glow. Submitting creates a run and navigates to `/runs/[id]`.

### 3.3 Agents `/agents` (artboards `Agents`, `AgentsWide`)
- Head: eyebrow "THE FLOCK", h1 "Agents", search input, primary "+ Add a bird".
- Filter pills: All · Running · Waiting · Idle with counts (selected = white fill).
- **List** (left): rows `avatar+name+role | status | model | runs·7d`. Selected row: 2 px cyan left edge + `rgba(34,193,220,.06)` fill.
- **Detail** (right): name/role, Edit + Pause; description; three stat tiles (runs·7d, success %, avg tokens); **Tools** chips (mono); **Memory scope** text; **System prompt** in a `<pre>` code mockup with Copy.
- `?new=1` or "+ Add a bird" opens `AgentEditor` (modal, §5.7).

### 3.4 Runs `/runs` and `/runs/[id]` (artboards `Runs`, `RunsWide`)
- Head: eyebrow "FLIGHTS", h1 "Runs", search, primary "New run" → `/`.
- Stats strip (4 tiles): runs today · succeeded (7d %) · median duration · spend today.
- Filter pills: All · Running · Done · Failed · Queued.
- **Table**: `flight id (mono) | task | bird avatars | status | duration | tokens | started`. Horizontal scroll box under 900 px.
- **Selected run → flight path**: ordered step cards `AGENT · what · meta`. States: `done` (emerald dot), `live` (cyan border+fill, cyan dot), `failed` (red `#f87171`), `todo` (grey). Desktop: horizontal chain with arrows; wide: vertical timeline on the right. Buttons: **Open log**, **Re-fly** (creates a new run with the same input).
- `/runs/[id]` = the same detail plus the full streaming flight log and the final output (markdown rendered) and artifacts (files produced).

### 3.5 Tools `/tools` (artboards `Tools`, `ToolsWide`)
- Head: eyebrow "BEAKS & CLAWS", h1 "Tools", search, primary "+ Connect tool" toggles an inline **Connect panel** with a JSON editor (example below) and "Connect & test".
- Grid of `ToolCard`s (3-up desktop, 4-up wide): glyph tile, name, kind (e.g. "MCP · ERP"), status pill (**Connected** cyan / **Needs auth** amber `#fbbf24` / **Error** red), description, scope chips (mono), granted-agent avatars, `calls · 24h`.

```json
{
  "name": "younium",
  "transport": "http",
  "url": "https://mcp.younium.example/v1",
  "auth": { "type": "oauth2", "scopes": ["invoices:read", "customers:read"] },
  "grant": ["researcher", "coder"]
}
```

### 3.6 Memory `/memory` (artboards `Memory`, `MemoryWide`)
- Head: eyebrow "THE NEST", h1 "Memory", search, primary "+ Add fact".
- **Namespaces** sidebar with counts (Rate limits, Facts, Decisions, Incidents, Tenants — user-creatable). Below it **Nest health**: facts, stale (>30 d, amber), conflicts (red), verified-% progress bar (white→cyan gradient).
- **Entries table**: `key (mono) | value | by (avatar) | updated`.
- **Detail**: `ns / key`, value, Edit + Forget; confidence, source, read-by, expires; raw JSON `<pre>`. Wide: three columns side by side.

### 3.7 Settings `/settings` (no artboard — keep minimal, same chrome)
Model provider keys, default models, spend cap per day, region label, workspace name.

---

## 4. Design tokens

Implement as CSS variables in `app/globals.css` and map into Tailwind theme. Do **not** introduce a light mode.

```css
:root {
  /* surfaces */
  --canvas: #101010; --canvas-soft: #1a1a1a; --canvas-raised: #181818;
  --hairline: #3d3a39; --hairline-soft: #1f1f1f;
  /* text */
  --ink: #f2f2f2; --ink-strong: #ffffff; --body: #bdbdbd; --mute: #8b949e; --code-text: #f5f6f7;
  /* accent: white is the solid accent; the sheen lives in gradients */
  --accent: #ffffff; --on-accent: #101010; --ghost: #d1d5db;
  --sheen-cyan: #22c1dc; --sheen-teal: #0e9aa8; --sheen-emerald: #16a35e; --sheen-cyan-soft: #66d9e8; --sheen-tint: #d6f5f7;
  --warn: #fbbf24; --danger: #f87171;
  /* gradients */
  --g-sheen: linear-gradient(135deg, #22c1dc 0%, #0e9aa8 55%, #16a35e 100%);
  --g-sheen-text: linear-gradient(90deg, #ffffff 0%, #66d9e8 45%, #22c1dc 100%);
  --g-card: linear-gradient(180deg, #181818 0%, #101010 100%);
  --g-panel: linear-gradient(180deg, #141a1a 0%, #141414 100%);
  --g-progress: linear-gradient(90deg, #ffffff 0%, #22c1dc 100%);
  --g-button: linear-gradient(135deg, #ffffff 0%, #d6f5f7 60%, #a8e8ee 100%);
  /* radii */
  --r-xs: 4px; --r-sm: 6px; --r-md: 8px; --r-pill: 9999px;
  /* glow */
  --glow-cyan: 0 0 22px rgba(34,193,220,.3);
}
```

Typography (Inter unless noted; mono = `SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`):

| Token            | Size/LH   | Weight | Notes                                  |
| ---------------- | --------- | ------ | -------------------------------------- |
| display-xl       | 60/60     | 400    | tracking −0.65px (hero only)           |
| display-lg       | 36/40     | 400    | tracking −0.9px · page h1 (48/52 wide) |
| display-md       | 24/32     | 700    | tracking −0.6px                        |
| display-sm       | 20/28     | 600    | card titles                            |
| eyebrow          | 14/20     | 600    | uppercase, tracking 2.52px, `--g-sheen-text` clipped to text |
| label            | 12/16     | 600    | uppercase, tracking 1.2px, mute (table headers) |
| body-lg / md / sm| 18/28 · 16/26 · 14/20 | 400 |                                  |
| caption          | 12/16     | 400/500|                                        |
| code             | 13/18     | 400    | mono; `code-strong` 550                |
| button           | 16/24 · 14/20 | 600 |                                        |

Rules: cards = hairline border, no drop shadows (hover: border `rgba(34,193,220,.45)` + `0 0 28px rgba(34,193,220,.12)`); buttons 6 px radius; pills 9999; green/purple never appear; the primary button is **white** (not a colour).

---

## 5. Components (`components/`)

1. `AppShell` — nav, footer, ambient background, active-link logic.
2. `Logo` — inline SVG from the brand file; props `size`, `onDisc` (white disc behind). Wing fill uses `--g-sheen` via `<linearGradient>`.
3. `OrchestratorOrb` — the animated core; props `activeCount`, `size` (260 desktop / 400 wide). Pure CSS animations; respect `prefers-reduced-motion`.
4. `AgentCard` — avatar initials (mono), name, role, `StatusPill`, current task, progress bar, model chip, `tokens · elapsed`.
5. `StatusPill` — variants `running` (cyan), `waiting` (white), `idle` (mute), `done` (emerald), `failed` (red), `needs-auth` (amber).
6. `PromptComposer` — textarea + attachments (drag-drop and picker; chips with size and remove) + Run. `⌘/Ctrl+Enter` submits. Max 25 MB per file, 10 files.
7. `AgentEditor` — modal form: name, role, description, model (select), system prompt (textarea), tools (multi-select from registry with scope checkboxes), memory scope (read/write per namespace), max tokens / max steps.
8. `RunTable`, `RunFlightPath` (horizontal/vertical via prop), `RunEventLog` (SSE consumer, auto-scroll, pause on hover).
9. `ToolCard`, `ToolConnectPanel` (JSON editor with validation + "Connect & test" calling `POST /api/tools/test`).
10. `MemoryTable`, `MemoryDetail`, `NamespaceNav`, `NestHealth`.
11. `StatTile`, `CodeBlock` (with Copy), `FilterPills`, `SearchInput`, `DataTable` (12-col CSS grid, header label style).

Accessibility: real `<button>`/`<a>`; icon-only buttons get `aria-label`; all text ≥ 4.5:1 on `#101010`; focus ring white 2 px.

---

## 6. Data model (MongoDB)

```ts
// agents
{ _id, slug, name, role, description, initials, model: string, systemPrompt: string,
  tools: [{ toolId, scopes: string[] }],
  memoryScope: { read: string[] /* ns */, write: string[] },
  limits: { maxTokens: number, maxSteps: number, timeoutSec: number },
  status: 'idle'|'running'|'waiting'|'paused', createdAt, updatedAt }

// runs  (UI: flights)
{ _id, displayId /* 'flight_8f3a21' = base36 of counter */, input: { text, attachments: [{ blobUrl, name, size, mime }] },
  status: 'queued'|'running'|'done'|'failed'|'cancelled', plan: Step[],
  startedAt, finishedAt, durationMs, usage: { inputTokens, outputTokens, costUsd },
  output: { markdown, artifacts: [{ blobUrl, name }] }, parentRunId?, createdBy }

// Step (embedded in run.plan)
{ id, agentId, title, dependsOn: string[], status: 'todo'|'live'|'done'|'failed'|'skipped',
  startedAt?, finishedAt?, usage?, result?: { summary, data? }, error? }

// run_events  (UI: flight log)
{ _id, runId, ts, stepId?, agentId? /* null = orchestrator */, kind: 'plan'|'message'|'tool_call'|'tool_result'|'memory_write'|'error'|'done',
  text, payload? }

// tools
{ _id, slug, name, kind: 'mcp'|'builtin', transport: 'http'|'stdio'|'builtin', url?, command?,
  auth: { type: 'none'|'bearer'|'oauth2'|'apikey', secretRef?, scopes? }, status: 'connected'|'needs_auth'|'error',
  scopes: string[] /* discovered tool names */, grantedAgents: string[], stats: { calls24h, lastCallAt, lastError? } }

// memory  (UI: the nest)
{ _id, ns, key, value: string, data?: any, confidence: number /* 0–1 */, source: string,
  writtenBy: agentId|'user', readBy: string[], expiresAt?: Date|null, verifiedAt, createdAt, updatedAt,
  history: [{ value, confidence, writtenBy, at }] }
// unique index (ns, key); text index (key, value); conflicts = same (ns,key) write with |Δconfidence| > .3 → flagged

// settings: single doc { models, spendCapUsd, region, workspaceName }
```

Secrets (tool credentials) are stored encrypted (AES-GCM, key from env) and referenced by `secretRef`.

---

## 7. Agent runtime

### 7.1 Orchestrator (Magpipe)
A VoltAgent supervisor agent with a fixed system prompt. Given the run input and the agent registry it must return a **plan**: an array of steps `{ agentSlug, title, instructions, dependsOn[] }` as strict JSON (use tool/function calling for the schema, not free text). Rules:
- Prefer the fewest agents that can do the job; parallelise independent steps.
- Always read memory first: the orchestrator receives the top-k relevant memory entries (text search on the task + all `decisions`) and includes relevant ones in each step's instructions.
- A final **merge** step (orchestrator itself) composes `run.output.markdown` from step results.

### 7.2 Execution (Inngest)
`runs/execute` function, triggered by `run.created`:
1. `step.run('plan')` → orchestrator plan → save `run.plan`, emit `plan` event.
2. Topologically schedule steps; independent steps via `step.run` inside `Promise.all` (fan-out). Each step:
   - loads the agent, its granted tools (MCP clients via VoltAgent), its memory scope;
   - streams events to `run_events` (`message`, `tool_call`, `tool_result`, `memory_write`);
   - enforces `limits` (tokens, steps, timeout) → `failed` with error on breach;
   - writes `result.summary` (≤ 1k chars) + optional `data`.
3. `step.run('merge')` → output; set `done`; update `usage`/cost (price table in `lib/pricing.ts`).
4. Failure in a step marks the run `failed` unless the step is optional; downstream steps `skipped`. Retries: 2 per step with backoff for tool/network errors only, never for model-refusal/validation errors.
5. `run.cancel` event → Inngest cancellation; mark `cancelled`.

### 7.3 Memory behaviour
- Agents write memory only through the `memory.write` built-in tool, which requires `ns`, `key`, `value`, `confidence`, `source`, optional `expiresAt`. Writes outside the agent's `memoryScope.write` are rejected and logged.
- Reads go through `memory.search(ns?, query)` (text index) and `memory.get(ns, key)`.
- Nightly Inngest cron: mark entries `stale` (verifiedAt > 30 d), drop expired ones, recompute nest-health counters.

### 7.4 Built-in tools
`memory.*`, `fs.read/fs.write/shell.run` (sandboxed per run in a temp dir, wiped after), `web.search`, `web.fetch`, `files.read` (run attachments). Everything else comes from MCP servers registered in `/tools`.

---

## 8. API (route handlers under `app/api/`)

| Method & path                      | Purpose                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `GET/POST /agents`, `GET/PATCH/DELETE /agents/[id]` | CRUD; `PATCH { status:'paused' }` pauses     |
| `POST /runs`                       | `{ text, attachmentIds[] }` → creates run, emits `run.created` |
| `GET /runs?status=&q=&cursor=`     | list with counts for filter pills                              |
| `GET /runs/[id]`, `POST /runs/[id]/cancel`, `POST /runs/[id]/refly` | detail / cancel / re-run same input  |
| `GET /runs/[id]/events` (SSE)      | `event: run_event` stream; replays last 200 then tails         |
| `POST /uploads`                    | multipart → Vercel Blob → `{ id, name, size, mime, url }`      |
| `GET/POST /tools`, `PATCH/DELETE /tools/[id]`, `POST /tools/test`, `POST /tools/[id]/auth/start|callback` | registry, test connection (lists MCP tools → `scopes`), OAuth |
| `GET /memory?ns=&q=`, `POST /memory`, `PATCH/DELETE /memory/[id]`, `GET /memory/health` | nest                     |
| `GET /stats/home`                  | `{ activeAgents, runsToday, queued, tokensToday, spendToday }` |
| `GET/PATCH /settings`              |                                                                |

All routes require a session. Validate bodies with zod; return `{ error: { code, message } }` on failure.

---

## 9. Seed data

Ship `scripts/seed.ts` with the four agents from the design (Researcher, Coder, Reviewer, Operator — prompts as on the Agents artboard), the nine tools from the Tools artboard (statuses as shown, Younium = `needs_auth`), and ~12 memory entries across the five namespaces from the Memory artboard. Seed a handful of finished runs so the Runs screen is not empty.

---

## 10. Build order (one PR each)

1. **Scaffold**: Next.js, Tailwind tokens (§4), fonts, `AppShell`, `Logo`, empty routes for all screens, auth, Mongo connection, seed script.
2. **Agents screen** + `AgentEditor` + API.
3. **Tools screen** + registry + MCP test connection + secret storage.
4. **Memory screen** + API + health cron.
5. **Run engine**: Inngest function, orchestrator plan, step execution, events, pricing.
6. **Home**: `PromptComposer`, uploads, `OrchestratorOrb`, `AgentCard`s with live status, stats.
7. **Runs screen** + `/runs/[id]` with SSE log, flight path, re-fly, cancel.
8. **Wide layouts** (`≥1600`), reduced-motion, keyboard shortcuts, Playwright smoke tests (create run → see events → done; add agent; connect tool).

Definition of done for each PR: typecheck + lint + unit tests green, screen matches its artboard at 1280 and 2560 widths (manual check), no console errors.

---

## 11. Open questions (decide in PR 1 and record in `docs/decisions.md`)

- Mongoose vs native driver + zod.
- Where sandboxed `shell.run` executes on Vercel (recommendation: a small Fly.io/ECS runner called over HTTP; stub it in v1 with an allow-list of safe commands).
- Whether `Reviewer` may approve PRs automatically or only comment (design copy says "humans merge").

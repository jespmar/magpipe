# Decisions

Recorded in PR 1 (scaffold), as asked by spec §11. Each entry: decision, why, consequences.

**The big one:** Magpipe ships first as a **self-contained desktop app** — one installer, no
Docker, no cloud accounts, nothing else to install. The only outbound calls are the model
provider (Anthropic) and the MCP tools you connect. That overrides three items of spec §2:

| Spec §2                  | Desktop app                                         | Entry |
| ------------------------ | --------------------------------------------------- | ----- |
| MongoDB Atlas            | Embedded Postgres (PGlite) + Drizzle                | D1    |
| Inngest                  | Run engine inside the app, state in the database    | D5    |
| Auth.js (GitHub + email) | No sign-in; per-launch token gates the local server | D4    |
| Vercel Blob              | Files in the app's data folder                      | D3    |

The code keeps the hosted path open: Drizzle runs on any Postgres, Auth.js (GitHub) stays
wired for a `signin` access mode, and the run engine sits behind an interface Inngest can
implement later.

---

## D1 · Database: embedded Postgres (PGlite) + Drizzle — not MongoDB

- **What.** [PGlite](https://pglite.dev) is real Postgres (18.x) compiled to WebAssembly,
  running _inside_ the Next.js server process. No server to install or start, no native
  modules. Data lives in `<data dir>/db`. Drizzle ORM provides typed queries and SQL
  migrations (`drizzle/`, applied automatically on start-up).
- **Why not MongoDB.** A self-contained installer would have to ship and supervise the `mongod`
  binary (~150–200 MB per platform, a second process, SSPL redistribution terms). Embedded
  SQLite was the other candidate; it is smaller, but Node's built-in SQLite is still
  experimental and a hosted version would need a different database. With Postgres the same
  schema and queries run on a hosted Postgres (Neon, Supabase, RDS) by swapping the driver.
- **Verified here.** PGlite inside the Next standalone server: JSONB, full-text search
  (`english` stemming), constraints, persistence across process restarts (`tests/db.test.ts`
  and a manual run of the production server).
- **Shapes.** zod schemas in `lib/schemas` stay the source of truth for row types and API
  validation; the Drizzle tables in `lib/db/schema.ts` must select exactly those shapes —
  `lib/db/schema-check.ts` fails the typecheck when they drift. Nested structures from spec §6
  (plan, tools, memory scope, history, …) are JSONB columns; timestamps inside JSON are ISO
  strings. Optional top-level fields are `null`.
- **Single process.** PGlite allows one process per data directory. `lib/db` takes a lock file
  (`db.lock`, pid inside) and refuses to open if another live process holds it, so
  `npm run seed` cannot corrupt the database of a running app. Stale locks are taken over.
- **Clean shutdown.** On quit, Electron calls `POST /api/internal/shutdown`, which closes the
  database before the server exits (killing the process is abrupt on Windows).
- **Backups.** Copy the data folder while Magpipe is closed.

## D2 · Ids are prefixed strings

- `agt_…`, `run_…`, `tool_…`, `mem_…`, `evt_…` (`lib/ids.ts`, 16 chars of Crockford base32).
  Runs also get the human `displayId` (`flight_8f3a21`, base36 of the `run_seq` sequence).
- **Why.** Readable in logs and URLs, stable across databases, generated without a round-trip.
- `run_events.seq` (bigserial) is the ordering and SSE resume cursor; `ts` alone can collide.

## D3 · Desktop: Electron shell around the Next.js server

- **Shape.** One Next.js app. `output: 'standalone'` produces `.next/standalone/server.js`;
  the Electron main process forks it in a `utilityProcess` bound to `127.0.0.1` and loads it in
  a `BrowserWindow`. Dev: `npm run dev` runs `next dev` and opens Electron against it.
- **Origin.** The server binds `127.0.0.1`; the window uses `http://localhost:<port>` because
  Next rewrites loopback hosts to `localhost` in redirects and cookies are per host name.
  Port 3456 is preferred (stable origin → stable localStorage); a random free port is the
  fallback.
- **Data folder.** `<userData>/data` (`MAGPIPE_DATA_DIR`): `db/` now, uploads and per-run
  sandboxes later. Uploads replace Vercel Blob on desktop (PR 6).
- **Config.** `<userData>/magpipe.env` (template written on first launch; File → Open Config
  File). Build-machine `.env*` files and any dev `.magpipe/` folder are stripped from the
  bundle (`scripts/prepare-standalone.mjs`).
- **Security.** `contextIsolation`, `sandbox`, no `nodeIntegration`; the preload exposes only
  `window.magpipeDesktop.{platform,versions}`. In-place navigation is limited to the app
  origin — everything else opens in the system browser. Permissions are denied except
  clipboard writes from the app origin. `<webview>` is blocked.
- **macOS chrome.** `titleBarStyle: 'hiddenInset'`; the frosted nav is the drag region. The
  root layout detects Electron from the user agent and sets `html[data-desktop]` on first paint.
- **Packaging.** electron-builder's two-`package.json` layout: `dist-electron/` (compiled main
  - a dependency-free manifest) becomes `app.asar`; the standalone server ships as
    `resources/server`. Installers are built per OS by `.github/workflows/desktop.yml`.
    The traced `node_modules` of the standalone server travel through their own
    `extraResources` entry (`.next/standalone/node_modules` → `server/node_modules`):
    electron-builder's copy filter always skips a source directory's top-level `node_modules`,
    whatever the pattern says, so a single entry from `.next/standalone` ships a server that
    cannot find `next`. `npm run dist` builds the installer for the host OS; the first Linux
    build here ran the AppImage headless and its embedded server answered `/api/health`.

## D4 · Access: per-launch token on desktop, Auth.js only for hosting

`lib/auth-mode.ts` picks one of three modes:

- **`desktop`** (`MAGPIPE_DESKTOP_TOKEN` set). The Electron main process generates a random
  token per launch, passes it to the server and sets it as an `httpOnly`, `SameSite=Strict`
  session cookie in the app window. Middleware rejects every request without it and every
  request whose `Host` is not `localhost`/`127.0.0.1` (DNS rebinding). Result: no sign-in, yet
  other local programs and web pages in your normal browser cannot drive the app or spend your
  API key. `/api/health` stays public for the boot probe.
- **`open`** (`MAGPIPE_AUTH_DISABLED=true`): `npm run dev:web` and e2e tests. Ignored when
  `VERCEL` is set.
- **`signin`**: Auth.js v5 with GitHub, JWT sessions, for a future hosted deployment. Email
  magic links and the database adapter were dropped with MongoDB; add `@auth/drizzle-adapter`
  if a hosted version needs them.

Middleware runs on the Node.js runtime (stable in Next 15.5).

## D5 · Run engine: inside the app (replaces Inngest) — for PR 5

Inngest Cloud cannot call a server on your machine, and bundling the self-hosted Inngest
server would add another binary and process. The engine runs in the Next server process
instead, with these requirements carried over from spec §7.2:

- **Durable steps.** Step state lives in `runs.plan` and is written before and after each step;
  events go to `run_events`. On start-up, runs left `running` are resumed: `live` steps go back
  to `todo` and re-run (steps must therefore be safe to retry).
- **Fan-out.** Steps whose `dependsOn` are all `done` run concurrently (`Promise.all`), with a
  small global concurrency cap.
- **Retries.** 2 per step with backoff, for tool/network errors only — never for model refusals
  or validation errors.
- **Cancellation.** An `AbortController` per run; `POST /api/runs/[id]/cancel` aborts it and
  marks the run `cancelled`.
- **Nightly memory job** (§7.3) runs on a timer inside the app, and also at start-up if the last
  run was more than 24 h ago (the app is not always open at night).
- Keep the engine behind a small interface (`enqueue(runId)`, `cancel(runId)`) so an Inngest
  implementation can be added for a hosted version.

## D6 · `shell.run` sandbox (spec §11)

- **v1:** stub with an allow-list of safe commands, as the spec recommends.
- **Later:** on desktop, run commands locally in a per-run temp dir under the data folder,
  behind an explicit setting; a hosted version would use a remote runner.
- Status: recommendation — confirm when PR 5 adds the built-in tools.

## D7 · Reviewer may approve, never merge (spec §11)

The design settles it: memory entry `decisions/pr.merge_policy` = "Reviewer approves, humans
merge", and Reviewer's prompt says "Approve only with green tests". Reviewer may submit an
approving review when tests are green; no agent gets a merge scope.

## D8 · Schema additions beyond spec §6

| Where               | Addition                                                | Why                                                                                                  |
| ------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `agents`            | `builtins: ('web.search'\|'web.fetch'\|'files.read')[]` | Core built-ins are per agent but are not registry tools; `memory.*` stays governed by `memoryScope`. |
| `tools`             | `glyph`, `category`, `description`, timestamps          | The ToolCard shows them ("VN", "MCP · ERP", description).                                            |
| `runs`              | `createdAt`                                             | Queued runs have no `startedAt`; lists sort by creation.                                             |
| `runs.plan[]`       | `instructions?`, `optional?`                            | Orchestrator plan output (§7.1); optional steps (§7.2.4).                                            |
| `run_events`        | `seq`                                                   | Ordering and SSE resume cursor (D2).                                                                 |
| `memory`            | `stale`, `conflict`, generated `search`                 | Nest health (§3.6, §7.3); full-text search.                                                          |
| `memory_namespaces` | new table `{ id: key, label }`                          | Namespaces are user-creatable and have display labels.                                               |
| `run_seq`           | sequence                                                | Backs `displayId`.                                                                                   |

## D9 · Model ids

The artboards show `claude-sonnet-5.5`; the API ids are `claude-sonnet-5-5`,
`claude-opus-5-5`, `claude-haiku-5-5`. Seed data and settings use the API ids.

## D10 · First launch and demo data

- **First launch** creates the settings row, the five memory namespaces and the four starter
  agents (Researcher, Coder, Reviewer, Operator) without tool grants — a usable, honest empty
  workspace.
- **Settings → Load demo data** (or `npm run seed` with the app closed) adds the design's nine
  tools, twelve memory entries and four finished runs, and grants the agents their tools. The
  demo tools point at `*.example` URLs; they look connected but are not.
- The artboards disagree with each other in places; the demo data is made consistent and
  `tests/seed-data.test.ts` enforces it: only finished runs; "decision · Jesper" entries are
  `writtenBy: 'user'`; Researcher also reads/writes `tenants` and gets GitHub `repo:r`;
  `readBy` is filtered to agents whose scope covers the namespace; one incident
  (`younium.oauth.expired`) was added to reach 12 entries; `costUsd` is 0 until
  `lib/pricing.ts` exists (PR 5).

## D11 · Toolchain pins

Next.js **15.5** (per spec), React 19, Tailwind 4, TypeScript 5.9, ESLint 9 with
`eslint-config-next@15` (flat config via `FlatCompat`), Vitest 5, Playwright, Electron 45,
electron-builder 26, PGlite 0.5, Drizzle 0.45. npm, not pnpm (electron-builder and Next
standalone both prefer a flat `node_modules`). Revisit TypeScript and ESLint majors together
with a Next 16 upgrade.

## D12 · Design-detector exceptions and the first critique

The first `$impeccable critique` of the shell (22/40, snapshot in `.impeccable/critique/`) drove
the shell-fix pass. Three detector rules fire on every page by design and are accepted, recorded
in `.impeccable/critique/ignore.md` so later critiques skip them:

| Rule                                         | Why it is intentional                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kicker-above-heading` / `hero-eyebrow-chip` | The eyebrow ("THE FLOCK", "BEAKS & CLAWS") is part of the design canvas and spec §4.                                                                          |
| `gradient-text`                              | The eyebrow's sheen gradient is the brand's one gradient-on-text (spec §4). A single short word renders solid instead, so it never splits two-tone.           |
| `overused-font`                              | Inter is the only family by spec; an Operate surface needs no second face.                                                                                    |
| `dark-glow`                                  | The white primary button carries the sheen glow pinned by the Agents artboard (`0 0 22px rgba(34,193,220,.25)`); DESIGN.md "Light as State". Added with PR 2. |

Two implementation lessons from the same pass, now conventions in `CLAUDE.md`: prose widths in
`rem` (Inter is narrower than its `0`, so `ch` overshoots the 75-character measure), and no
`revalidatePath('/', 'layout')` from server actions (it makes the production router fall back to
a hard navigation; the form stays pending). Fresh workspaces now get `region: 'local'` rather
than the demo's `eu-north-1`, and the footer shows `desktop` when no region is configured.

## D13 · Tool registry on desktop: own MCP client, pasted tokens, encrypted at rest

- **MCP client.** `lib/mcp.ts` speaks enough of the protocol (Streamable HTTP and stdio;
  `initialize`, `notifications/initialized`, `tools/list` with cursors) to test a connection and
  discover tool names, with no SDK dependency. Discovered names become the tool's `scopes`.
  Running a stdio server runs that command as the operator, with the app's environment.
- **Credentials.** `bearer` and `oauth2` tokens travel as `Authorization: Bearer …`; `apikey`
  as `X-API-Key`. Values are AES-256-GCM encrypted in the `secrets` table under
  `MAGPIPE_SECRET_KEY` (32 random bytes, base64url), which the desktop app generates once per
  install next to `auth-secret`; web dev sets it in `.env.local`. Rows carry a `secretRef` only
  and the API never returns a token.
- **No OAuth flows yet.** `POST /tools/[id]/auth/start|callback` need a registered client and a
  redirect URL per provider, which a desktop install does not have. On desktop a tool that
  "needs auth" takes a pasted access token or API key through _Re-authorise_; the hosted mode
  adds the OAuth routes. `oauth2` stays the recorded auth type so the switch is a no-op later.
- **"Connect & test" is one press.** `POST /api/tools` saves the tool with the status the probe
  found (`connected`, `needs_auth`, `error` with `stats.lastError`), so the registry is honest
  from the first second. `POST /api/tools/test` probes without saving; `POST /api/tools/[id]/test`
  probes a saved tool again.

## D14 · The nest on desktop: trust computed on read, versions kept, no nightly job

- **No cron.** Spec §7.3 has a nightly job mark stale entries and drop expired ones. The desktop
  app has no scheduler, so `stale` (verified more than 30 days ago) and `expired` are computed
  when the nest is read, and Nest health counts them live. The stored `stale` flag stays as a
  hint a job may set later; expired facts are kept and labelled, not dropped — the operator
  forgets them.
- **Writes are versions.** "+ Add fact" under an existing namespace/key does not fail on the
  unique index: it becomes a new version of that fact — the previous value goes to `history`,
  `verifiedAt` is stamped, and a confidence swing above 0.3 flags `conflict` (spec §6).
  Editing a value or confidence does the same; "Mark verified" stamps `verifiedAt` and clears
  stale and conflict. Human writes carry `writtenBy: 'user'`, shown as "you".
- **Namespaces** are created from the nav (`POST /api/memory/namespaces`); the id is the slug
  of the label. Deleting a namespace is not offered while entries reference it.
- **Search.** `GET /api/memory?q=` combines the tsvector index (`websearch_to_tsquery`) with a
  substring match on key and value, so dotted keys and partial words both hit; the screen
  filters the loaded list client-side for instant narrowing.

## D15 · The run engine as built (PR 5)

Carries D5 into code. `lib/engine/` runs inside the Next server; `instrumentation.ts` boots it
once per server start.

- **Model calls** go through `@anthropic-ai/sdk`'s beta Messages API behind a one-method
  `ModelClient` interface (tests script it). Thinking stays adaptive (the default on the 5.5
  family); effort is `high` for planning and steps, `medium` for the merge; `max_tokens` 16k,
  non-streaming. Every request on an Opus/Sonnet/Fable model carries the server-side refusal
  fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`); Haiku has none.
  The SDK's own retries are off: the engine retries twice with backoff for network, rate-limit
  and 5xx errors and logs each attempt as an `error` event; refusals, 400s, limits and
  validation are never retried.
- **Planning** uses structured outputs (`output_config.format`, a JSON schema) instead of a
  forced tool call, which the 5.5 models reject. The orchestrator sees the registry of
  non-paused agents and the relevant memory (all `decisions` plus a text search on the task);
  an invalid plan is retried as a transport error would be. The merge step is always the
  orchestrator's own and carries id `merge`.
- **Steps** get the agent's prompt, the orchestrator's instructions, upstream results and the
  memory it may read; tools are the agent's built-ins (`web.search`/`web.fetch` as Anthropic
  server tools, `files.read` over the run's attachments), scoped memory tools (`memory_search`,
  `memory_get`, `memory_write`; a write outside scope is rejected and logged as an `error`
  event), the `workspace-fs` sandbox and every granted MCP server, connected once per step and
  exposed as `<slug>__<tool>`. `agents.status` flips to `running` for the step's duration and
  `memory.readBy` records what an agent read.
- **Limits.** `maxSteps` caps tool rounds, `maxTokens` the step's total tokens, `timeoutSec`
  the wall clock; a breach fails the step with `limit_steps` / `limit_tokens` / `timeout`.
- **Sandbox (D6 confirmed).** `shell.run` is the allow-list stub: read-only commands
  (`ls`, `cat`, `grep`, `find`, …) run without a shell in `<data>/runs/<id>/sandbox`, paths
  must stay inside it, output is capped, the environment holds only PATH, and the folder is
  wiped when the run ends.
- **Events.** `run_events` rows are the trail; an in-process bus feeds `GET /api/runs/[id]/events`
  (SSE: replay the last 200 or everything after a cursor, then tail, with a two-second poll as
  a safety net and a heartbeat). Event text uses plain nouns ("Run finished"); the demo's
  "Flight landed" is illustrative.
- **Uploads** live under `<data>/uploads/<id>/` with a JSON sidecar (`POST /api/uploads`,
  25 MB each, ten per run) and become `run.input.attachments`.
- **Housekeeping.** The nightly job marks facts stale at start-up and every 24 h; expired facts
  are kept and labelled (D14).
- **Not yet:** streaming tokens into the log (events are per message and tool call), spend caps
  (`settings.spendCapUsd` is recorded, not enforced; enforced since D32), and artifacts produced
  by runs.

## D16 · Home as built (PR 6)

- **One read, one screen.** `getHomeData()` (`lib/home.ts`) loads the agents, the last 50 runs,
  the day's counters (`homeStats`) and the latest run's trail in one request; the page degrades
  to `UnavailableState` when the database cannot be opened.
- **Agent cards say what a bird is doing.** `agentCard()` (`lib/home-util.ts`, pure) derives the
  task line, progress and footer from the runs: while an agent has a `live` step in a running
  run the card shows that step's title, the run's settled share as the progress bar and
  `tokens so far · elapsed`; otherwise its last finished step (`Last: …`, `tokens · N ago`), or
  "Ready for a first task." / `no runs yet` before any run.
- **The flight log drives live refresh.** `FlightLog` is mounted at every width (shown from
  1600 px) and tails the latest run over the SSE route while it is queued or running, merging
  the server replay and the stream by `seq`; each event schedules `router.refresh()` (at most
  every 2.5 s) so the cards and counters re-read the server, and the `end` frame refreshes once
  more. A run started in another window is noticed only on the next load.
- **Uploads happen as files are chosen** (one `POST /api/uploads` per file, chip states
  attaching / size / failed) so Run only sends ids; `⌘/Ctrl + Enter` submits; the textarea is
  uncontrolled so typing before hydration is never reset. A run created lands on
  `/runs/<displayId>` (its holding state until PR 7).
- **The orb** is pure CSS: rings as percentage insets so one markup scales 260 → 400 px, the
  orbit and arc under `motion-safe:`, the grid behind it on a masked pseudo-element so the mask
  never fades the text over it.

## D17 · The Runs screens as built (PR 7)

- **The ledger is the hundred most recent runs**, filtered and searched on the client
  (`matchesRunFilter`, `matchesRunQuery` over task, flight id and agent names); the pill counts
  come from the server's status counts. The stats strip (`runsStats`) counts and prices today's
  runs and judges the last seven days: succeeded = done / (done + failed) over finished runs,
  median duration over finished runs' `durationMs`; a number with nothing behind it shows "—".
- **Selection is transient state** (CLAUDE.md): `?run=<displayId>` is read once at load, the
  address never changes while picking rows. The selected flight's card carries Open log · Re-fly
  (· Cancel while live) and the plan as a chain of step cards (`RunFlightPath`): one markup,
  horizontal with arrows below 1600 px and a vertical timeline from there, via `wide:` classes.
- **Step cards say their state** in colour and in words: done = emerald dot and `tokens · mm:ss`,
  live = cyan edge and fill with `running · elapsed`, failed = red with the error code, todo =
  `waiting`, skipped = `skipped` on a dashed card.
- **The flight page** tails the run with `RunEventLog` (server replay merged with the stream by
  `seq`, following unless the pointer rests on it) and schedules a throttled `router.refresh()`
  per event so the head facts and the path keep up; `useLiveRefresh` does the same for the list
  while any run is live. A failed run's last error is quoted in the Result card.
- **The result is rendered from markdown** with `react-markdown` + `remark-gfm`, mapped onto the
  type scale (no raw HTML is rendered); files produced are listed by name and path (no download
  route yet). The page title is the task cut at 140 characters; the Input card holds it whole.
- **Re-fly and Cancel** call the PR 5 routes: Re-fly lands on the new flight, Cancel refreshes
  and quotes the server's 409 reason when the run already ended.

## D19 · A tool server that is down costs the step its tools, not the step

- **Before:** `setupTools` connected every granted MCP server at the start of a step and a
  server that could not be reached (DNS, refused, a stdio command that is not installed) failed
  the step before the agent had said a word; a required step then failed the run.
- **Now:** the connection or tool listing that fails is logged as an `error` event on the step
  — "<tool> is unreachable (<reason>); the step runs without its tools." — and the step goes on
  with the built-ins, the memory tools and every server that did answer. The trail keeps the
  loss visible (PRODUCT.md: nothing happens unseen); the operator sees the red line in the log
  and the tool's own card still says what is wrong with it.
- **Still fails the step:** a server that answers and then errors on a call (the model sees the
  tool result's error and decides), limits, refusals and the model's own failures.
- **Why not retry:** an unreachable server is usually unreachable for the whole step; the
  engine's retries stay for the model provider. The next run tries the server again.

## D18 · Wide, motion, keys and the smoke flows (PR 8)

- **Wide (≥1600 px) is one set of `wide:` classes per screen**, not a second layout: Home and
  Runs put their columns in a row, Agents and Memory sit their list and detail side by side
  (flex bases lowered so 1600 px already fits), Tools runs four equal columns. Page titles grow
  to 48/52 through the `page-title` utility.
- **Motion is opt-in and tested.** Every decorative animation (the live dots, the orb's orbit,
  arc and ring) is a `motion-safe:` class; `e2e/motion.spec.ts` asserts no running animation
  under `prefers-reduced-motion: reduce` and at least one without it. 150 ms state transitions
  stay — they are feedback, not motion.
- **Keyboard shortcuts** live in one list (`lib/shortcuts.ts`) that feeds the handler
  (`components/KeyboardShortcuts.tsx`), the `?` sheet and the Settings "Keyboard" section:
  `?`, `/` (focus the screen's search), `n` (home with the prompt ready, via `/?focus=prompt`
  read once at load and dropped through the router), `g` then `h a r t m s`. Single keys never
  fire inside text fields or while a dialog is open; dialogs keep their own Escape.
- **A scripted model for tests.** `MAGPIPE_MODEL_STUB=scripted` (development only; ignored in
  production builds) swaps the Anthropic client for `lib/engine/stub-model.ts`, which plans one
  step for the first agent in the registry, answers it and merges a short result. The
  Playwright server runs with it, so the spec's smoke flow — create run → see events → done —
  runs end to end through the real engine, events and screens without credentials.

## D20 · Arc UI as the component framework; the aviary without its eyebrows (PR 9)

- **Arc (uiarc.dev) replaces the hand-built primitives.** Its free, MIT components install
  verbatim with the shadcn CLI into `components/arc/` (`components.json` registers the `@uiarc`
  registry) and are never edited: button, badge, input, textarea, select, checkbox, search field,
  segmented control, dialog, empty state, skeleton, code block (with copy button), alert,
  progress and stepper, plus the motion tokens. `components/ui/` keeps the product's wrappers
  (`Button` defaults to `secondary`; `StatusPill` maps every status to a badge tone;
  `EmptyState` adds the facts line; `SearchInput` hides its label for assistive tech only;
  `FilterControl` is the segmented control with counts). Arc's agent skill lives in
  `.claude/skills/arc/` and its rules are summarised in `CLAUDE.md`.
- **The palette stays, on Arc's tokens.** `app/globals.css` maps Magpipe's colours onto Arc's
  semantic variables under `:root[data-theme="dark"]` (`--background` canvas, `--surface` raised,
  `--accent` sheen cyan, `--success` emerald, `--warning` amber, `--danger` red) and the
  Tailwind palette reads those tokens, so both Arc components and the screens' own markup draw
  in the same colours. A new neutral, `--canvas-muted` (#222222), carries hover and disabled fills
  that the three near-black greys could not separate.
- **Quieter brand.** Arc's rules and the ask for a more minimal look drop the eyebrows, the sheen
  gradient on text, the ambient page glow, the frosted nav, the gradient cards and every box
  glow; weights are 400 and 500 only; copy is sentence case with no em dashes. The brand is now
  the magpie on its disc, white-acts/cyan-tells, the mono fact lines and the bird words in prose.
  `DESIGN.md` is rewritten for this world; spec §4's eyebrow and sheen are superseded. The orb
  keeps one slow dashed orbit as Home's memorable detail.
- **Type.** Geist (self-hosted by next/font like Inter) for the page title at display size, Inter
  for everything else; Arc's sizes with the project's names (`text-display-md` 22/28/500,
  `text-display-sm` 18/26/500, body 16/24).
- **What the swap changed on screen.** Editors are Arc dialogs (Radix: focus trapped, Escape,
  focus returned, `[role="dialog"]` is what the shortcut handler checks). The flight path is Arc's
  stepper (horizontal below 1600 px, vertical from there) instead of the chain of step cards: the
  live step is current, a failed step carries its error, later steps stay upcoming. Filters are a
  segmented control. The stat strip is one bordered group. Busy buttons show Arc's spinner in
  place instead of changing their label.
- **Three overrides, named.** A Tailwind class cannot beat an Arc module rule on the same element
  (Arc's CSS is unlayered, Tailwind's utilities are layered), so a dialog's width and a field's
  mono face are inline styles, the toolbar search's label is hidden through a parent selector,
  and `ButtonLink` dresses a Next link in the button module's own classes so navigation and
  actions share one shape. Nothing else touches Arc's internals.
- **The orbit means live.** The orb's dashed ring turns only while agents are flying (Arc: a loop
  shows live status or does not run), so `e2e/motion.spec.ts` now asserts a still orb on a
  quiet workspace in both motion settings; D18's "at least one animation without reduced
  motion" no longer holds.

## D21 · Home is what is happening now

- **At rest, Home is the nest and the prompt.** The orb, the line that is the screen's h1 ("No
  agents flying right now" / "Magpipe is flying 2 agents"), today's three counters and the
  prompt field, centred at a reading width (half the row from 1600 px). Nothing else: the roster
  is the Agents screen, finished trails are the Runs screen, so spec §3.2's three zones no
  longer show on a quiet workspace.
- **While a flight is live** the screen widens into three columns: the birds that are flying
  (only those; the roster stays on Agents), the nest, and the live trail (`FlightLog`, which also
  drives the refresh of cards and counters). The prompt stays underneath.
- **The trail of a finished flight lives on Runs.** The selected flight's card shows its path and,
  under it, its log, replayed from the events stream (`RunEventLog` with `replay`, which opens the
  SSE endpoint once; the server replays the trail and closes with `end`). The run's own page
  keeps the full-height log.
- **Density.** Cards are 16 px inside with 36 px avatars and body-size names; the stat strip,
  detail panels and Settings sections follow. The prompt is one field with its toolbar beneath,
  not a card around a box.

## D22 · Claude Code as a second model backend

- **Why.** The engine talks to the Messages API with an API key. Running a flight through the
  Claude Code installed on the operator's machine would let the login it already has power
  Magpipe without a key in `magpipe.env`. A subscription is not an API credential, so this is a
  second backend, not a configuration switch.
- **Shape.** A `RunBackend` seam above the model client (`plan`, `step`, `merge`); the API path
  wraps today's functions unchanged, the new path spawns `claude -p` per step in the sandbox
  folder with `--bare`, a restricted tool list by grant, `dontAsk` permissions and a Magpipe MCP
  server (`/api/mcp`, per-step token) that carries the memory tools and the agent's MCP grants.
  Plan and merge are single print-mode calls, the plan with `--json-schema`. Usage and cost come
  from the CLI's result. `MAGPIPE_MODEL_BACKEND=api|claude-code` selects it; Claude Code is the
  default, so a fresh install needs no key, and `api` is the choice for a machine without
  Claude Code or for a hosted build. The full scope, the risks and the build order are in
  `docs/claude-code-backend.md`.
- **Built as scoped, with four deviations found against CLI 2.1.322.** (1) There is no
  `--max-turns` in print mode, so the step limit is enforced from the stream: each assistant
  turn counts, and the process is killed at `maxSteps + 1`; tokens are summed from the turns'
  usage the same way, with the result line as the final authority. (2) Attachments and the
  workspace stay behind Magpipe's own tools over MCP (`files_read`, `fs_*`, `shell_run`), not the
  CLI's `Read`; only `WebSearch` and `WebFetch` map onto CLI tools, and only when granted.
  (3) The CLI gets a clean environment: no `MAGPIPE_*`, no `ANTHROPIC_*` (so a key left in
  `magpipe.env` cannot silently switch the billing), no nested-session markers. (4) A failed
  result arrives as `is_error: true` even with `subtype: success`, so `is_error` is the check.
- **A fifth deviation, found on the first signed-in flight:** `--bare` never reads the keychain
  ("Anthropic auth is strictly ANTHROPIC_API_KEY"), so a subscription login looked signed out.
  The CLI now runs without it and is kept to itself with `--setting-sources ""` (no user,
  project or local settings: no hooks, plugins or model overrides), `--no-session-persistence`
  (no transcript on disk) and `--disable-slash-commands`, plus `--strict-mcp-config` as before.
- **Confirmed against CLI 2.1.322 with a signed-in login:** `--system-prompt` replaces the
  CLI's own prompt entirely in print mode; `--json-schema` output arrives in
  `structured_output` (the result text carries the same JSON); `stream-json` carries every
  assistant message with its content blocks and usage, plus bookkeeping lines the adapter
  ignores; a dead MCP server costs the call its tools, not the call. The tests run against a
  fake `claude` (`tests/stubs/claude.mjs`) that speaks these shapes; `tests/real-claude.test.ts`
  runs the same step through the real CLI when `REAL_CLAUDE=1` and is skipped otherwise, so the
  suite still needs no credentials. Whether a Claude subscription may power this use is a
  question for its terms, not for the code.

## D23 · Home is a conversation

- **Why.** Starting a flight used to leave Home for the run's page, so each question was a
  dead end: read the result, go back, type the next one with nothing linking the two. The
  operator asked to stay on Home, to see the selected flight's result beside the nest, to have
  the next message go to that flight, and to clear landed cards away.
- **Shape.** Home is one client screen (`HomeScreen`) around the server's data. The cards on
  the left choose a flight (`aria-pressed`, cyan edge); the panel on the right shows it: the
  turns before it, its task and files, the merged result, and the trail (`RunEventLog` with
  `replay`, streaming while the flight is up). The prompt says "Follow-up to flight_N" while a
  flight is selected and "New question" drops that; a run started from Home is selected in
  place, the prompt empties, and the router refreshes so the server's copy takes over. The
  spec's "navigates to `/runs/[id]`" (§3.2) no longer holds on Home; "Open log" is the page.
- **Threads are rows, not a table.** A follow-up is a run with `parentRunId` (the field re-fly
  already set). The engine loads the chain (`loadThread`, oldest first, six turns, each clipped
  to 2 000 characters) and hands it to the plan's system prompt and to every step's and the
  merge's user message as "Earlier in this conversation". A re-fly repeats its parent's task,
  so an ancestor whose task equals its child's is folded away and the newer answer stands. The
  panel walks the same chain on the client (`threadFor`) from the cards it has.
- **Closing is a timestamp.** `runs.dismissed_at` hides the card on Home; the Runs screen, the
  run's page and the counters are unchanged. Only a landed flight can be closed (409 while it is
  live), and `PATCH /api/runs/[id] { dismissed: false }` reopens it.

## D24 · The development flock

- **Why.** The starter agents were written for the spec's integration world (Vercel deploys,
  Inngest, tenant billing), and nothing said how Magpipe should staff software work. Research in
  November 2026 (production coding agents, controlled multi-agent studies, Anthropic's own
  guidance and the community methods) points the same way: reads fan out, one agent writes, a
  person approves a written plan and the merge, a fresh reviewer checks the diff against the plan
  and skips style, and only something that runs counts as evidence.
- **Shape.** `docs/flock.md` is the proposal: five agents (Researcher, Planner, Coder, Reviewer,
  Verifier; Operator retired), each defined by the artefact it may write, with prompts, models,
  grants, memory scopes and limits; two new namespaces (`plans`, `reviews`); six `decisions`
  entries as standing rules, since every `decisions` entry reaches every plan; and three run
  shapes with the operator between the plan and the build and again before anything is pushed.
- **Release 1 needs no code.** Repositories are reached through stdio MCP servers (Filesystem,
  Git) plus GitHub over http and library docs, granted per agent with explicit scopes. The
  Verifier waits for a bound repository with a typed script runner.
- **Not yet.** The starter seed is unchanged. The engine gaps are ordered in `docs/flock.md`:
  tool names and scopes in the planner's registry (and an empty grant meaning none), a bound
  repository with `repo:read|write|run`, a single-writer rule in plan validation, then step data
  and artefacts, a waiting plan gate and a bounded fix-up loop.

## D25 · An empty grant allows no tools

- **Why.** The engine read a grant with no scopes as "every tool the server exposes, including
  tools it adds later". Unticking every box in the agent editor therefore granted everything,
  while the editor showed nothing ticked. It was the first gap `docs/flock.md` named.
- **Rule.** A grant names the tools it allows; an empty grant allows none (`grantAllows` in
  `lib/tools-util.ts`). The engine skips such a grant and never starts its server, and the
  planner's registry no longer lists it as a tool the agent has.
- **Grants made before a server answers.** A server whose probe failed has no known tools, so a
  grant to it can only be empty. The first probe that finds its tools (Test again, or a changed
  command, url or token) fills every such grant with all of them, as granting a server with known
  tools already does (`fillPendingGrants` in `lib/tools.ts`). Once the tools are known, an empty
  grant is the operator's choice and stays empty.
- **Said where it is made.** Under a granted server the editor says "Nothing ticked, so this
  agent gets no tools from this server" or that its tools are not known yet, and the agent detail
  shows "no tools" or "tools not known yet" beside the server.
- **No data migration.** Existing empty grants now allow nothing, which matches what the editor
  already showed. An agent that relied on an empty grant to reach a server must have its tools
  ticked, or the server tested again if it never answered.

## D26 · The planner reads tools by name

- **Why.** The orchestrator's registry listed an agent's grants as raw `tool_…` ids, so it could
  not tell which agent reads files, which one commits, or which server is down. Routing leaned on
  the description prose alone. It was the other half of the first gap in `docs/flock.md`.
- **Shape.** Each agent's entry now has its own lines for the model, the built-in tools, the
  servers and the memory scope. A server reads as its name and the tools granted on it, for
  example `Repository files (read_text_file, write_file)`, with `needs auth` or `not reachable`
  when it will not answer (`registryText` and `grantText` in `lib/engine/plan.ts`). Empty grants
  (D25) and grants to tools that no longer exist are left out. The orchestrator's rules gain one
  line: give a step to an agent whose tools can do it, and a server marked not reachable or needs
  auth will not answer.
- **Bounded and plain.** At most 20 tool names per grant are listed and the rest are counted.
  Tool names come from the server, so only plain identifiers (letters, digits and `_ . : / -`)
  reach the prompt; anything else is counted, never quoted. Server names are the operator's and
  are reduced to one line.
- **The scripted model** picks the first agent whose entry says `servers: none`, so end-to-end
  runs still avoid the demo's servers.

## D27 · A bound repository, with a runner

- **Why.** Agents could not run anything: the sandbox is an empty folder with 13 read-only
  commands, so no agent could see a test fail or pass, and the flock's Verifier had nothing to
  run. It was the second gap in `docs/flock.md`. D6 deferred running commands to "a per-run temp
  dir under the data folder, behind an explicit setting"; this is the explicit setting, applied
  to the operator's own repository instead of a copy.
- **Shape.** A third kind of tool, `repository` (kind and transport), connected from the Tools
  screen with `{ name, transport: "repository", path, scripts, timeoutSec? }`. The probe checks
  that the path is an absolute folder inside a git work tree and that every allowed script exists
  in its `package.json`; the card shows the folder, the scripts and the run limit. The tools
  table gains a nullable `repository` column (migration 0003).
- **Nine operations, no shell** (`lib/repo.ts`, exposed per step by `repositoryOps` in
  `lib/engine/tools.ts` as `<slug>__<operation>`): `read` (line-numbered, or a folder listing),
  `search` (`git grep` over tracked and new files), `write`, `run` (a named script through the
  folder's package manager, its own timeout, the process group killed on timeout or cancel, the
  last 20 000 characters kept), `git_status`, `git_diff` (against a base, or uncommitted work with
  new files listed), `git_log`, `git_branch` and `git_commit`. A grant ticks operations like any
  tool's names (D25), and the planner reads them by name (D26).
- **Guards in code, not prompts.** Paths stay inside the folder, symlinks included; `.git` is
  refused; env files are refused for reading (`.env.example` excepted) and every `.env*` name for
  writing and committing. `git_branch` refuses to switch while tracked files have uncommitted
  changes. `git_commit` names its files and commits only those (`--only`), so the operator's own
  untracked or staged work stays out, and it refuses `main`, `master` and the remote's default
  branch. There is no push. Commands get the operator's login `PATH` and environment minus
  Magpipe's secrets, with `CI=1`.
- **Two smaller changes.** A probe that finds fewer tools than before drops the vanished names
  from grants, so an agent whose repository lost `run` can still be saved in the editor. The
  Claude Code step sets `MCP_TOOL_TIMEOUT` to the agent's own time limit, so a long test run is
  not cut off by the CLI before the step's clock.
- **Not yet.** Agents work in the operator's checkout, not a worktree, which is why branch
  switches stop at uncommitted changes and why only one step at a time may change it (D28). Only package scripts run; a repository without a `package.json`
  offers every operation except `run`.

## D28 · One writer per work tree

- **Why.** The engine started every ready step of a run at once, without a cap, and two runs
  could run side by side, so two agents could edit, switch branches and commit in the same
  checkout at the same moment. With one working copy that is never safe, even on different
  branches: a branch switch moves the files under the other writer. `dev.single-writer` was only
  a prompt. It was the third gap in `docs/flock.md`.
- **Who is a writer** is worked out from grants, not declared: a step whose agent holds `write`,
  `git_branch`, `git_commit`, or `run` on a repository that allows a script (`MUTATING_OPS` and
  `writeTargets` in `lib/engine/locks.ts`). Scripts count because builds, formatters and
  snapshots write files. Reading, searching, diffs and logs never lock. Two repository tools on
  the same git work tree (the app and its plans folder) share one lock, keyed by the work tree's
  real path.
- **How.** A writer step takes its work trees' locks before it goes live and holds them until it
  ends, whatever happens; every run in the engine shares them. Locks are queued first come first
  served, several are taken in sorted order so two steps cannot deadlock, and a cancelled run
  stops waiting and gives back what it took. While it waits, the step stays `todo`, its agent
  shows as `waiting` (the status existed but was never set), and the trail says
  `Waiting to change App: run flight_… is changing it.` The wait does not count against the
  step's time limit.
- **Within a run** a wave never holds two steps that change the same work tree; the second waits
  for the next wave instead of waiting live. A wave is at most three steps
  (`MAX_PARALLEL_STEPS`), as the Claude Code backend's scope planned.
- **In memory, on purpose.** Only one process opens the data folder (D1), so the engine is the
  only writer and a restart drops every lock with the steps that held them; resumed steps take
  them again. The map lives on `globalThis`, like the engine, so a dev reload keeps it.
- **Not covered:** writes an MCP server makes on its own (a Filesystem server pointed at the same
  folder) are invisible to the engine; bind the folder as a repository instead.

## D29 · Steps record what they did

- **Why.** A step returned a summary of at most 1,000 characters and nothing else: `result.data`
  was never set and a run's `output.artifacts` was always empty. A Reviewer learned the Coder's
  branch only if the Coder's prose named it, a run that failed at review lost track of the branch
  it left behind, and the run page could not show what changed. It was the fourth gap in
  `docs/flock.md`.
- **Recorded from the tools, not the model.** Each repository operation reports what it did
  alongside its text (`RepoWork` in `lib/repo.ts`): `write` the file and whether it was created,
  `git_branch` the branch, `git_commit` its short hash and subject, `run` the script, exit code,
  seconds and whether it timed out. The engine collects these per step (`ToolSetup.work`), with
  file paths made relative to the git work tree, so a plans folder bound on its own still says
  `docs/plans/…`.
- **Stored on the step, done or failed.** `step.work` (`stepWork` in `lib/schemas`) holds the
  files (each once, "created" if any write created it), branches, commits and checks, capped so
  a runaway step cannot grow the plan. The engine keeps the collector outside the step, so a step
  that fails partway still records the commits it made. `result.data`, never set, is gone.
- **Handed on as facts.** A step's user message and the merge list each earlier result followed
  by "Recorded by Magpipe:" lines (`workFacts` in `lib/work.ts`): the branch, the files, each
  commit and the latest run of each script. The merge's final answer can rely on those.
- **Shown.** The flight path adds one line per step, for example `3 files · 2 commits on
magpipe/x · test passed`. A run's artefacts gain `kind`, `repo` and `detail` beside the old
  `blobUrl`: each branch committed to, with its commit count and last commit, then each file.
  The run page and Home's panel build the list from the steps (`shownArtifacts`), so it updates
  while the run goes and survives a run that failed before its merge; the merge also stores it
  in `output.artifacts`. The demo's failed webhook run carries a record.
- **Not covered:** what an agent decides rather than does (a Reviewer's verdict and tiered
  findings) is still prose plus the `reviews` memory entry; and work done through MCP servers
  is not recorded, only through bound repositories.

## D34 · A repository's conventions reach the step; the orchestrator's rules are on Settings

- **Why.** Steps run Claude Code with `--setting-sources ''` (D22) and the API path has no
  settings at all, so no step loads a `CLAUDE.md`. A repository's conventions (its check
  commands, its layout, its rules) reached an agent only if its prompt said to read them and it
  spent a turn doing so: the flock's Planner and Coder prompts did, the Reviewer and Verifier did
  not. And the two things that steer every plan, the orchestrator's fixed rules and the
  `decisions` entries, could not be seen together anywhere in the product. It was the ninth gap
  in `docs/flock.md`.
- **Shape.** `setupTools` reads the conventions of each bound repository the step gets at least
  one operation from (`readConventions` in `lib/repo.ts`) and returns them beside the tools
  (`ToolRuntime.conventions`). `runStep` appends them to the system prompt after the agent's
  memory, one heading per file, for example "Conventions of App and App plans (their
  CLAUDE.md):" (`conventionsText` in `lib/engine/step.ts`). Both backends send that same system
  prompt, so the API and Claude Code paths get the same text. The plan and the merge get none:
  they route and summarise, they do not touch code.
- **Which file.** `CLAUDE.md` in the bound folder, then at the git work tree's root, then
  `AGENTS.md` the same way; the first with text in it wins. Two bindings of one work tree (the
  app and its plans folder) find the same file, which appears once under both names.
- **Guards.** Reaching a repository means being offered one of its operations: an empty grant
  (D25), or `run` on a binding without scripts, gives the step nothing and so no conventions.
  The read follows `read`'s path rules, so a `CLAUDE.md` symlinked out of the folder is skipped,
  and takes at most 32 KB. Each file is cut at 8,000 characters, at a line end where one is near,
  and the prompt says where it was cut. A missing, empty, binary or unreadable file is skipped
  without a word, as a step goes on without a repository whose folder is gone.
- **The orchestrator on Settings.** A read-only section shows `ORCHESTRATOR_SYSTEM` (in the
  `TextBlock` the agent detail uses for a system prompt, which wraps and copies) beside the
  standing instructions: every `decisions` entry with its key and value, long values cut, each
  key opening the entry in Memory, the line "Every entry here reaches every plan the
  orchestrator makes." and "Edit in Memory" (`/memory?ns=decisions`). With none it says so and
  offers "Add a decision". Memory says the same line above the Decisions namespace, with a link
  back. `relevantMemory` hands a plan at most 30 memories, decisions first and newest first, so
  past 30 both screens say that only the 30 most recently updated reach it (`PLAN_MEMORY_CAP` in
  `lib/memory-util.ts`; a test pins it to the engine). When the database cannot be opened the
  rules still show and the list says it cannot be read, as the other Settings sections degrade.
- **Not covered:** the rules stay read-only, because `decisions` already carries the operator's
  rules and an editable prompt would change every plan with no record of why. `@` imports in a
  `CLAUDE.md` are not followed (a file that only says `@AGENTS.md` hands on that line), and
  `CLAUDE.md` files in folders below the binding are not read. An agent with `write` on a
  repository can change the file that later steps read; the change is recorded (D29) and shows
  in the diff, but nothing prevents it. The number of repositories whose files join one prompt
  has no cap beyond the 8,000 characters each.

## D30 · A run can wait for the operator

- **Why.** The orchestrator planned once and could not pause, so the gate every method keeps,
  a person reading the plan before code is written, fell between two runs: a scouting run, then
  a building run as a follow-up. It was the fifth gap in `docs/flock.md`.
- **The setting is the agent's.** `agents.pause_after` ("Wait for approval after its steps" in
  the editor's Approval section, migration 0004). After a step by such an agent finishes, the
  steps that depend on it are held until the operator approves; the planner's registry says so
  ("waits for approval: the run pauses after its steps") and its rules ask it to plan the work
  that builds on the result in the same plan. A step that only the merge depends on never
  holds the run: approving a summary would be ceremony.
- **The run waits, the engine does not.** When nothing else can start and a step is holding
  dependants, the run's status becomes `waiting` (a new run status, amber because it needs you)
  and the engine lets it go: no process, lock or memory is held. The trail says
  `Waiting for you: approve “Write the plan” to go on.`
- **Approve or cancel.** `POST /api/runs/[id]/approve { note? }` marks the held steps approved
  (`approvedAt`, `approvalNote` on the step), puts the run back in the queue and logs
  `Approved by the operator: …`; the steps that start next read "The operator approved this
  with a note: …" under that step's result. Cancel now reaches a waiting run too, and skips
  what was held. The run page and Home's panel show the same box: what it waits on, a note
  field, "Approve and go on" (the run page's primary action; secondary on Home, where Run is)
  and "Cancel run". A waiting run's card cannot be closed.
- **Not covered:** the sandbox folder is wiped when the run pauses, as at any run end (the
  repository is the durable workspace); time spent waiting counts in the run's duration; and an
  approval cannot edit the plan's later steps, only add a note to them.

## D31 · A reviewer may send the work back

- **Why.** A review with blocking findings ended the run, and fixing them took a follow-up run
  started by hand, even for a finding the Coder could address in a minute. The evidence favours
  the evaluator-optimizer loop when it is bounded and tied to evidence, and the human cycle as
  the default. It was the sixth gap in `docs/flock.md`.
- **The setting is the agent's, and off by default.** `agents.send_back_rounds` ("Times it may
  send work back" in the editor's Approval and review section, 0 to 5, migration 0005). The
  planner's registry says "may send work back: up to N times, to the steps it depends on", and
  its rules ask it to make such an agent depend directly on the steps whose work it judges.
- **A tool, not a parsed verdict.** While rounds remain, the agent's steps get `send_back
{ findings }`. Calling it records the findings on the step (`sentBack`); the step then finishes
  as usual with its verdict as the summary.
- **What reopens.** After the wave, a done step with findings reopens the steps it depends on,
  every step on a path from them to it (the Verifier between the Coder and the Reviewer), and
  itself (`sendBackSet` in `lib/runs-util.ts`). Earlier work, such as the Planner's and its
  approval, keeps its result, and the merge never reopens. Reopened steps go back to `todo`
  with `round` + 1 and a `feedback` line in their prompt: the findings for the reviewed steps,
  "your findings last round" for the reviewer. Their usage so far is added to the run's before
  it is cleared, and their work record carries over (the step's collector starts from its saved
  record, D33), so tokens, cost, commits and
  files across rounds all stay counted. The trail says
  `Round 2: Reviewer sent the work back to “Make the change”.`, and the flight path shows the
  round.
- **Bounded.** A step on round N may send back while N is at most the agent's setting; after
  that the tool is not offered and the verdict stands for the operator, as before.
- **Not covered:** a send-back cannot change the plan (no new steps), and reopening the Planner
  needs a reviewer that depends on it directly.

## D32 · A daily spend cap, enforced

- **Why.** `settings.spendCapUsd` (50 on a fresh install, shown on Settings as "Spend cap per
  day") was recorded and never enforced (D15), and nothing could change it, so an unattended run
  had no budget beyond each agent's per-step limits. It was the seventh gap in `docs/flock.md`.
- **What counts.** Today's spend is the cost of every run asked for today in the server's local
  day, the same day Home and the Runs screen count: a finished run's `usage`, and for a run still
  going, its plan's cost plus its steps' usage so far (a run's `usage` takes in its steps only
  when it ends). One aggregate query over the indexed `created_at` range reads the spend and the
  cap together (`spendToday` in `lib/spend.ts`), so a cap changed mid-run counts at the next
  check. Under Claude Code the dollars are what the API would have charged (D22), not a bill, and
  Settings says so in one line.
- **Where it stops.** Before planning, before each step goes live (after any wait for a work
  tree, D28) and before the merge. Once the spend has reached the cap no new step starts, steps
  already working finish, and the run fails with code `spend_cap`: "Today's spend ($50.12)
  reached the $50.00 cap, so the run stopped before “Draft the change”. Raise the cap in Settings
  to go on." Steps that never started are skipped; the work recorded so far stays on the run
  (D29).
- **0 means no cap.** A cap of 0 turns the check off rather than stopping every run, which a
  zero budget would otherwise mean; Settings shows it as "no cap".
- **The first editable setting.** Settings gains a Spend cap section: today's spend, the cap, one
  field and a Save button, saved through `PATCH /api/settings` (`GET` beside it, spec §8) with
  `requireUser`, `parseBody` and `apiError`. `settingsPatch` takes a non-negative number of
  dollars up to $10,000, rounded to the cent; the form checks the same schema before it sends,
  the error stays beside the field, and the button confirms in place. The page re-reads its data
  with `router.refresh()`; nothing revalidates the layout.
- **Not covered:** the cap is checked between steps, not inside one, so steps already working
  can go past it by their own limits (at most three at once, D28). A run stopped at the cap does
  not resume when the cap is raised; run it again. A run that crosses midnight counts towards the
  day it was asked for. There is no per-run or per-agent budget and no warning before the cap.

## D33 · A step resumes from where it was

- **Why.** After a restart, `resumeInterrupted` sent `live` steps back to `todo` and they ran
  again from their brief alone, and a step's work record (D29) reached the plan only when the
  step ended, so a crash lost it. A Coder halfway through a change started over and could repeat
  its commits; only its prompt said to continue from what was committed. It was the eighth gap in
  `docs/flock.md`.
- **The record is saved as it grows.** Each item a repository tool records is folded and saved
  onto the step in `runs.plan` at once (`ToolSetup.onWork`): one save per recorded item, none for
  other tool calls. A restart finds the branch, files, commits and checks the step had made.
- **A resumed step is told.** `resumeInterrupted` counts the restart on the step
  (`step.restarts`, optional in the step schema; `runs.plan` is jsonb typed from zod, so no
  migration) and keeps its record. The step's user message gains, after its instructions: "This
  step was interrupted by a restart after it had started. Before that, Magpipe recorded:", the
  `workFacts` lines, and "Continue from there: check git_status and the branch, and do not redo
  work that is already committed." With nothing recorded it says so and asks the agent to check
  what is in place (`resumeNote` in `lib/work.ts`).
- **One record across attempts.** The resumed attempt's collector starts from the recorded work
  (`workItems`, the inverse of `foldWork`), so the final record, the facts later steps get and
  the run's artefacts cover both attempts. A step put back to `todo` with its `work` kept always
  collects on top of it.
- **Not covered:** the step's conversation is not replayed; it starts again from its brief plus
  the note. What it did outside bound repositories (MCP servers, memory writes) is not on the
  record, nor is an operation the restart cut off before it reported. The run page does not show
  the restart count yet. A live merge simply runs again.

## D35 · Load the development flock

- **Why.** A fresh install has the four starter agents, and the flock in `docs/flock.md` took
  five manual steps across three screens: two repository bindings, two namespaces, six
  `decisions` entries, five agents with their prompts, scopes and limits, and a grant per agent
  and repository. It was the tenth gap in `docs/flock.md`.
- **Shape.** `lib/flock.ts` holds the flock as data (`FLOCK_AGENTS`, `FLOCK_DECISIONS`,
  `FLOCK_NAMESPACES`) and `loadFlock(db, { path, scripts })`. Settings gains a "Development
  flock" section beside the demo data: the repository folder, the scripts agents may run
  (typecheck, lint and test by default), a confirm step that says what will change, and the
  result as plain lines (`summarizeFlock`). The server action (`loadFlockAction`) never throws;
  a folder or script the flock cannot use comes back on its field. The Agents screen's empty
  roster links to the section.
- **What a load does.** Creates `docs/plans` in the folder if it is missing; binds the folder
  twice through `connectTool` (`<folder>` with the scripts, `<folder> plans` at `docs/plans`
  with none), or reuses tools already bound to those paths, a reused folder taking the scripts
  asked for; creates every namespace the agents name that is missing (`plans` and `reviews` on a
  fresh install); writes the six entries with confidence 1 and source "operator"; upserts the
  five agents by slug (Researcher, Coder and Reviewer keep their ids, Planner and Verifier are
  created); sets each agent's grants on the two repositories to the operations in flock.md's
  table; and pauses Operator rather than deleting it.
- **Guards.** Everything that can be refused is checked before anything is written: an absolute
  folder inside a git work tree (`inspectRepository`), at least one script (the Verifier runs
  the checks), each a script name its package.json has, and no file where `docs/plans` should
  be. Grants name their operations; an agent with none on a repository gets no grant to it, never
  an empty one (D25). Grants to other tools are kept, so a GitHub server the operator already
  granted survives a load. Loading again changes only what differs: an edited entry becomes a
  new, verified version (no conflict flag), an agent is updated only when a field differs, and no
  folder is bound twice.
- **Drift.** `tests/flock.test.ts` parses `docs/flock.md` and fails when a prompt, role,
  description, model, built-in list, memory scope, limit, grant or standing instruction in
  `lib/flock.ts` differs from it. Change both together.
- **Not covered:** GitHub (read) and Library docs need a token or npx, so the result says to
  connect them from Tools and tick their tools. `docs/plans` is created empty, without the README
  flock.md suggests, so git shows nothing until the first plan file. There is no general agent
  import or export. A load is not one transaction: a failure part way keeps what was written, and
  loading again finishes it.
- **With the run gates.** Merged after D30 and D31, the loader also sets the Planner to wait for
  approval and lets the Reviewer send work back once, so a loaded flock runs a whole change in
  one run. `lib/flock.ts` takes its prompts and entries from `docs/flock.md` as they stand after
  D30, D31 and D34, and the drift tests hold the two together.

## D36 · A software factory on top of the flock

- **Why.** The flock turns a task into a reviewed branch with the operator starting each run.
  The next step is a pipeline that starts from an idea and ends at a merge with the operator
  deciding twice: nine agents (Spec Builder, Spec Review, Goal Builder, Goal Review, Test
  Agent, Code Agent, Code Review, Code Skeptic, Merge Agent) and Linear as the record.
- **Decided.** The spec is approved by a person, in Linear or from Magpipe, where the button
  sets Linear's status so there is one answer. The factory starts with pull requests and a
  question to merge; merging without a person is a later, separate decision. Goals build in
  parallel in a git worktree each.
- **Shaped by the evidence in `flock.md`.** Judges give evidence, not opinions: the two
  reviews of prose check fixed lists; the Test Agent writes the tests before the code and
  proves afterwards they were not weakened; the Code Skeptic blocks only with a failing test.
  Every loop is bounded and ends in a "needs you" status with the findings attached.
- **Linear holds the state, runs stay short.** Each stage is a run from a fixed template,
  started by a watcher when an issue's status says so, instead of one long run per idea. The
  engine already skips planning for a run that has a plan and already locks per work tree, so
  templates and parallel worktrees fit what is there.
- **Settled with the operator.** Linear access (key, team, label, status mapping) and the
  polling interval are set in the app's Settings. The app must be open for the factory to run.
  A Claude subscription may power it as Magpipe uses it: Anthropic's legal page permits an end
  user signing in to the unmodified `claude` binary with their own subscription, which is what
  D22 does. Its usage limits assume ordinary individual use, so heavy unattended work belongs on
  the API backend, and the billing rules are re-read before phase 4.
- **Not yet.** Nothing is built. `docs/factory.md` has the pipeline, the agents, the gates, the
  engine needs and an eight-phase build order.

## D37 · Factory phase 1: templates, documents and the roster

- **Why.** The factory runs the same stages every time, so its runs must not depend on the
  orchestrator improvising a plan, and a spec is too long for a step's 1000-character result.
- **A template is a preset plan.** `createRun` takes a plan; the engine already plans only when
  a run has none, so a template run goes straight to its steps. The run's input records the
  template, so a re-fly starts from it again, and the trail opens with where the plan came from.
  `lib/factory.ts` holds the templates; phase 1 has `spec` (Spec Builder writes, Spec Review
  checks and may send it back once).
- **A step may write a document.** A template step marked `writesDocument` keeps its whole
  result (up to 40 000 characters) in `document`, with the summary as its opening. Later steps
  read the document in full; a step sent back keeps its draft and revises it; a follow-up sent
  to the factory seeds the draft from the run it continues. A run whose plan kept a document
  answers with it, then what the steps after it reported, without a merge call to the model, so
  the spec reaches the operator as written.
- **Template-only agents.** Agents gain `templateOnly` (a column, migration 0006, and a switch in
  the editor). The orchestrator leaves them out of its registry, so a plain Run never reaches the
  Code Agent. All nine factory agents set it.
- **The roster loader is shared.** The flock's loader pieces (check the folder and scripts, bind
  a repository, namespaces, decisions, upsert agents by slug) moved to `lib/roster.ts`. Settings
  → Software factory loads the nine agents onto one repository tool, reusing the flock's binding
  of the same folder and leaving the flock alone. `tests/factory.test.ts` pins `lib/factory.ts`
  to `docs/factory.md`.
- **Home.** "Send to the factory" sits beside Run once the spec template's agents are loaded;
  POST /api/runs refuses a template whose agents are missing or paused with a message that says
  where to fix it (409 `factory_not_loaded`). Long texts in the flight log open on request, so a
  spec does not flood it.
- **Not yet.** No Linear, no watcher, no goals or building (phases 2 to 7 in `factory.md`). The
  other seven agents are loaded with their prompts and grants and wait for their templates.

## D38 · Factory phase 2: Linear, the watcher and gate G1

- **Why.** The factory keeps its record in Linear (D36): a spec that passes review becomes an
  issue there, and the operator approves it there or from Magpipe.
- **Settings → Linear.** A personal API key, checked with Linear before it is stored, sealed in
  `secrets` like a tool token (D13) and never shown again, only its last four characters and
  who it belongs to. The team, the label (made in Linear when missing) and the six pipeline
  states, each on its own status, are read back from Linear when saved; the first guess comes
  from the team's status names and types. The watcher's interval (15 to 1800 seconds, default
  60), a pause switch, the last good check and the last error, and Check now. One row,
  `linear_settings`, migration 0007.
- **The tracker seam.** `lib/tracker`: an interface of eight operations, Linear's GraphQL API
  behind it, and a scripted tracker for tests and the e2e server (`MAGPIPE_TRACKER_STUB`,
  ignored in production). The API directly rather than Linear's MCP server, because the watcher
  needs one query by team, label and time. The client was written against Linear's published
  schema and tested against a fake fetch; this environment cannot reach `api.linear.app`, so its
  first live call is on the operator's machine.
- **Action steps and verdicts.** A step may be Magpipe's own work (`action`, no agent, no model,
  no spend). A judging step (`judges`) has its verdict read from its `Verdict:` line, and the
  reviewers' prompts now ask for that line exactly. The spec template gains `file_issue` after
  the review, in the plan only while Linear is set up and optional, so Linear out of reach
  costs the issue, never the spec: the run's answer says it was not filed. A pass files the
  spec in spec ready with the label and posts each review as a comment; a fail, or no readable
  verdict, files nothing. A follow-up that revises a spec still waiting rewrites that issue.
- **Issues and gate G1.** `tracker_issues` keeps each labelled issue as the watcher last saw it.
  The watcher runs while the app is open, reads the labelled issues updated since the last good
  check (all of them after the mapping changes), and acts on each stage change once: a move to
  the approved status records the approval and says so on the spec's run. Approve in Magpipe
  (the issue bar on the run's panel and page) sets the status in Linear first, so Linear holds
  the one answer. Nothing starts on approval yet: that is the goal template, phase 3.
- **Not yet.** Linear out of reach during filing is retried twice, then left to a re-fly rather
  than waited on; the design's "the run waits and retries" comes with the watcher acting on
  approvals in phase 3.

## D39 · Factory phase 3: goals

- **Why.** An approved spec is split into goals that can each be built and tested on their own,
  filed in Linear as sub-issues with their order, ready for the build template (phase 4).
- **Approval starts it, once.** When a spec issue reaches the approved status, by Approve in
  Magpipe or by a move in Linear the watcher sees, the goals run starts as a follow-up of the
  spec run. The issue records the run (`goalsRunId`), and starts are serialised, so the two
  doors cannot start two runs. Each check also starts approved specs that never had one, so an
  approval made while the factory was not loaded is picked up once it is. A start that cannot
  happen (an agent paused, Linear not set up) is the check's error in Settings.
- **The spec as the operator left it.** The run's first step is an action that reads the issue's
  description from Linear: an edit made before approving is the spec that gets split.
- **Goals as data, checked by Magpipe.** The Goal Builder records goals through a `record_goals`
  tool (key, title, summary, criteria by number, files, dependencies). Magpipe checks them
  before accepting: each numbered acceptance criterion in exactly one goal, dependencies that
  exist and form no cycle, and goals that share a file ordered. Problems go back as the tool's
  answer until a set passes; a builder that records none fails its step. The accepted goals are
  rendered as the step's document, which the Goal Review reads; its checklist now covers what a
  check cannot (substance, plausible files, testable alone, one pull request each).
- **Filing.** A passing review files each goal as a sub-issue of the spec, in the approved
  status, with its criteria in the spec's words and a "blocks" relation from each goal it
  depends on, and moves the spec to building. A failing one files nothing, moves the spec to
  needs you with the findings as a comment, and releases it, so moving it back to approved
  splits it again. A filing resumed after a restart files only the goals not yet filed.
- **The issue bar** shows a goals run's spec issue and its goals, and links a spec run to the
  goals run its approval started. The goals template cannot be sent from Home.

## D40 · Factory phase 4: building one goal

- **Why.** Filed goals must be built: tests first, then code, then three judges, ending in a
  branch ready to merge or a goal that needs the operator.
- **Whose turn.** After each Linear check the factory's tick (`factoryTick`, replacing D39's
  approval hook) starts the build for the oldest approved goal whose dependencies are all done,
  and only while no build run is active: one goal at a time on the bound repository as it is.
  Starts are serialised and recorded on the issue (`buildRunId`, migration 0009), so a goal
  builds once until it is released. The tick also starts goals runs for approved specs,
  reconciles build runs that ended without reporting (cancelled, or stopped before their last
  step: the goal moves to needs you), and closes a spec whose goals are all done.
- **The build template.** Read the goal from Linear; the Test Agent writes the tests and commits
  them alone; the Code Agent builds against them; the Test Agent runs the scripts and checks the
  tests were not changed; Code Review reads the diff; the Code Skeptic tries to break it with one
  test. All work on `magpipe/<goal key>`, filled into the instructions (`{branch}`). The three
  judges end with an exact verdict line, now asked for in their prompts.
- **Engine rules, general but first needed here.** A step may name where it sends work back
  (`sendBackTo`): the build judges reopen the build and what lies between it and them, never
  the tests, which the old rule would have reopened through the shared read step. In a template
  only a judging step is offered `send_back`. A judge that says fail with nothing sent back
  skips the agent steps after it; actions still run, since they report. A step marked `always`
  runs once everything before it settled, failures included.
- **The finish.** Every judge passed: the goal moves to the merge question with a comment naming
  its branch, the verdicts and what Magpipe recorded. Anything else: needs you, with the same
  report and the reason, and the goal is released so moving it back to approved builds it
  again. Until phase 6 the operator merges the branch and moves the goal to done, which lets
  the goals that wait for it start.

## D41 · Factory phase 5: worktrees and parallel goals

- **Why.** One checkout allows one writer (D28), and goals that do not depend on each other
  should build at the same time.
- **A worktree per goal.** Starting a goal's build makes (or reuses) a git worktree for its
  branch under `<data folder>/worktrees/<repository>-<hash>/`, from the remote's default branch,
  else `main` or `master`, else whatever the bound folder has checked out; the operator's own
  checkout is never switched. `node_modules` is linked from the bound folder, so scripts run
  without an install, and kept out of git through the repository's shared exclude file. A done
  goal's worktree is removed after the next check; one with uncommitted changes is kept, and
  branches are never deleted. This is Magpipe's own git work (`lib/worktrees.ts`), not a new
  agent operation.
- **Tools follow the run.** A build run records its worktree on its input (the repository tool it
  stands in for, the folder and the branch). The engine points that tool's folder at the
  worktree for the run's steps, so the typed operations of D27 and their guards act there, and
  the write lock of D28 is keyed by the worktree: goals in different worktrees never wait on
  each other, and the repository the factory builds in is the one the Code Agent holds.
- **The run limit is a setting.** `settings.maxRuns` (1 to 8, default 2; migration 0010),
  edited beside the spend cap, which stays the governor. The engine takes a new limit at once
  and reads it at start. The factory starts as many ready goals as the limit leaves room for
  beside the builds already running, oldest first, dependencies done.

## D42 · Factory phase 6: pull requests and the merge question

- **Why.** A goal that passes its checks must reach the default branch, with the operator
  deciding once (gate G2) and the branch tested again against what landed meanwhile.
- **The GitHub seam.** `lib/forge`, shaped like the tracker (D38): an interface of five
  operations, GitHub's REST API behind it, and a scripted forge for tests and the e2e server
  (`MAGPIPE_FORGE_STUB`, ignored in production). Settings → GitHub holds a token (checked with
  GitHub, sealed, never shown again) and the repository with how pull requests merge, read back
  when saved and suggested from the factory repository's origin. One row, `forge_settings`,
  migration 0011. Like the Linear client, the GitHub client was tested against a fake fetch;
  this environment cannot reach `api.github.com`.
- **Magpipe pushes, not an agent.** The design gave a `git_push` operation to the Merge Agent.
  Pushing is mechanical, so it is Magpipe's own git work (`lib/worktrees.ts`) in action steps,
  with the guards the design set: only the run's own `magpipe/…` branch, the one its worktree
  has checked out, to origin, never the default branch, never forced. Agents still cannot push.
- **The build ends in a pull request.** With GitHub set up, the build template gains `open_pr`
  after the judges: when all passed, the branch is pushed and its pull request opened, and the
  finish asks the question to merge on the goal's issue with the link. Without GitHub, the step
  is left out of the plan (and out of its dependants) and the goal stops at a branch to merge
  by hand, as in D40.
- **Three doors to G2.** Merge in Magpipe (the issue bar on the goal's flights); moving the goal
  from the question to done in Linear; merging the pull request on GitHub, which the next check
  notices (one closed there without merging needs the operator). The first two start a land run;
  the third is already merged. Send back in Magpipe posts the operator's note on the issue, moves
  the goal back to approved and gives the note to the Code Agent in the rebuild.
- **The land template.** Read the goal; bring the branch up to date by merging the default branch
  into it, then push (a merge, not the design's rebase, because a rebased branch could only be
  pushed by force, which the design also forbids; a conflict stops the land); the Test Agent runs
  the tests again; the Merge Agent, now a judge with a reading role, checks the branch can land;
  and a step that runs however they ended merges the pull request and moves the goal to done,
  or moves it to needs you with the reason, the pull request left open. Judges in a land have
  nothing to send back (`sendBackTo: []`).
- **Done means merged.** A goal with a pull request counts as done for its dependants, for its
  spec's closing and for removing its worktree only once it merged: Linear's done is the
  operator's answer, not the merge.

## D43 · Factory phase 7: the factory screen

- **Why.** Until now the pipeline was visible only one run at a time, through the issue bar on
  each flight. The operator needs every spec and goal at a glance, and both gates in reach.
- **The board.** `/factory`, in the main navigation and on `g f`: one column per pipeline stage
  (spec ready, approved, building, merge question, done, needs you; a seventh only when an issue
  sits in an unmapped status), side by side at wide widths and three across below. A spec card
  counts its goals done (merged, when it has a pull request); a goal card names its spec, its
  branch, its pull request and whether it merged, the verdicts of its latest build, and the runs
  to follow. Its data comes from one loader (`lib/factory-board.ts`) that reads what the watcher
  and the runs stored; the screen never calls Linear or GitHub itself.
- **Both gates on the cards.** Approve on a spec waiting for it; Merge and Send back with a note
  on a goal at the merge question with its pull request. They are the same Magpipe doors as the
  issue bar's (D38, D42), and the board re-reads itself after each, and every 20 seconds while
  the tab is visible.
- **Empty and unavailable.** Before Linear is set up, or before the first spec lands, the screen
  says what will appear and links Home and Settings, with the real facts (agents loaded, Linear,
  GitHub). The demo data has no factory, so this screen offers none. A database that cannot be
  opened shows the shell's unavailable state; a loading boundary sits beside the page.

## D44 · Factory phase 8: unattended merges under the operator's rule

- **Why.** Once goals build, pass three judges and land through a re-test, low-risk work can
  merge without the operator answering every question. The design made this its own decision:
  the factory may answer G2 itself only under a rule the operator sets, never on its own
  judgment.
- **Decided: off by default, narrow when on.** Settings → GitHub → Unattended merges holds the
  switch (off) and the rule. Every condition must hold: the goal or its spec carries a Linear
  label the operator names (default `auto-merge`), so only work they marked is eligible; every
  judge of the latest build passed, on the first try unless the operator drops that condition
  (nothing sent back); and the pull request's checks are green unless the operator drops that
  one. Checks still running mean wait; failed checks, or none at all, leave the question to the
  operator. Four columns on `forge_settings`, migration 0012.
- **How it answers.** After each Linear check, the tick holds each goal at the question to merge
  to the rule (`ruleVerdict`, a pure function, tested condition by condition). Where it holds,
  the answer is recorded as `rule`, the issue gets a comment saying the rule answered and why,
  and the goal lands exactly as an answer from a person would: brought up to date, tested again,
  checked by the Merge Agent, merged, or sent to needs you when anything fails. Where it does
  not hold, nothing is said; the question waits as before. The issue bar and the board say
  "by your rule".
- **Labels from Linear.** Issues now carry their label names on the tracker seam; the rule reads
  the goal's and its spec's at decision time, so adding or removing the label in Linear takes
  effect at the next check.
- **Not done.** No rule on the size of a change or the paths it touches, and no per-repository
  rules: the label is the operator's way to scope it. Re-read Anthropic's terms before letting
  the factory run unattended on a subscription (D36).

## D45 · Factory projects

- **Why.** The factory was bound to one repository, one Linear team and one GitHub repository.
  The operator works on several products and wants each to have its own Linear project, its own
  repository and what else goes with it, without a second Magpipe.
- **Decided: a project per repository.** `factory_projects` (migration 0013) holds a name, the
  folder and its scripts, a brief for the agents, a Linear group (team, optional Linear project,
  label, the six statuses), a GitHub group (repository, merge method, the D44 rule), an optional
  Linear key and GitHub token of its own (sealed like every key, D13), builds at once, a daily
  spend cap and a model per factory agent slug. Every tracker issue carries its `projectId`, and
  so does every factory run (`run.input.projectId`).
- **Shared credentials, with an override.** Settings keeps one Linear key and one GitHub token for
  every project, and its team, label, statuses, repository and rule are the workspace's: a
  project that sets none of its own inherits them. A project with its own team uses its own
  mapping, read back from Linear with the key it will use when saved; its own repository is read
  back from GitHub the same way. `projectLinear` and `projectForge` put the two together, so the
  watcher, the tick, the action steps and both gates read one settings shape, per issue.
- **The Default project.** When no project exists and the factory is loaded, the Default project
  is made on the factory's repository, inheriting everything, and every issue without a project
  joins it (`ensureDefaultProject`, from the tick, the factory screens and a new spec). A
  factory set up before projects keeps working with no change.
- **The watcher per project.** One check reads each project with Linear set up, a project with a
  Linear project first, so it claims its issues before a project on the same team without one.
  An issue another project holds is left to it. The check time and the watcher's pace stay the
  workspace's.
- **The engine.** A project's run replaces the folder and scripts of the repository the factory's
  agents hold with the project's (a goal's worktree still stands in for the folder, D41), adds the
  project's brief to each step's prompt, uses the project's model for an agent where it names
  one, and stops at the project's own spend cap as well as the workspace's (`spendToday` per
  project, by `input->>'projectId'`). `readyGoals` keeps each project to its own builds at once
  inside the workspace limit.
- **Screens.** Factory → Projects lists the projects; a project's page edits it in sections
  (repository, context, Linear, GitHub, limits, models, keys). Home shows a project picker beside
  Send to the factory when there is more than one; a follow-up keeps its thread's project. The
  board names each card's project and filters by one.
- **Not done.** No project per non-factory run, no moving an issue between projects, and the
  Linear project filter and `team.projects` query are untested against live Linear, like the
  rest of the client (D38).

## D46 · Project pages: each project owns its repository and Linear project

- **Why.** The operator's picture of the factory is a set of projects, each with its own GitHub
  repository, its own Linear project, its own context, its own Specification Agent and its own
  factory runs. D45 let a project borrow the workspace's Linear team and repository, made the
  Linear project optional, and kept one board for all projects with specs written on Home.
- **Decided: a project owns both.** A project's Linear team, Linear project, label and statuses,
  and its GitHub repository, merge method and rule, are its own and required to save. Nothing is
  inherited: `projectLinear` and `projectForge` read only the project, and a project without its
  Linear project has no Linear (nothing filed, nothing watched) until it is given one. Only the
  keys are shared: Settings keeps one Linear key, one GitHub token and the watcher, and a project
  may carry its own key or token (D45). Settings → Linear loses the mapping and Settings → GitHub
  the repository and the rule; `saveLinearMapping`, `linearOptions`, `saveForgeRepo` and
  `saveAutoMerge` are gone with their inputs.
- **One of each per project.** Saving refuses a Linear project another project files into, a
  repository another project lands in, and a folder whose origin is a GitHub repository other
  than the one named, since goals are pushed to the folder's origin.
- **The Default project takes over the workspace's.** Made from the loaded factory, it starts
  with the team, label, statuses, repository and rule Settings held before (and a Default made
  under D45 takes them once, while it is the only project), and still needs its Linear project.
  The workspace columns stay in their tables as that seed; no migration drops them.
- **Screens.** Factory lists the projects with what waits for the operator in each. A project's
  page has its Specification Agent (a spec box that runs the spec template for the project),
  what it still needs, its board and its latest runs; its settings page is the editor
  (`/factory/[id]/settings`), and `/factory/new` adds one. Home keeps Send to the factory with
  the project picker. The board filter and `/factory/projects` are gone.
- **Work never changes hands.** A project with work in flight (an issue waiting, approved,
  building, at the merge question or needing the operator, a pull request not merged, or a run
  going) cannot be deleted, and the last project cannot be deleted at all: either would leave
  goals with no repository or Linear, or hand them to whichever project remained. Finished
  issues stay, without a project.
- **A new Linear project takes the open issues along.** When a project's Linear project changes
  (or the Default gets its first one), its open issues are moved into it in Linear, so the
  watcher, which reads only that Linear project, still sees them; the save says which moved and
  which did not. Any change to the team, Linear project, label or a status makes the next check
  read every issue again.
- **The tick goes on, one issue at a time.** Each issue's part of a tick is its own: one whose
  project has no Linear or no repository waits, and a failure is reported for that issue without
  stopping the others. When no project is ready in Linear, the watcher still runs the factory's
  other work and says why nothing in Linear is watched; with no project at all it does not fall
  back to the workspace's old mapping.
- **Not done.** A project in another Linear workspace can be given its own key only once it
  exists, and it cannot be created until the shared key reads its Linear project back; the
  same holds for GitHub.

## D47 · Signing in without pasting: the GitHub CLI and Sign in with Linear

- **Why.** The operator asked to use what is already signed in on their computer, the Linear MCP
  and the GitHub CLI, instead of pasting a Linear key and a GitHub token.
- **GitHub: the GitHub CLI's own sign-in.** Settings → GitHub offers it beside the pasted token
  (`forge_settings.key_source`, `token` or `gh`, migration 0014). Chosen, Magpipe asks `gh auth
  token --hostname github.com` for a token when it needs one, keeps it in memory for five minutes,
  and stores nothing; signing out of `gh` signs Magpipe out. `gh` is looked for at
  `MAGPIPE_GH_PATH`, in a login shell and where its installers put it, as `claude` is (D22),
  since an app started from the Dock has no shell `PATH`. A project's own token (D45) still comes
  first. Goal branches were already pushed with the operator's own git credentials. The CLI's
  token reaches every repository the account can, wider than the fine-grained token Settings
  suggests; that is the operator's choice to make, and Settings says what it uses.
- **Linear: Sign in with Linear, not the MCP server.** D38 chose Linear's API over its MCP server
  for the watcher's one precise query, and that still holds: MCP tools are shaped for a model to
  read and may change, and an MCP client would still keep an OAuth token. What the operator wanted
  from MCP, no key to paste, comes from Linear's own OAuth: OAuth 2.0 with PKCE (S256), so the
  desktop app needs an OAuth app's client ID and no secret. The client ID comes from
  `MAGPIPE_LINEAR_CLIENT_ID` in magpipe.env or is entered once in Settings, where the callback
  URL to register is shown. Sign in opens Linear in the system browser; Linear sends it back to
  `/api/linear-callback` on the app's own origin, which is public (the system browser carries no
  desktop cookie) and safe by its state: one started here in the last ten minutes, used once,
  with the PKCE verifier only this server holds; the desktop Host check still applies. The code
  is traded for tokens, the token is checked with Linear, and the pair is stored sealed
  (`linear_settings.key_kind`, `refresh_ref`, `expires_at`, `oauth_client_id`). Calls send it as
  a Bearer token; it is renewed with the refresh token when it has under ten minutes left, one
  renewal at a time, the new pair stored before the old is let go; a refused renewal asks the
  operator to sign in again. Signing out revokes it with Linear, best effort. Settings watches
  for the sign-in to land and says so.
- **The pasted key and token stay**, as the fallback and for projects in another workspace or
  account, whose own keys (D45) are always pasted ones.
- **Tests.** A fake `gh` script (unit tests, and `e2e/stubs/gh` for the e2e server) and a fake
  token endpoint (`useLinearOAuthFetch`); the scripted tracker's stand-in comes straight back from
  the sign-in with a scripted code, so the e2e test runs the whole flow through the screens.
- **Not done.** Neither has been tried against live Linear or a real `gh` sign-in from here
  (D38): the OAuth endpoints and parameters follow Linear's published OAuth documentation. The
  desktop app's port must match the callback URL registered with Linear; it is stable unless the
  preferred port is taken at launch, and Settings shows the URL in use.


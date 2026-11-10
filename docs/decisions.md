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
  (`settings.spendCapUsd` is recorded, not enforced), and artifacts produced by runs.

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

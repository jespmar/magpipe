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

| Rule                                         | Why it is intentional                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kicker-above-heading` / `hero-eyebrow-chip` | The eyebrow ("THE FLOCK", "BEAKS & CLAWS") is part of the design canvas and spec §4.                                                                |
| `gradient-text`                              | The eyebrow's sheen gradient is the brand's one gradient-on-text (spec §4). A single short word renders solid instead, so it never splits two-tone. |
| `overused-font`                              | Inter is the only family by spec; an Operate surface needs no second face.                                                                          |
| `dark-glow`                                  | The white primary button carries the sheen glow pinned by the Agents artboard (`0 0 22px rgba(34,193,220,.25)`); DESIGN.md "Light as State". Added with PR 2. |

Two implementation lessons from the same pass, now conventions in `CLAUDE.md`: prose widths in
`rem` (Inter is narrower than its `0`, so `ch` overshoots the 75-character measure), and no
`revalidatePath('/', 'layout')` from server actions (it makes the production router fall back to
a hard navigation; the form stays pending). Fresh workspaces now get `region: 'local'` rather
than the demo's `eu-north-1`, and the footer shows `desktop` when no region is configured.

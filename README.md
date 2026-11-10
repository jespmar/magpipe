# Magpipe

An agent orchestrator: type a task, Magpipe splits it across a small flock of AI agents, runs
them, merges the result and keeps what they learned in shared memory. It ships as a
**self-contained desktop app** — one installer, no Docker, no database server, no cloud
account. The database is Postgres running inside the app (PGlite).

- Product spec: [`docs/spec.md`](docs/spec.md) · design canvas linked at its top
- Decisions (database, access, run engine, packaging): [`docs/decisions.md`](docs/decisions.md)

> **Status: PR 1 — scaffold.** Shell, design tokens, routes, embedded database with
> migrations, first-launch setup, demo data and the desktop wrapper are in place. Screens whose
> bodies are not built yet show an honest empty state in product voice — what will appear there,
> the real numbers from your workspace, and what you can do now (spec §10 for the build order).

## Quick start

Needs Node 22.12+. Nothing else.

```bash
npm install
```

Run the desktop app (starts `next dev`, then opens Electron against it):

```bash
npm run dev
```

…or the same app in your browser at http://localhost:3456:

```bash
cp .env.example .env.local
```

```bash
npm run dev:web
```

The first start creates the database in `./.magpipe/` with the four starter agents. To see the
design's tools, memory and runs, use **Settings → Load demo data**.

## Building the installer

On your own machine, for its OS:

```bash
npm run dist
```

Installers land in `release/` — `.dmg`/`.zip` (macOS, arm64 + x64), `.exe` (Windows),
`.AppImage` (Linux). To build all three, push the repo to GitHub and run the **Desktop
installers** workflow (Actions tab, or push a tag such as `v0.1.0`); each OS builds its own and
the files appear as downloadable artifacts.

The installers carry **no developer certificate** yet. The macOS app is ad-hoc signed at
packaging time (`scripts/adhoc-sign-mac.cjs`), so the first launch needs right-click → Open
and a confirmation; Windows SmartScreen will warn. If macOS calls the app "damaged" (a build
made before ad-hoc signing was added, or a copy whose signature was stripped), clear the
download flag and sign it yourself, then open it normally:

```bash
xattr -cr /Applications/Magpipe.app
codesign --force --deep --sign - /Applications/Magpipe.app
```

Signing with an Apple Developer certificate and notarizing is a later step.

## Where things live (desktop app)

| What             | macOS                                               | Windows                         | Linux                           |
| ---------------- | --------------------------------------------------- | ------------------------------- | ------------------------------- |
| Config file      | `~/Library/Application Support/Magpipe/magpipe.env` | `%APPDATA%\Magpipe\magpipe.env` | `~/.config/Magpipe/magpipe.env` |
| Data (db, files) | `…/Magpipe/data/`                                   | `…\Magpipe\data\`               | `…/Magpipe/data/`               |
| Logs             | `…/Magpipe/logs/server.log`                         | same                            | same                            |

File → Open Config File / Show Logs gets you there. Back up by copying `data/` while Magpipe is
closed.

## Scripts

| Script                    | What it does                                                                |
| ------------------------- | --------------------------------------------------------------------------- |
| `dev`                     | `next dev` + Electron window (macOS title bar is the app nav)               |
| `dev:web`                 | `next dev` only, port 3456                                                  |
| `build`                   | `next build` → standalone server, then compile `electron/`                  |
| `start`                   | Run the built desktop app (`electron .`)                                    |
| `dist`                    | Build and package the installer for this OS into `release/`                 |
| `seed` / `seed:reset`     | Load demo data with the app closed / wipe agents, tools, memory, runs first |
| `db:generate`             | Write a SQL migration after changing `lib/db/schema.ts`                     |
| `typecheck` `lint` `test` | Definition of done for every PR                                             |
| `e2e`                     | Playwright smoke tests (own dev server, own data folder)                    |

## How the desktop app works

```
Electron main ──utilityProcess.fork──▶ server.js (Next standalone, 127.0.0.1:3456)
      │   per-launch token                 └── PGlite (Postgres in WASM) → data/db
      └── BrowserWindow (sandboxed, token cookie) ── http://localhost:3456
```

- `electron/main.ts` — window, navigation allow-list, permissions, menu, token, clean quit.
- `electron/server.ts` — picks a port, forks the server, waits for `/api/health` (which also
  creates/migrates the database), asks it to close the database on quit.
- `electron/config.ts` — reads `magpipe.env`, generates `AUTH_SECRET`, sets the data folder.
- Only the app window can talk to the server: requests without the per-launch token are
  refused, so other programs and websites cannot reach it (`docs/decisions.md` D4).

## Layout

```
app/                 routes — (shell)/ holds every screen inside AppShell
  api/health, api/internal/shutdown, api/auth
components/          AppShell, Logo, NavLinks, arc/ (Arc UI, vendored), ui/ wrappers
lib/
  schemas/           zod schemas = row types = API validation
  db/                PGlite + Drizzle: schema, schema-check, seed, seed-data
  ids.ts env.ts auth-mode.ts session.ts api.ts shell-data.ts nav.ts
drizzle/             SQL migrations (generated, committed, shipped)
auth.ts auth.config.ts middleware.ts
electron/            main, server launcher, config, preload
scripts/             dev orchestrator, seed, standalone + app-manifest prep
tests/ e2e/          Vitest (incl. real database tests), Playwright
.github/workflows/   per-OS installer builds
docs/                spec, decisions
```

## Conventions

See [`CLAUDE.md`](CLAUDE.md). The interface is built from [Arc](https://uiarc.dev) components
(`components/arc/`, installed with `npx shadcn@latest add @uiarc/<id>`, never edited by hand) on
Magpipe's own palette; `DESIGN.md` describes the result.

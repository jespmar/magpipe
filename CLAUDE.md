# Magpipe — working notes for Claude Code

Read `docs/spec.md` (the product) and `docs/decisions.md` (choices already made) before a PR.
Build order and the definition of done are in spec §10. The decisions log overrides spec §2:
the app is a self-contained desktop app with an embedded Postgres (PGlite), an in-app run
engine and no sign-in on desktop.

## Rules

- **Bird words are UI copy only.** Code, tables, routes and types say agent / run / step /
  tool / memory. Only strings rendered to users say flock, flight, nest, bird.
- **Arc is the component framework.** Controls come from `components/arc/` (uiarc.dev,
  installed verbatim with `npx shadcn@latest add @uiarc/<id>`; `components.json` holds the
  registry) and are never edited or restyled; `components/ui/` wraps them with the product's
  defaults (`Button` defaults to `secondary`, one `primary` per surface; `StatusPill`,
  `EmptyState`, `SearchInput`, `FilterControl`, `CodeBlock`). Arc's rules apply: sentence case,
  weights 400 and 500 only, no eyebrows or uppercase, no em dashes in copy, no gradients or glows,
  a reduced-motion branch for every animation, documented props only. The full skill is in
  `.claude/skills/arc/` (SKILL.md, checklist.md).
- **Tokens only.** `app/globals.css` maps Magpipe's palette onto Arc's semantic tokens
  (`--background`, `--surface`, `--foreground`, `--accent` = cyan, `--success`, `--warning`,
  `--danger`) and resets the Tailwind palette, so `bg-blue-500` does not exist. Use `text-ink`,
  `text-body`, `text-mute`, `bg-canvas-raised`, `border-hairline`, `bg-cyan-soft`,
  `text-display-md`, `card`, `page-title`, `shell-container`, `wide:` (≥1600 px); Arc's radii as
  `rounded-(--radius-control)`. White acts, cyan is alive or chosen, emerald/amber/red mean
  done/needs you/failed. No green or purple as UI colours, no light theme.
- **Schema changes touch three places:** the zod schema in `lib/schemas`, the Drizzle table in
  `lib/db/schema.ts` (the typecheck fails until they match — `schema-check.ts`), and a new
  migration from `npm run db:generate`, committed in `drizzle/`. Never edit an existing
  migration.
- **Database access** goes through `getDb()` from `lib/db`. Ids come from `newId()`; run display
  ids from `nextRunDisplayId(db)`. Only one process may open the data folder — scripts that
  need the database must handle `DbLockedError`.
- **Route handlers** use `requireUser()`, `parseBody(req, schema)` and `apiError()` from
  `lib/api.ts`; errors are `{ error: { code, message } }`.
- **Server components** must degrade when the database cannot be opened, as the shell does.
- **Electron main stays dependency-free** (node + electron only) and keeps the security
  settings in `electron/main.ts`. New renderer capabilities go through named IPC channels in
  `electron/preload.ts`, never a raw `ipcRenderer`.
- **Unbuilt screens use `EmptyState`** (components/ui): product voice, what will appear, the real
  facts from `getOverview()`, and only links to places that exist. No PR numbers, no spec
  references, no disabled controls without a stated reason.
- **Motion is opt-in.** Decorative animation uses the `motion-safe:` variant (the live dot, the
  orb's orbit); Arc components carry their own reduced-motion branch. There is no global
  reduced-motion kill; state transitions stay.
- **Prose measure in rem, not `ch`.** Inter is narrower than its `0`, so `max-w-[31rem]` ≈ 75
  characters at 14 px and `max-w-[34rem]` ≈ 72 at 16 px. The detector's `line-length` rule
  counts real characters.
- **Server actions never `revalidatePath('/', 'layout')`.** Every screen is `force-dynamic`
  already, and revalidating the root layout from an action makes the production router hard-
  navigate and leaves forms stuck pending. Return a result and `router.refresh()` from the
  client when the current page must re-read server data.
- **No eyebrows, no gradients, no glows** (D20 replaces spec §4's eyebrow and sheen). The page
  title is Geist through `page-title`; `PageHead` takes title, description, meta and actions.
  The brand is the magpie, white-acts/cyan-tells, mono facts and the bird words in prose.
- **Loading boundaries live per segment** (`loading.tsx` next to each list page, re-exporting
  `PageSkeleton`), never at the `(shell)` level: a streaming boundary above a page that calls
  `notFound()` answers 200 before the 404 is known. `runs/[id]` has none on purpose.
- **Precise lines use plain nouns.** Status badges, fact lines, table cells and Settings rows say
  agent / run / step / memory / tool, and a run is "running", never "flying". The metaphor
  (birds, flights, the nest, shiny bits) lives in headings and empty-state prose only.
- **Address changes go through the router.** Client components never call
  `history.replaceState`/`pushState`: Next treats them as a navigation keyed on the old search
  params, and the next `router.refresh()` lands in the wrong slot and is silently dropped. Use
  `router.replace(url, { scroll: false })` for a changed address and `router.refresh()` for the
  same one; keep transient selection in state and read `?agent=`-style params only at load.
- **Model calls go through `lib/engine/backend.ts`.** `RunBackend` (plan · step · merge) is the
  seam: `apiBackend` wraps `ModelClient` (`lib/engine/model.ts`; tests script it) and
  `claudeCodeBackend` (`lib/engine/claude-code.ts`, the default) runs the `claude` CLI, with a
  step's tools served back over `/api/mcp` under a per-step token (`tool-sessions.ts`);
  `MAGPIPE_MODEL_BACKEND=api` picks the API. API requests carry
  `fallbackParams(model)`, never a forced `tool_choice` (400 on the 5.5 family), and structured
  outputs for JSON. Retries are the engine's (`withRetries`), not the SDK's. Tool names on the
  wire are `wireName(...)` and every tool schema sets `additionalProperties: false`. Tool calls
  are recorded through `invokeTool`, whichever backend made them.
- **Runs are durable by their plan.** Write `runs.plan` before and after each step, append to
  `run_events` through `emitEvent`, and never hold run state only in memory: a restart resumes
  from the plan (`resumeInterrupted`).
- New public routes must be added to the matcher in `middleware.ts`; everything else is behind
  the desktop token (desktop) or a session (hosted).
- **Repositories stay typed.** Agents reach a bound repository only through the named operations
  in `lib/repo.ts` (D27): paths stay inside the folder, `.git` and env files are refused, `run`
  takes a script the operator allowed, commits name their files and never land on the default
  branch, and nothing pushes. A new capability is a new named operation with its guard and a
  test, never a shell or a free-form command. A mutating operation joins `MUTATING_OPS` in
  `lib/engine/locks.ts`, so one step at a time changes a work tree (D28).
- **Home stays on Home.** The prompt never navigates: a run started there is selected in place
  (`HomeScreen`), the panel shows it and the next message follows it up (`parentRunId`;
  `loadThread` puts the thread into every prompt). Closing a card sets `dismissedAt`; the Runs
  screen still lists the run. "Open log" is the way to the run's page.
- **Keyboard shortcuts come from `lib/shortcuts.ts`.** Add a key there (the handler, the `?`
  sheet and Settings read the same list); single keys must stay out of text fields and open
  dialogs (`[role="dialog"]`, Arc's `Dialog`). Search fields are `<input type="search">` so `/`
  can find them.
- **`lib/flock.ts` mirrors `docs/flock.md`.** The development flock's prompts, roles, models,
  scopes, limits, grants and standing instructions live in both; `tests/flock.test.ts` parses the
  document, so change them together. A new agent setting the flock should carry goes into
  `FlockAgent` and the fields `upsertAgents` sets, in the same change.
- **Tests never need model credentials.** Unit tests script `ModelClient`; the Playwright
  server runs with `MAGPIPE_MODEL_STUB=scripted` (`lib/engine/stub-model.ts`), which the engine
  ignores in production builds.

## Before you say a PR is done

```bash
npm run typecheck && npm run lint && npm test
```

Then check the screen against its artboard at 1280 and 2560 px with no console errors.

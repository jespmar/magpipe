# Magpipe — working notes for Claude Code

Read `docs/spec.md` (the product) and `docs/decisions.md` (choices already made) before a PR.
Build order and the definition of done are in spec §10. The decisions log overrides spec §2:
the app is a self-contained desktop app with an embedded Postgres (PGlite), an in-app run
engine and no sign-in on desktop.

## Rules

- **Bird words are UI copy only.** Code, tables, routes and types say agent / run / step /
  tool / memory. Only strings rendered to users say flock, flight, nest, bird.
- **Tokens only.** Colours come from `app/globals.css` (the Tailwind palette is reset, so
  `bg-blue-500` does not exist). Use `text-ink`, `bg-canvas-soft`, `border-hairline`,
  `text-display-lg`, `eyebrow`, `label-caps`, `card`, `panel`, `shell-container`, `wide:`
  (≥1600 px). Raw `rgba(…)` is fine for the one-off cyan/amber tints the design uses. No green
  or purple; the primary button is white (`buttonClass('primary')`).
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
  orb). There is no global reduced-motion kill; 150 ms state transitions stay.
- **Prose measure in rem, not `ch`.** Inter is narrower than its `0`, so `max-w-[31rem]` ≈ 75
  characters at 14 px and `max-w-[34rem]` ≈ 72 at 16 px. The detector's `line-length` rule
  counts real characters.
- **Server actions never `revalidatePath('/', 'layout')`.** Every screen is `force-dynamic`
  already, and revalidating the root layout from an action makes the production router hard-
  navigate and leaves forms stuck pending. Return a result and `router.refresh()` from the
  client when the current page must re-read server data.
- **Eyebrows and the sheen gradient are the brand** (spec §4, PRODUCT.md): the detector flags
  them as `kicker-above-heading` / `gradient-text` / `overused-font`; those three are accepted
  (see `.impeccable/critique/ignore.md`). A single short eyebrow word renders solid
  (`PageHead` sets `data-solid`).
- **Loading boundaries live per segment** (`loading.tsx` next to each list page, re-exporting
  `PageSkeleton`), never at the `(shell)` level: a streaming boundary above a page that calls
  `notFound()` answers 200 before the 404 is known. `runs/[id]` has none on purpose.
- **Precise lines use plain nouns.** Status pills, fact lines, table cells and Settings rows say
  agent / run / step / memory / tool, and a run is "running", never "flying". The metaphor
  (birds, flights, the nest, shiny bits) lives in headings, eyebrows and empty-state prose only.
- **Address changes go through the router.** Client components never call
  `history.replaceState`/`pushState`: Next treats them as a navigation keyed on the old search
  params, and the next `router.refresh()` lands in the wrong slot and is silently dropped. Use
  `router.replace(url, { scroll: false })` for a changed address and `router.refresh()` for the
  same one; keep transient selection in state and read `?agent=`-style params only at load.
- **Model calls go through `lib/engine/model.ts`.** `ModelClient` is the one seam (tests script
  it); requests carry `fallbackParams(model)`, never a forced `tool_choice` (400 on the 5.5
  family), and structured outputs for JSON. Retries are the engine's (`withRetries`), not the
  SDK's. Tool names on the wire are `wireName(...)` and every tool schema sets
  `additionalProperties: false`.
- **Runs are durable by their plan.** Write `runs.plan` before and after each step, append to
  `run_events` through `emitEvent`, and never hold run state only in memory: a restart resumes
  from the plan (`resumeInterrupted`).
- New public routes must be added to the matcher in `middleware.ts`; everything else is behind
  the desktop token (desktop) or a session (hosted).

## Before you say a PR is done

```bash
npm run typecheck && npm run lint && npm test
```

Then check the screen against its artboard at 1280 and 2560 px with no console errors.

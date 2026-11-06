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
- New public routes must be added to the matcher in `middleware.ts`; everything else is behind
  the desktop token (desktop) or a session (hosted).

## Before you say a PR is done

```bash
npm run typecheck && npm run lint && npm test
```

Then check the screen against its artboard at 1280 and 2560 px with no console errors.

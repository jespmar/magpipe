---
name: Magpipe
description: A dark, quiet aviary built from Arc components, where the few bright things are the ones that act or are alive.
colors:
  canvas: '#101010'
  canvas-raised: '#181818'
  canvas-soft: '#1a1a1a'
  canvas-muted: '#222222'
  hairline: '#3d3a39'
  hairline-soft: '#1f1f1f'
  ink: '#f2f2f2'
  ink-strong: '#ffffff'
  body: '#bdbdbd'
  mute: '#8b949e'
  sheen-cyan: '#22c1dc'
  sheen-cyan-soft: '#66d9e8'
  sheen-emerald: '#16a35e'
  warn: '#fbbf24'
  danger: '#f87171'
typography:
  display:
    fontFamily: 'Geist, sans-serif'
    fontSize: '36px'
    fontWeight: 400
    lineHeight: '40px'
    letterSpacing: '-0.03em'
  headline:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '22px'
    fontWeight: 500
    lineHeight: '28px'
    letterSpacing: '-0.01em'
  title:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '18px'
    fontWeight: 500
    lineHeight: '26px'
  body:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '16px'
    fontWeight: 400
    lineHeight: '24px'
  body-sm:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '14px'
    fontWeight: 400
    lineHeight: '20px'
  caption:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '12px'
    fontWeight: 400
    lineHeight: '16px'
  label:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '14px'
    fontWeight: 500
    lineHeight: '20px'
  code:
    fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace"
    fontSize: '13px'
    fontWeight: 400
    lineHeight: '18px'
rounded:
  xs: '4px'
  sm: '6px'
  md: '8px'
  control: '18px'
  panel: '26px'
  surface: '34px'
  pill: '9999px'
spacing:
  xs: '4px'
  sm: '8px'
  md: '12px'
  lg: '16px'
  xl: '24px'
  2xl: '32px'
  3xl: '48px'
components:
  button-primary:
    backgroundColor: '{colors.ink}'
    textColor: '{colors.canvas}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '0 16px'
  button-secondary:
    backgroundColor: '{colors.canvas-raised}'
    textColor: '{colors.ink}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '0 16px'
  button-ghost:
    backgroundColor: 'transparent'
    textColor: '{colors.body}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '0 16px'
  badge-status:
    backgroundColor: '{colors.canvas-raised}'
    textColor: '{colors.ink}'
    typography: '{typography.caption}'
    rounded: '{rounded.pill}'
    padding: '0 10px'
  chip-mono:
    backgroundColor: '{colors.canvas-soft}'
    textColor: '{colors.ink}'
    typography: '{typography.code}'
    rounded: '{rounded.sm}'
    padding: '2px 8px'
  card:
    backgroundColor: '{colors.canvas-raised}'
    textColor: '{colors.ink}'
    rounded: '{rounded.surface}'
    padding: '24px'
  input:
    backgroundColor: '{colors.canvas-raised}'
    textColor: '{colors.ink}'
    typography: '{typography.body-sm}'
    rounded: '{rounded.control}'
---

# Design System: Magpipe

## Overview

**Creative North Star: "The Night Aviary, quiet"**

Magpipe is a dark, quiet enclosure in which a few bright birds are always visible. The ground is
near-black and stays that way. The things you can act on are white (the logo disc, the primary
button); the things that are alive or chosen are cyan (the live badge, the active link, the
selected row, the progress fill); done is emerald, "needs you" is amber, failed is red. Everything
else is drawn in greys and hairlines so the birds carry the picture.

The components are Arc's (uiarc.dev): CSS modules on semantic tokens, Motion for the few
movements that explain a change. Magpipe's palette is mapped onto Arc's tokens in
`app/globals.css`, so a button, a badge or a dialog from Arc is already in the aviary's colours.
Type carries the hierarchy: Geist at display size for the page title, Inter at 400 and 500 for
everything else, mono for anything that is data. There are no eyebrows, no gradients, no glows and
no uppercase. Copy is short and plain; the bird metaphor lives in headings and prose and stays out
of any label that must be precise. There is no light theme and no second accent.

**Key Characteristics:**

- Near-black canvas, flat surfaces on 1 px hairlines; depth only on floating layers (dialogs).
- White acts, cyan is alive or chosen, emerald/amber/red mean done/needs you/failed. Nothing else is coloured.
- Geist for the page title, Inter for the rest at 400 and 500; mono for ids, counts, models, paths.
- Arc's shapes: 18 px controls, 26 px panels, 34 px surfaces, pills for status; nested corners stay concentric.
- Motion explains a change (a dialog rising, a label morphing, a progress fill settling); the only loops are a live dot and the orb's slow orbit, both opt-in.

## Colors

A black aviary with one accent: white does, cyan tells.

### Primary

- **Ink Strong** (#ffffff): headings and the strongest text. **Ink** (#f2f2f2, Arc's
  `--foreground`): the primary button's fill and body-strong text. If a surface is light, it is
  something you can act on.

### Secondary

- **Sheen Cyan** (#22c1dc, Arc's `--accent` and `--info`): the live colour. The active nav
  underline (2 px), the running and connected badges, the selected row's edge and 12 % wash
  (`--accent-subtle`), the progress fill, the keyboard focus outline, the dashed orbit, the logo's
  wing. Never a fill behind text, never a glow.
- **Sheen Emerald** (#16a35e, `--success`): one meaning, a finished state (done). Also the far
  end of the wing.

### Tertiary

- **Warn Amber** (#fbbf24, `--warning`): needs attention. A tool that needs re-authorising, the
  database notice, a stale memory.
- **Danger Red** (#f87171, `--danger`): failed, conflicting, destructive. Text, badges and the
  danger button's label only.

### Neutral

- **Canvas** (#101010, `--background`): the page.
- **Canvas Raised** (#181818, `--surface`): cards, inputs, buttons, table header rows.
- **Canvas Soft** (#1a1a1a, `--surface-raised`): dialogs, chips, avatar discs, key caps.
- **Canvas Muted** (#222222, `--surface-muted`): hover and pressed fills, disabled controls, the segmented control's track.
- **Hairline** (#3d3a39, `--border`): every border at rest. **Hairline Soft** (#1f1f1f, `--border-subtle`): row dividers and rules inside a surface.
- **Body** (#bdbdbd, `--text-secondary`): running text. **Mute** (#8b949e, `--text-muted`): labels, captions, metadata, still ≥4.5:1 on canvas.

### Named Rules

**The White Acts Rule.** A light fill means a thing you can press: the primary button, the logo
disc. A decorative light surface is a mistake.

**The Cyan Tells Rule.** Cyan marks what is alive or chosen, as a badge, a 2 px line, a 12 % wash
or a fill that measures progress. It never fills a control or a panel and never glows.

**Status Means Status.** Emerald is done, amber needs you, red failed, always next to a word.
No other colour carries meaning.

## Typography

**Display Font:** Geist (`--font-display`, headings 30 px and up)
**Body Font:** Inter (`--font-body`)
**Mono Font:** SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono

**Character:** Arc's scale at fixed pixel sizes, two weights (400 and 500), sentence case
everywhere. Hierarchy comes from size, colour (Ink Strong over Body over Mute) and spacing, never
from bold, caps or tracking. Mono is reserved for things that are data: ids, counts, models,
paths, tokens.

### Hierarchy

- **Display** (Geist 400, 36/40 px, −0.03 em; 48/52 px at ≥1600): the page title, one per
  screen (`page-title`).
- **Headline** (Inter 500, 22/28 px, −0.01 em): one per section at most, e.g. the nest's
  "Magpipe is flying 3 agents", a dialog's title.
- **Title** (Inter 500, 18/26 px): card and panel titles, agent names on cards.
- **Body** (400, 16/24 px) and **Body Small** (400, 14/20 px): prose and descriptions; measure
  ≈72 characters (`max-width: 34rem` at 16 px, `31rem` at 14 px).
- **Label** (500, 14/20 px): field labels, section labels inside a card ("Tools", "Memory
  scope"), sentence case.
- **Caption** (400/500, 12/16 px): roles, timestamps, hints, table headers (Mute).
- **Code** (400/500, 13/18 px, mono): ids, counts, models, paths; `tabular-nums` where numbers change or align.

### Named Rules

**The Measured Column Rule.** Prose widths are set in rem, not `ch`; Inter is narrower than its
zero, so `ch` overshoots the 65–75 character measure.

**The Numbers Are Mono Rule.** Anything the operator might copy or compare is set in the mono
stack, often in Mute, often `select-all`.

**The Two Weights Rule.** 400 and 500 only. No 600, no bold, no uppercase, no letter-spacing on
small labels, no line above a heading.

## Layout

One page container (`shell-container`): 1200 px wide at desktop with 32 px gutters (16 px below
768 px), 2300 px wide with 48 px gutters at ≥1600 px ("wide"). Three breakpoints only: below
768 px everything stacks and the header becomes two static rows; 768–1599 px is the desktop
arrangement; at ≥1600 px wide arrangements switch on (side-by-side columns, a vertical flight
path, 48/52 px page titles).

Spacing on the 4 px grid: 16 px inside a group, 24 px between regions (the main column's gap),
32 to 48 px between sections of a long page, 24 px inside cards (20 in dense ones). Tables are
12-column CSS grids inside a card with a Caption header row and 1 px Hairline Soft dividers; a
selected row gets a 2 px cyan left edge and the 12 % cyan wash. Wide tables scroll inside their
card, never the page. Cards sit in fluid wrap grids and share edges (same top, same height).

## Elevation & Depth

Flat by default. Every surface is a hairline plane on the same dark ground; there are no drop
shadows at rest, no ambient glows and no gradients. Only floating layers (Arc's dialogs, menus)
carry a shadow (`--shadow-floating`). The nav is a solid canvas bar with a Hairline Soft rule
beneath it.

### Named Rules

**The Nothing Glows Rule.** No element glows: not the primary button, not a hovered card, not the
orb. Light is a fill (white, cyan), never a halo.

## Shapes

Arc's radii: 18 px for controls (buttons, inputs, the segmented control), 26 px for panels (menus,
nested lists), 34 px for surfaces (cards, dialogs, the empty state); 9999 px pills for status
badges, avatars and attachment chips; 4 to 8 px for the small things (mono chips, key caps, code).
A nested corner is the outer radius minus the padding, so curves stay parallel. Borders are 1 px
Hairline; the only thicker line is the 2 px cyan underline of the active nav item and the 2 px
left edge of a selected row.

## Components

Every control is an Arc component (`components/arc/`, installed verbatim with the shadcn CLI and
never edited). Magpipe's own primitives in `components/ui/` are thin wrappers that set the
product's defaults.

### Buttons

- **Arc `button`** through `components/ui/Button`: `primary` (Ink fill, Canvas label), `secondary`
  (Canvas Raised fill, Hairline border, the default), `ghost` (no fill, Body label) and `danger`
  (Danger label on a secondary shape). Sizes `sm` (36 px) in dense rows and toolbars, `md` (44 px)
  for a surface's main action.
- One primary button per surface. `loading` replaces the label with a spinner in place and keeps
  the button's width and focus; a verb-plus-object label ("Add fact", "Connect tool", "Save changes").
- `ButtonLink` gives a Next link the same shape for navigation.
- **Focus:** Arc's shared `:focus-visible` outline (cyan, 2 px, 2 px offset); nothing on pointer focus.

### Badges and chips

- **Status badge** (Arc `badge`, pill, dot): a 12 % tint of its tone with the tone as text and a
  dot. Running and connected are `info` (cyan), done `success`, failed and conflict `danger`,
  needs-auth and stale `warning`, the rest `neutral`. The dot is still; the only blinking dot is
  the bare one in a table cell or the streaming line, under `motion-safe:`.
- **Live badge:** "3 agents active" in the nav, `info` while anyone is running, `neutral` at rest,
  "Status unavailable" when the database cannot be read.
- **Mono chip:** Canvas Soft, Code text, 6 px radius, 2 × 8 px: tool names, scopes, models.
- **Status word:** inside a dense table cell the status is a 6 px dot and the lowercase word in the
  status colour, no badge.

### Cards / Containers

- **Card** (`card`): Canvas Raised, 1 px Hairline, 34 px radius, 24 px padding, no shadow, no
  hover effect. Content cards only, never nested; the dialog is the one floating surface.
- **Stat group:** four mono 22/28 500 values over Caption labels in one card, cells divided by
  Hairline Soft (`gap-px` on a Hairline Soft ground). Inside a card the three-tile strip is flat:
  Hairline Soft rules above and below, vertical dividers between.
- **Flight path:** Arc `stepper`, one step per planned step, `agent · meta` beneath the title. A
  horizontal chain below 1600 px (compact markers under 30 rem), a vertical list from 1600 px. The
  live step is current (cyan ring), a failed step carries its error, the steps after it stay upcoming.
- **Empty state:** Arc `empty-state` inside a card: an icon, a title, one or two sentences, the mono
  facts line and one real next step.
- **Progress bar:** Arc `progress` with its label kept for assistive tech only; the fill is cyan.

### Inputs / Fields

- Arc `input`, `textarea`, `select`, `checkbox` and `search-field`, each with its visible label
  (the toolbar search hides its label for assistive tech only). Canvas Raised fill, Hairline
  border, 18 px radius, 44 px tall; focus darkens the border to Ink; an error is a red border and
  a red line beneath, `role="alert"`. JSON and prompts set `font-family: var(--font-mono)` inline.
- **Dialogs:** Arc `dialog` for the editors and the shortcuts sheet: a titled header with its own
  close control, 24 px body padding, the commit row stuck to the bottom on Canvas Soft.
- **Code block:** Arc `code-block` with a name and language in its header, a Copy control and a
  fold after N lines; `text` for prompts, `json` for raw records.

### Navigation

A solid Canvas header with a Hairline Soft rule: logo disc (32 px) + wordmark left, four Body
Small links centred, the live badge and a ghost Settings button right. Active link: Ink Strong,
500, 2 px cyan underline; hover: Ink Strong. On phones the header is two static rows. Footer:
Body Small left, mono version · region right.

### Signature Components

- **Logo disc:** the dark magpie with white plumage and the cyan-to-emerald wing on a white disc;
  at the centre of the orb at 33 % of its width.
- **Orchestrator orb:** the disc inside two hairline rings (one cyan at 30 %) and one dashed cyan
  orbit that turns once every 24 seconds, only for people who have not asked for less motion. The
  screen's one memorable detail; it does not glow.
- **The flight log line:** `time · agent · text` in mono, the orchestrator's lines in cyan,
  errors in red.

## Do's and Don'ts

### Do:

- **Do** reach for an Arc component before writing a control; wrap it in `components/ui`, never fork it.
- **Do** make white mean action and cyan mean alive or chosen; keep every other colour for status, with a word beside it.
- **Do** set ids, counts, models and paths in mono, usually Mute, often `select-all`; `tabular-nums` where they change.
- **Do** write sentence case, verb-plus-object buttons, and periods, commas or colons instead of dashes.
- **Do** give every disabled control a visible reason, every empty state a real next step, and every error its remedy.
- **Do** hold prose to ≈72 characters with rem widths (34 rem at 16 px, 31 rem at 14 px).

### Don't:

- **Don't** add an eyebrow, an overline, uppercase text, tracked labels or a weight above 500.
- **Don't** add gradients, glows, coloured shadows or shadows on anything that does not float.
- **Don't** introduce a light theme, a blue, a purple or any second accent.
- **Don't** use the bird metaphor in badges, fact lines, table cells or Settings rows.
- **Don't** nest cards, break concentric corners, or use `ch` for measure.
- **Don't** restyle an Arc component's internals with classes; inline style only for a font family the content needs.

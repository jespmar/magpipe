---
name: Magpipe
description: A dark, quiet aviary where the few bright things are the ones that act or are alive.
colors:
  canvas: "#101010"
  canvas-soft: "#1a1a1a"
  canvas-raised: "#181818"
  hairline: "#3d3a39"
  hairline-soft: "#1f1f1f"
  ink: "#f2f2f2"
  ink-strong: "#ffffff"
  body: "#bdbdbd"
  mute: "#8b949e"
  code: "#f5f6f7"
  accent-white: "#ffffff"
  ghost: "#d1d5db"
  sheen-cyan: "#22c1dc"
  sheen-teal: "#0e9aa8"
  sheen-emerald: "#16a35e"
  sheen-cyan-soft: "#66d9e8"
  sheen-tint: "#d6f5f7"
  warn: "#fbbf24"
  danger: "#f87171"
typography:
  display-xl:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "60px"
    fontWeight: 400
    lineHeight: "60px"
    letterSpacing: "-0.65px"
  display:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "36px"
    fontWeight: 400
    lineHeight: "40px"
    letterSpacing: "-0.9px"
  headline:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: "32px"
    letterSpacing: "-0.6px"
  title:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "28px"
  body:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "26px"
  body-sm:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  caption:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  eyebrow:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "20px"
    letterSpacing: "2.52px"
  label:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "16px"
    letterSpacing: "1.2px"
  code:
    fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
  button:
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "20px"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent-white}"
    textColor: "{colors.canvas}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.sheen-tint}"
  button-outline:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  button-ghost:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ghost}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  pill-status:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  chip-mono:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.code}"
    typography: "{typography.code}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  card:
    backgroundColor: "{colors.canvas-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "24px"
  input:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
---

# Design System: Magpipe

## Overview

**Creative North Star: "The Night Aviary"**

Magpipe is a dark, quiet enclosure in which a few bright birds are always visible. The ground is
near-black and stays that way; the only light on it is the white of the things you can act on
(the logo on its disc, the primary button, the live dot) and one sheen — cyan running to teal and
emerald — that marks what is alive, current or identifying (eyebrows, the active underline, the
wing, a glow around a running thing). Everything else is drawn with hairlines so the birds carry
the picture.

The surface is an operator's tool, so familiarity is a feature: one sans for everything, mono
where numbers and identifiers live, fixed sizes rather than fluid ones, a stable top nav. Brand
shows in precise details — the gradient-clipped eyebrow, the cyan hairline under the frosted nav,
mono fact lines, the magpie — never in decoration. Copy is short and plain; the bird metaphor is
allowed in headings and prose and kept out of any label that must be precise. There is no light
theme and no second accent: green, purple and blue as UI colours are rejected.

**Key Characteristics:**

- Near-black canvas with a faint dot grid and one ambient cyan glow; depth from hairlines, not shadows.
- White is the only solid accent; the cyan→teal→emerald sheen appears only as a signal.
- Inter at fixed sizes, light display weights, mono for data; eyebrows in tracked uppercase.
- Small radii (6–8 px), pills only for status and filters, 1 px hairlines, 2 px active underline.
- Motion is a state, not a texture: a pulsing dot, a glow on hover, nothing on page load.

## Colors

A black aviary with one bright accent and one sheen: white does, the sheen tells.

### Primary

- **Accent White** (#ffffff): the one solid accent. Fills the primary button, the logo disc and
  the live dot; also the strongest text. If a surface is white, it is something you can act on.
- **Paper Tint** (#d6f5f7): the primary button's hover and the light end of the "Run" button's
  gradient — white warmed one step toward the sheen.

### Secondary

- **Sheen Cyan** (#22c1dc): the live colour. Active nav underline (2 px), status of a running
  agent, the hover border and glow on cards, the hairline under the nav (at 28% alpha), the bright
  end of the eyebrow gradient. Never a fill behind text.
- **Sheen Teal** (#0e9aa8) and **Sheen Emerald** (#16a35e): the middle and far end of the sheen
  ramp (`linear-gradient(135deg, #22c1dc 0%, #0e9aa8 55%, #16a35e 100%)`), used on the wing of
  the logo and the progress bar. Emerald alone is permitted for one meaning: a finished state
  (done).
- **Soft Cyan** (#66d9e8): the eyebrow gradient's mid-stop and the solid colour a single short
  eyebrow word takes instead of the gradient.

### Tertiary

- **Warn Amber** (#fbbf24): needs attention — a tool that needs re-authorising, the database
  banner, a stale memory. Text and 1 px borders only.
- **Danger Red** (#f87171): failed, conflicting, destructive. Text and 1 px borders only.

### Neutral

- **Canvas** (#101010): the page and the inside of every control.
- **Canvas Raised** (#181818) → **Canvas** gradient: cards (`linear-gradient(180deg, #181818, #101010)`).
- **Canvas Soft** (#1a1a1a): inputs, table header rows, avatar and chip backgrounds.
- **Hairline** (#3d3a39): every border at rest; **Hairline Soft** (#1f1f1f): row dividers.
- **Ink** (#f2f2f2) and **Ink Strong** (#ffffff): body-strong and headings.
- **Body** (#bdbdbd): running text. **Mute** (#8b949e): labels, captions, metadata — still ≥4.5:1 on canvas.
- **Code** (#f5f6f7): mono text. **Ghost** (#d1d5db): the ghost button's text.

### Named Rules

**The White Acts Rule.** White fills nothing that cannot be pressed. The primary button, the logo
disc and the live dot are white; a decorative white surface is a mistake.

**The Sheen Signals Rule.** Cyan, teal and emerald never fill a control or a panel. They appear as
text (eyebrows), as a 1–2 px line (active underline, hover border, nav hairline), as a glow on a
live or hovered thing, and as the wing. Their rarity is what makes "running" legible.

**The Two Semantics Rule.** Amber means "needs you", red means "failed". No other colour carries
meaning; status otherwise reads from a word, a dot and position.

## Typography

**Display Font:** Inter (system sans fallback)
**Body Font:** Inter
**Label/Mono Font:** SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono

**Character:** one well-tuned sans at fixed pixel sizes, light at display sizes and semibold for
controls, with a tracked uppercase eyebrow as the single typographic flourish. Mono is reserved
for things that are data: ids, counts, models, paths, tokens.

### Hierarchy

- **Display** (400, 36/40 px, −0.9 px; 48/52 px at ≥1600): the page title. The hero on Home may
  use Display XL (400, 60/60, −0.65 px).
- **Headline** (700, 24/32 px, −0.6 px): one per section at most — the orb's "Magpipe is flying
  N agents".
- **Title** (600, 20/28 px): card and panel titles, agent names on cards.
- **Body** (400, 16/26 px) and **Body Small** (400, 14/20 px): prose and descriptions; measure
  ≈72 characters (`max-width: 34rem` at 16 px, `31rem` at 14 px).
- **Caption** (400/500, 12/16 px): roles, timestamps, hints.
- **Eyebrow** (600, 14/20 px, +2.52 px, uppercase, sheen gradient clipped to text): the one
  line above a page title. A single word of eight characters or fewer renders solid Soft Cyan.
- **Label** (600, 12/16 px, +1.2 px, uppercase, Mute): table headers and section labels.
- **Code** (400, 13/18 px, mono; 550 for emphasis): ids, counts, models, paths.

### Named Rules

**The Measured Column Rule.** Prose widths are set in rem, not `ch` — Inter is narrower than its
zero, so `ch` overshoots the 65–75 character measure.

**The Numbers Are Mono Rule.** Anything the operator might copy or compare — an id, a count, a
token total, a model name, a path — is set in the mono stack, often in Mute.

## Layout

A single centred container: 1200 px wide at desktop with 32 px gutters (16 px below 768 px),
2300 px wide with 48 px gutters at ≥1600 px ("wide"). Three breakpoints only: below 768 px
everything stacks and the header becomes two static rows; 768–1599 px is the desktop
arrangement; at ≥1600 px wide arrangements switch on (side-by-side columns, vertical timelines,
48/52 px page titles).

Tables are 12-column CSS grids with a Label-style header row on Canvas Soft and 1 px Hairline Soft
row dividers; a selected row gets a 2 px Sheen Cyan left edge and a `rgba(34,193,220,.06)` fill.
Cards sit in fluid wrap grids (`flex: 1 1 300px`). Spacing follows a 4 px base; the working steps
are 8, 12, 16, 24, 32 and 48 px, with 24 px inside cards and 56 px between page sections. Reading
widths cap at 34 rem (prose) and 60 rem (a holding panel).

## Elevation & Depth

Flat by default. Every surface is a hairline plane on the same dark ground; the page carries one
ambient layer (a radial cyan glow top-centre at 14%, a faint emerald glow bottom-right at 10%, a
24 px dot grid at 4.5% white) and the nav is frosted (`rgba(16,16,16,.72)` + `blur(14px)`). There
are no drop shadows at rest. Light appears only as a response to state: a card hovered gets a
cyan border and a 28 px cyan glow at 12%; the primary button carries a 22 px cyan glow at 25–30%
because it is the thing to press; the orchestrator orb glows because it is alive.

### Shadow Vocabulary

- **Glow Cyan** (`box-shadow: 0 0 22px rgba(34,193,220,.3)`): the primary "Run" button and the orb's disc.
- **Glow Soft** (`box-shadow: 0 0 22px rgba(34,193,220,.25)`): other primary buttons.
- **Card Hover** (`border-color: rgba(34,193,220,.45); box-shadow: 0 0 28px rgba(34,193,220,.12)`): any card under the pointer.

### Named Rules

**The Light as State Rule.** Nothing glows at rest except the one primary action and the orb.
Glow means "live", "hovered" or "press me"; a decorative glow is a lapse.

## Shapes

Small radii throughout: 4 px for tiny chips, 6 px for buttons, inputs and code chips, 8 px for
cards and panels; 9999 px pills are reserved for status, filters and avatar discs. Borders are
1 px Hairline; the only thicker line is the 2 px Sheen Cyan underline of the active nav item and
the 2 px left edge of a selected row. The brand's one organic form is the magpie on a perfect
white disc.

## Components

### Buttons

- **Shape:** 6 px radius, semibold 14/20 (16/24 for the Run button), 10 × 16 px padding (8 × 16
  in dense rows).
- **Primary:** Accent White on Canvas text, Glow Soft; hover Paper Tint. The Run button is the
  only coloured gradient fill (`linear-gradient(135deg, #ffffff, #d6f5f7 60%, #a8e8ee)`) with Glow Cyan.
- **Outline:** Canvas fill, 1 px Hairline border, Ink text; hover border Ghost.
- **Soft:** as Outline on Canvas Soft (toolbar actions such as "Attach files").
- **Ghost:** no border, Ghost text; hover Ink Strong. For secondary actions beside a primary.
- **Disabled:** 50% opacity, no glow, `cursor: not-allowed`, always with a stated reason nearby.
- **Focus:** a 2 px Ink Strong ring at 2 px offset, instant (no transition).

### Chips and Pills

- **Status pill:** 1 px border and text in the status colour (cyan running, white waiting, mute
  idle/queued, emerald done, red failed, amber needs-auth), 6 px dot, Caption 500, 2 × 10 px,
  pill radius. The dot blinks only when running and only for users who have not asked for less motion.
- **Filter pill:** Body Small, 4 × 12 px, Hairline border; selected = Accent White fill with
  Canvas text.
- **Mono chip:** Canvas Soft, Code text, 6 px radius, 2 × 8 px — tool names, scopes, models.

### Cards / Containers

- **Card:** Canvas Raised → Canvas gradient, 1 px Hairline, 8 px radius, 24 px padding, no shadow;
  hover per Card Hover. Content cards only — never nested.
- **Panel:** `linear-gradient(180deg, #141a1a, #141414)` with a 1 px cyan border at 28%: the
  prompt window, the connect panel, holding states.
- **Stat strip:** three mono 20/28 550 values over Caption labels, divided by 1 px Hairline Soft
  verticals and framed by Hairline Soft rules above and below; flat on the card surface, never
  boxed (no card inside a card).

### Inputs / Fields

- **Style:** Canvas Soft fill, 1 px Hairline, 6 px radius, 10 × 16 px padding, Body Small, Mute
  placeholder; textareas resize vertically.
- **Focus:** border Ink Strong, no outline; selection is cyan at 35%; caret is Sheen Cyan.
- **Code block:** Canvas, 1 px Hairline, 8 px radius, 16 px padding, Code text, with a Ghost "Copy" control.

### Navigation

Frosted sticky header with a Sheen Cyan hairline (28%) beneath: logo disc (36 px) + wordmark
left, four Body Small links centred, a live pill and an outline Settings button right. Active
link: Ink Strong, 600, 2 px Sheen Cyan underline; hover: Ink Strong. On phones the header is two
static rows. Footer: Body Small left, mono version · region right.

### Signature Components

- **Eyebrow:** the tracked uppercase line with the sheen gradient clipped to its letters — the
  brand's one flourish, above every page title.
- **Logo disc:** the dark magpie with white plumage and sheen wing on a white 36 px disc; at the
  centre of the orchestrator orb at 68 px.
- **Live pill:** hairline pill with a blinking white dot and "N agents active"; grey dot and
  "Status unavailable" when the database cannot be read.
- **Orchestrator orb:** three translucent cyan rings, a dashed orbit (16 s) and a counter-rotating
  conic arc (26 s) around the disc, on a radially masked cyan grid — the only orchestrated motion
  in the product, and still only for users who have not asked for reduced motion.

## Do's and Don'ts

### Do:

- **Do** make white mean action: primary buttons, the disc, the live dot — nothing decorative.
- **Do** keep the sheen to lines, text, glows and the wing; signal, never fill.
- **Do** set ids, counts, models and paths in mono, usually Mute, often `select-all`.
- **Do** give every disabled control a visible reason, every empty state a real next step, and every error its remedy.
- **Do** hold prose to ≈72 characters with rem widths (34 rem at 16 px, 31 rem at 14 px).
- **Do** opt motion in with `motion-safe:`; keep state transitions at 150 ms.

### Don't:

- **Don't** introduce a light theme, a blue, a purple or any second accent.
- **Don't** add drop shadows at rest or glow anything that is not live, hovered or the primary action.
- **Don't** use the bird metaphor in status pills, fact lines, table cells or Settings rows.
- **Don't** nest cards, widen radii past 8 px (pills excepted), or use `ch` for measure.
- **Don't** let gradient text appear anywhere but the eyebrow; a single short eyebrow word renders solid.

---
version: 1
slug: "app-shell-tools-page-tsx"
primary_target: "app/(shell)/tools/page.tsx"
related_targets: []
---

# Surface brief: /tools (beaks & claws)

Scope: the Tools screen — connect panel, tool grid, per-card management — spec §3.5, artboards Tools / ToolsWide. Visitor mode: Operate.
Audience: the operator (PRODUCT.md). Job: see every tool the flock can reach and its health at a glance, connect a new MCP server, re-authorise one that lapsed, test or remove one. Constraints: desktop app; the database may be unavailable (shared UnavailableState); precise lines use plain nouns; no OAuth sign-in yet on desktop (tokens are pasted), recorded in decisions.
Memorable moment: pasting a server's JSON, pressing "Connect & test", and watching the card land in the grid with its real status and the tool names it actually exposes.
Unresolved: `calls · 24h` comes from stored stats (demo values until the run engine in PR 5 counts real calls).

## Direction contract

THESIS: a registry you can read like a wall of badges — every integration as one card with its status, reach and who holds it — and one inline panel for connecting, never a modal. It refuses the settings-table default (rows of URLs) and the wizard default (multi-step connect flows).

OWN-WORLD: the Night Aviary as built — near-black canvas, hairline card planes with the cyan hover glow, mono for glyphs, scopes and counts; the sheen only on the Connected pill and the panel's cyan hairline; amber only for "Needs auth", red only for "Error"; white for the one primary action ("+ Connect tool"). Nothing new is introduced; the artboard pins the composition.

STORY: the operator scans the grid, spots the amber card, re-authorises it in place, and understands what every bird can touch and how much it has been used — then connects a new server by pasting its JSON and sees it tested and listed in one press.

FIRST VIEWPORT: eyebrow BEAKS & CLAWS, h1 Tools, one-line description; right: search field and the white "+ Connect tool". When toggled, the Connect panel sits directly under the head: cyan-hairline panel, "Connect an MCP server", a JSON editor pre-filled with the example, Cancel and "Connect & test". Below: the card grid, 3-up (4-up ≥1600 px): glyph tile 40 px, name 16/600, kind caption, status pill; description; mono scope chips; a hairline-topped footer with granted-agent avatars left and `N calls · 24h` right, plus a quiet Manage control that unfolds Test again / Re-authorise / Remove inside the card.

FORM: the artboard's card grid with inline panel, position 1 of 1 (composition pinned by the design canvas). seed: none — waived: the hand-off spec names the design canvas as the source of truth and pins this screen's composition in the Tools / ToolsWide artboards (spec §3.5), so no concept roll was run.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

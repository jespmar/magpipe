---
version: 1
slug: "app-shell-memory-page-tsx"
primary_target: "app/(shell)/memory/page.tsx"
related_targets: []
---

# Surface brief: /memory (the nest)

Scope: the Memory screen — namespace nav with nest health, the entries table, the detail card, the add/edit dialog — spec §3.6, artboards Memory / MemoryWide. Visitor mode: Operate.
Audience: the operator (PRODUCT.md). Job: see what the flock knows, by namespace; judge whether a fact is current (confidence, source, when verified, expiry); correct or forget it; add one by hand. Constraints: desktop app; the database may be unavailable (shared UnavailableState); precise lines use plain nouns; there is no nightly job on desktop, so stale and expired are computed on read (decisions D14).
Memorable moment: picking a namespace and reading the nest like a ledger — key, value, who wrote it, when — then opening one fact and seeing its whole provenance, raw JSON included.
Unresolved: read-by lists come from the seed until the run engine (PR 5) records reads.

## Direction contract

THESIS: a ledger, not a notes app. Three columns — what kinds of knowledge exist (with health), the entries of one kind, one entry in full — so the operator never loses the frame. It refuses the card-grid default for facts and the chat-like list; the only modal is the add/edit dialog, because a fact has five fields that need protected focus.

OWN-WORLD: the Night Aviary as built — near-black canvas, hairline card planes, mono for keys, numbers and raw JSON; the sheen only as the selected row's 2 px cyan edge and the verified bar's white→cyan fill; amber only for stale, red only for conflicts; white for the one primary action ("+ Add fact"). Nothing new is introduced; the artboard pins the composition.

STORY: the operator lands on the whole nest, scans health (how much is stale, what conflicts), narrows to a namespace, picks a row, and trusts or corrects what a bird learned — then adds a decision of their own so every bird reads it before it flies.

FIRST VIEWPORT: eyebrow THE NEST, h1 Memory, one-line description; right: search field (260 px) and the white "+ Add fact". Below, three columns: left aside (240–300 px; 340 wide) with the Namespaces card (All plus each namespace with its mono count, selected row cyan-edged, a quiet "+ New namespace") and the Nest health card (Facts, Stale amber, Conflicts red, the 4 px verified bar, its caption); centre the entries table (Key mono · Value · By avatar · Updated mono, 12 columns, selected row cyan-edged); right (below the table under 1600 px) the detail card: mono `ns / key`, the value at 18/600, Edit and Forget, the facts row (Confidence, Source, Read by, Expires, Verified), and the raw JSON with Copy.

FORM: the artboard's three-column ledger, position 1 of 1 (composition pinned by the design canvas). seed: none — waived: the hand-off spec names the design canvas as the source of truth and pins this screen's composition in the Memory / MemoryWide artboards (spec §3.6), so no concept roll was run.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

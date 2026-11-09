---
version: 1
slug: "app-shell-agents-page-tsx"
primary_target: "app/(shell)/agents/page.tsx"
related_targets: []
---

# Surface brief: /agents (the flock)

Scope: the Agents screen — list, detail, editor — spec §3.3, artboards Agents / AgentsWide. Visitor mode: Operate.
Audience: the operator (PRODUCT.md): one person today, a small team later. Job: see every agent at a glance, inspect one (role, prompt, tools, memory scope, how it has flown), pause or edit it, add a new one. Constraints: desktop app; database may be unavailable (shared UnavailableState); precise lines use plain nouns.
Memorable moment: picking a row and the whole right-hand panel answering — prompt, grants, numbers — without leaving the list.
Unresolved: per-agent stats (runs·7d, success, avg tokens) come from whatever runs exist and show "—" when there are none; the run engine (PR 5) will make them live.

## Direction contract

THESIS: a roster, not a dashboard. One list of birds on the left, one bird in full on the right; the task is "find, inspect, adjust", so the page refuses the card-grid default and the modal-first default — the only modal is the editor, because editing needs protected focus.

OWN-WORLD: the Night Aviary as already built — near-black canvas, hairline card planes, mono for ids/models/counts, the sheen only as the selected row's 2 px cyan edge and the running status; white for the one primary action ("+ Add a bird"). Nothing new is introduced; the artboard pins the composition.

STORY: the operator lands, reads four rows, filters or searches, selects one, and understands in seconds what that agent is for, what it may touch, and how it has been doing; Edit opens the editor over the page and returns them exactly where they were.

FIRST VIEWPORT: eyebrow THE FLOCK, h1 Agents, one-line description; right: search field and the white "+ Add a bird". Below: four filter pills with counts. Then two columns — list (header row Agent · Status · Model · Runs 7d; rows with avatar disc, name/role, status pill, mono model, mono count; selected row cyan-edged) at flex 1 1 520px, detail card at flex 1 1 380px (wide: 1200px / 680px) with name, role, Edit + Pause, description, three stat tiles, tool chips, memory scope, system prompt in a code block with Copy.

FORM: the artboard's two-column roster, position 1 of 1 (composition pinned by the design canvas). seed: none (composition pinned by the Agents artboard).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

---
version: 1
slug: "app-shell-home-page-tsx"
primary_target: "app/(shell)/(home)/page.tsx"
related_targets: []
---

# Surface brief: / (Home)

Scope: the Home screen — the flock on duty (agent cards with live status), the nest (the orchestrator orb with the day's counters), the flight log at wide widths, and the prompt window that starts a run — spec §3.2, artboards Main / Wide. Visitor mode: Operate.
Audience: the operator (PRODUCT.md). Job: hand Magpipe a task, with files when needed, and see at a glance who is flying, what the orchestrator is doing today and the live trail of the latest flight. Constraints: desktop app; the database may be unavailable (shared UnavailableState); precise lines use plain nouns; without model credentials a run fails fast and says why in its trail (D15); uploads are 25 MB × 10, stored in the data folder (D3).
Memorable moment: typing the task while the orb turns above it, pressing ⌘ + Enter, and landing on the flight as its first events arrive.
Unresolved: `/runs/[id]` is still its holding state until PR 7, so the landing after Run shows the flight's facts, not yet its path and log.

## Direction contract

THESIS: a cockpit, not a dashboard. One prompt is the product; everything above it is the state of the flock that will answer it. It refuses the KPI-tile grid and the chat transcript: the counters are three mono numbers under a living orb, the agents are four cards that say what each bird is doing right now, and the log streams only where there is room for it (≥1600 px).

OWN-WORLD: the Night Aviary as built — near-black canvas, hairline card planes, mono for ids, models, tokens and times; the sheen as the eyebrow gradient, the orb's rings and arc, the white→cyan progress bar; white for the disc at the orb's heart and the Run button, which alone glows. The orb is the product's one orchestrated motion, opt-in through motion-safe. Nothing new is introduced; the artboards pin the composition.

STORY: the operator lands on the flock (who is idle, who is flying what), reads the nest's pulse (agents flying, runs today, queued, tokens), glances at the live trail when the screen is wide, then describes a task, attaches files and runs it — and is taken straight to the flight.

FIRST VIEWPORT: eyebrow THE FLOCK, h1 Birds on the wire, ghost "+ Add a bird" right. Below, the agent cards in two columns (avatar, name, role, status pill, current or last task, 4 px progress track, model chip, tokens · elapsed). Then the nest between dashed rules: the 260 px orb (400 at wide), eyebrow THE NEST, h2 "Magpipe is flying N agents", one sentence, three centred mono counters. Then the prompt panel: label ASK MAGPIPE, four-row textarea, attachment chips, "Attach files", the 25 MB hint, "⌘ + Enter" and the white Run. At ≥1600 px the flock, the nest (dashed left and right) and the flight log sit in one row, the prompt full-width under them.

FORM: the artboards' three-zone stack, position 1 of 1 (composition pinned by the design canvas). seed: none — waived: the hand-off spec names the design canvas as the source of truth and pins this screen's composition in the Main / Wide artboards (spec §3.2), so no concept roll was run.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

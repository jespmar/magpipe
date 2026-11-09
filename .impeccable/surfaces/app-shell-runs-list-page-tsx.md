---
version: 1
slug: "app-shell-runs-list-page-tsx"
primary_target: "app/(shell)/runs/(list)/page.tsx"
related_targets: ["app/(shell)/runs/[id]/page.tsx"]
---

# Surface brief: /runs and /runs/[id] (flights)

Scope: the Runs screens — the flight table with its stats strip, filter pills and search, the selected flight's path with Open log / Re-fly / Cancel, and the flight page with the streaming log, the merged output and the files produced — spec §3.4, artboards Runs / RunsWide. Visitor mode: Operate.
Audience: the operator (PRODUCT.md). Job: find a flight (by task, id, bird or status), see at once how it went (status, duration, tokens, who flew), follow a live one step by step, read the result, and fly it again or stop it. Constraints: desktop app; the database may be unavailable (shared UnavailableState); precise lines use plain nouns (a run is "running", a status pill says done / failed); without model credentials a flight fails fast and its log says why (D15); the trail streams over the SSE route and merges with the server replay by sequence (D16).
Memorable moment: picking a row and watching its path light up card by card — the live step cyan, finished ones emerald — then opening the log and reading the merged result under it.
Unresolved: artifacts are listed by name and path (no download route yet); streaming tokens inside a step are not shown (events are per message and tool call, D15).

## Direction contract

THESIS: a flight recorder, not a job queue. The table is a ledger of what the flock did; selecting a row shows the plan as a chain of step cards that reads left to right (top to bottom at wide), and the flight page puts the trail and the result side by side with that chain. It refuses the status-coloured row backgrounds and the progress-ring dashboard: colour sits only on the dot and the live card's edge.

OWN-WORLD: the Night Aviary as built — hairline card planes, the 12-column grid with the Label header, mono for ids, durations, tokens, times and step meta; the sheen as the selected row's 2 px cyan edge and the live step's cyan border and fill; emerald only for done, red only for failed, mute for todo and skipped; white for the one primary action ("New run"), with the Run-style glow nowhere else. Nothing new is introduced; the artboards pin the composition.

STORY: the operator lands on the ledger, reads the day's numbers, narrows with a pill or a search, picks a flight and sees its path; opens the log to follow or audit it, reads the result, and re-flies or cancels from the same place.

FIRST VIEWPORT: eyebrow FLIGHTS, h1 Runs, one-line description; right: the search field (260 px) and the white "New run" → `/`. Below, four stat tiles (runs today · succeeded 7d · median duration · spend today), the filter pills (All · Running · Done · Failed · Queued, with counts), then the table — Flight (mono) · Task · Birds (24 px avatars) · Status · Duration · Tokens · Started — in a card that scrolls sideways under 900 px, the selected row cyan-edged. Under it the selected flight's card: id, task, Open log · Re-fly (· Cancel while live), and the horizontal chain of 196 px step cards (AGENT · what · meta) joined by arrows. At ≥1600 px the table and the flight card share a row and the chain runs vertically. `/runs/[id]`: the same head facts (status, id, took, tokens, started), then the path, the streaming log (`time · agent · text`, "streaming" pulse, follows unless hovered) and the result (markdown) with the files produced.

FORM: the artboards' ledger + chain, position 1 of 1 (composition pinned by the design canvas). seed: none — waived: the hand-off spec names the design canvas as the source of truth and pins this screen's composition in the Runs / RunsWide artboards (spec §3.4), so no concept roll was run.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

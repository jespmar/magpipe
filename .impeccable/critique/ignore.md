# Critique ignore list

Detector findings that are intentional for Magpipe. A critique drops matching findings; it still
reports anything else about the same elements. Reasons are in `docs/decisions.md` D12.

- `kicker-above-heading` — the eyebrow above each page title is part of the design canvas (spec §4).
- `hero-eyebrow-chip` — same element as above, as the static HTML scan names it.
- `gradient-text` — the eyebrow's sheen gradient is the brand's text gradient (spec §4); single short words render solid.
- `overused-font` — Inter is the one family by spec; no second face on an Operate surface.
- `dark-glow` — the cyan glow under the white primary button (and the Run button) is the design canvas's "sheen signals" light: `0 0 22px rgba(34,193,220,.25)` on the Agents artboard, DESIGN.md's Light as State rule. Glow never appears on cards at rest.

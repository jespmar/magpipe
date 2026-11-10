# Critique ignore list

Detector findings that are intentional for Magpipe. A critique drops matching findings; it still
reports anything else about the same elements. Reasons are in `docs/decisions.md` D12 and D20.

- `overused-font` — two faces by design: Geist for the page title (display sizes), Inter for the
  rest, mono for data. Arc's type rules (`.claude/skills/arc/design.md`).

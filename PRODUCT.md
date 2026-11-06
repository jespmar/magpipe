# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The desktop app is an Electron window around the web UI; the design language is web, not native.

## Users

One operator today: the developer building Magpipe, running it on their own machine. A small
team sharing one workspace is the expected next step, so nothing may assume a single user
forever (every agent, run and memory entry already records who did it).

Situation and job: the operator has a multi-step task they would rather delegate than do by
hand. They describe it once, attach files if needed, let the agents work, and check the result
and the trail before trusting it. The kind of work (domain, client context) is deliberately
**not established**: the demo data in the design is illustrative only.

## Product Purpose

Magpipe is an agent orchestrator. A task typed into one prompt is split into subtasks by the
orchestrator, routed to a small fleet of AI agents, run in parallel where possible, merged into
one result, and the durable learnings are written into shared memory. Success is a finished
task with a readable account of who did what, when, with which tool, at what cost, and a memory
that makes the next task cheaper.

## Positioning

Three mechanisms are the claim and must survive even when screen space is tight:

- **Observability.** Every run is a step-by-step trail: agent, action, time, tool, tokens, cost.
  Nothing an agent does is hidden from the operator.
- **Shared memory.** Agents keep what they learn, with a confidence score, a source and an
  expiry, so no agent re-reads the same documentation twice and decisions persist across runs.
- **Orchestration.** The operator describes the outcome; the orchestrator chooses the agents,
  splits and parallelises the work and merges the result. There is no workflow to draw.

Scoped tool and memory grants per agent are a capability the product relies on, not its
headline.

## Operating Context

- Runs locally as a self-contained desktop app (macOS, Windows, Linux): one installer, no
  accounts, no database server, no Docker. The only outbound calls are the model provider
  (Anthropic by default; model per agent is configurable) and the MCP tool servers the
  operator connects.
- Working session: type a task in the prompt (optionally attach PDF, CSV, images or code, up to
  25 MB per file, 10 files), run it, watch the live flight log, read the merged output and any
  produced files; re-run a past task with the same input; cancel a running one.
- Agents reach the world through tools: MCP servers registered in the Tools screen, plus
  built-ins (web search and fetch, attached files, a sandboxed workspace file system and shell,
  memory read/write). Each agent only has the tools, scopes and memory namespaces it was
  granted.
- Everything lives in the app's data folder (embedded Postgres); backups are a folder copy.
- Default workspace: four starter agents — Researcher (gathers context), Coder (writes code),
  Reviewer (checks diffs and tests), Operator (deploys and monitors) — and five memory
  namespaces: Rate limits, Facts, Decisions, Incidents, Tenants. All editable.

## Capabilities and Constraints

- Entities: agents, runs (plan of steps, status, usage, output), run events, tools, memory
  entries in namespaces, one settings record. Full data model in `docs/spec.md` §6 and
  `lib/schemas`.
- Agents are configured by name, role, description, model, system prompt, tool grants with
  scopes, memory scope (read/write per namespace) and limits (max tokens, max steps, timeout).
- Memory entries carry key, value, confidence (0–1), source, author, readers, expiry and a
  history; entries unverified for 30 days are flagged stale and conflicting writes are flagged.
- Cost is displayed, never charged; a daily spend cap is a setting.
- Reviewer may approve pull requests when tests are green; **humans merge** — no agent gets a
  merge permission (`docs/decisions.md` D7).
- v1 non-goals: multi-user organisations or roles beyond one workspace; billing; a visual
  workflow builder.
- Terminology rule: bird vocabulary is **UI copy only**. Code, tables and routes say agent,
  run, step, tool, memory. On screen: the flock (agents), bird (agent), flight (run), flight
  log (run events), the nest (memory), shiny bit (memory entry), beaks & claws (tools).
- Undecided: how a team shares a workspace (sign-in exists for a hosted mode but is not planned
  for desktop); whether a hosted deployment will exist; where sandboxed shell commands run
  beyond the v1 allow-list.

## Brand Commitments

- Name: **Magpipe**, subtitle "agent orchestrator". Logo: a dark magpie with white plumage and a
  blue-green wing, `public/brand/magpipe-magpie-logo-03.svg`, shown on a white disc.
- The design canvas is the binding visual source of truth (link at the top of `docs/spec.md`;
  tokens in `docs/spec.md` §4 and `app/globals.css`). Dark interface only.
- Voice, as observed in the design copy: short, plain sentences; the bird metaphor appears
  lightly in headings, eyebrows, loading and empty states ("Birds on the wire", "Waking the
  flock…", "This bird flew off"), never in labels that must be precise (status, model, tokens,
  cost).

## Evidence on Hand

- The design canvas (artboards Main, Wide, Agents, Runs, Tools, Memory, their Wide variants,
  Logos) and the written spec `docs/spec.md`.
- The logo file above and an app icon derived from it (`build/icon.png`).
- **The demo data is illustrative only.** The tools (Visma.net, Shopify, Younium, GitHub,
  Inngest, MongoDB Atlas, Vercel, Slack), memory entries, tenants, incidents and finished runs
  shipped as demo data describe no real customer, integration or user. Do not present them as
  facts about the product or its users, and do not derive the product's domain from them.
- No real customers, testimonials, benchmarks or usage numbers exist. Do not invent any.

## Product Principles

1. **Nothing happens unseen.** Every action an agent takes is recorded and readable, with its
   cost, before the operator is asked to trust the result.
2. **The nest remembers.** Learnings are durable, attributed, scored and scoped; the product
   gets cheaper to use the more it is used.
3. **The operator stays in charge.** Agents reach only what they were granted, humans merge, and
   spend is visible and capped.
4. **Plain words in code, bird words on screen.** The metaphor is for people; the system
   underneath uses the ordinary names.
5. **Works alone on one machine.** First launch is a usable workspace; nothing requires an
   account or a server.

## Accessibility & Inclusion

Spec §5 sets the floor: real `<button>` and `<a>` elements, `aria-label` on icon-only
controls, all text at least 4.5:1 against the `#101010` canvas, a visible 2 px white focus ring,
and animations that respect `prefers-reduced-motion`. No product-specific user need beyond
that has been established.

/**
 * Row shapes for every table (docs/spec.md §6), as zod schemas. See docs/decisions.md D1.
 *
 * These are the source of truth for the TypeScript types (`z.infer`) and for API body
 * validation. The Drizzle tables in `lib/db/schema.ts` must produce exactly these shapes —
 * `lib/db/schema-check.ts` fails the typecheck if the two drift apart.
 *
 * Conventions:
 * - Ids are prefixed strings (`agt_…`, D2).
 * - Top-level timestamps are `Date` (timestamptz columns). Timestamps nested inside JSON
 *   columns are ISO strings, because that is what JSON stores.
 * - Optional top-level fields are `null`, never `undefined` (they are nullable columns).
 *
 * Bird vocabulary is UI copy only — nothing in here says "flight" or "nest" except the
 * human-readable `displayId` format.
 */
import { z } from 'zod';

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-z]+$`));
const isoDate = z.iso.datetime();

export const agentId = id('agt');
export const toolId = id('tool');
export const runId = id('run');
export const eventId = id('evt');
export const stepId = z.string().min(1);
export const memoryId = id('mem');
export const issueId = id('iss');

export const slug = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lower-case letters, digits and dashes');

/** Memory namespace key, e.g. `rate-limits`. */
export const namespaceKey = slug;

export const usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

// ─── agents ────────────────────────────────────────────────────────────────

export const agentStatuses = ['idle', 'running', 'waiting', 'paused'] as const;
export const agentStatus = z.enum(agentStatuses);

export const builtinTools = ['web.search', 'web.fetch', 'files.read'] as const;

export const toolGrant = z.object({ toolId, scopes: z.array(z.string()) });
export const memoryScope = z.object({ read: z.array(namespaceKey), write: z.array(namespaceKey) });
export const agentLimits = z.object({
  maxTokens: z.number().int().positive(),
  maxSteps: z.number().int().positive(),
  timeoutSec: z.number().int().positive(),
});

export const agent = z.object({
  id: agentId,
  slug,
  name: z.string().min(1).max(64),
  role: z.string().max(120),
  description: z.string().max(2000),
  initials: z.string().min(1).max(3),
  model: z.string().min(1),
  systemPrompt: z.string().max(20_000),
  /** Registry tools (MCP servers, Workspace FS) granted to this agent. */
  tools: z.array(toolGrant),
  /** Core built-ins that are not registry entries. `memory.*` is governed by `memoryScope`. */
  builtins: z.array(z.enum(builtinTools)),
  memoryScope,
  limits: agentLimits,
  /** After a step by this agent, the steps that depend on it wait for the operator (D30). */
  pauseAfter: z.boolean(),
  /** How many times this agent's steps may send the work they review back (D31); 0 = never. */
  sendBackRounds: z.number().int().min(0).max(5),
  /** Runs only from a template (a factory stage, D37): the orchestrator leaves it out of its plans. */
  templateOnly: z.boolean(),
  status: agentStatus,
  createdAt: z.date(),
  updatedAt: z.date(),
});

// ─── runs ──────────────────────────────────────────────────────────────────

/** The longest document a step may keep (D37): a spec, with room to spare. */
export const DOCUMENT_CAP = 40_000;

/**
 * One goal split from a spec (D39): a piece of work that can be built and tested on its own.
 * `criteria` are the spec's acceptance-criterion numbers it covers; `dependsOn` are other goals'
 * keys. Recorded by the Goal Builder through the `record_goals` tool and checked by Magpipe.
 */
export const goal = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'A goal key is lowercase letters, digits and hyphens.'),
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(2000),
  criteria: z.array(z.number().int().positive()).min(1),
  files: z.array(z.string().trim().min(1).max(300)).min(1).max(40),
  dependsOn: z.array(z.string()).max(12),
});
export type Goal = z.infer<typeof goal>;
export const MAX_GOALS = 12;

/** What an action step does (D38); the engine runs it in `lib/engine/actions.ts`. */
export const stepActions = ['file_issue', 'read_issue', 'file_goals', 'finish_goal'] as const;
export type StepAction = (typeof stepActions)[number];

export const stepStatus = z.enum(['todo', 'live', 'done', 'failed', 'skipped']);

/**
 * What a step did in bound repositories (D29), recorded by the engine from the tool calls
 * themselves, never from the model's account. Paths are relative to the git work tree; `repo` is
 * the repository tool's name.
 */
export const stepWork = z.object({
  files: z.array(
    z.object({ repo: z.string(), path: z.string(), change: z.enum(['created', 'updated']) }),
  ),
  branches: z.array(z.object({ repo: z.string(), name: z.string(), created: z.boolean() })),
  commits: z.array(
    z.object({ repo: z.string(), branch: z.string(), sha: z.string(), message: z.string() }),
  ),
  checks: z.array(
    z.object({
      repo: z.string(),
      script: z.string(),
      exit: z.number().int().nullable(),
      seconds: z.number().nonnegative(),
      timedOut: z.boolean(),
    }),
  ),
});

/** One planned unit of work, stored in `runs.plan`. `agentId: null` = the orchestrator. */
export const step = z.object({
  id: stepId,
  agentId: agentId.nullable(),
  title: z.string().min(1),
  instructions: z.string().optional(),
  dependsOn: z.array(stepId),
  optional: z.boolean().optional(),
  status: stepStatus,
  startedAt: isoDate.optional(),
  finishedAt: isoDate.optional(),
  usage: usage.optional(),
  result: z.object({ summary: z.string().max(1000) }).optional(),
  /**
   * The step's written result is a document kept whole (a spec, D37), not only the summary: the
   * steps after it read all of it, and the run's answer is built from it.
   */
  writesDocument: z.boolean().optional(),
  /**
   * The document as it stands: written by the step, or the draft it starts from (the last round's,
   * or the run it follows up). Kept when the step is sent back, so the next round revises it.
   */
  document: z.string().max(DOCUMENT_CAP).optional(),
  /**
   * The step runs once everything it depends on has settled, failed or skipped included, so it
   * can report how a run ended (a goal's finish, D40).
   */
  always: z.boolean().optional(),
  /** The steps a judging step sends work back to (D40); unset, it sends back to all it reviews. */
  sendBackTo: z.array(stepId).optional(),
  /** The step judges the work before it (a review, D38): its result opens with a verdict. */
  judges: z.boolean().optional(),
  /** The step splits a spec into goals with the `record_goals` tool (D39). */
  recordsGoals: z.boolean().optional(),
  /** The goals it recorded, checked by Magpipe; rendered as the step's document. */
  goals: z.array(goal).max(MAX_GOALS).optional(),
  /** The verdict Magpipe read from a judging step's result (D38). */
  verdict: z.enum(['pass', 'fail']).optional(),
  /**
   * Work Magpipe does itself, with no model (D38): `file_issue` files the spec in the tracker.
   * Such a step has `agentId: null` and runs in the DAG like any other.
   */
  action: z.enum(stepActions).optional(),
  /**
   * Set when the step changed or ran something in a bound repository, done or failed. Saved as
   * each item is recorded, so a restart keeps what the step had done (D33).
   */
  work: stepWork.optional(),
  /** When the operator let the steps after this one go on (D30), and what they added. */
  approvedAt: isoDate.optional(),
  approvalNote: z.string().max(2000).optional(),
  /** Which attempt this is: 2 and up after a reviewing step sent the work back (D31). */
  round: z.number().int().min(1).optional(),
  /** Findings this step sent back to the steps it depends on (D31). */
  sentBack: z.string().max(4000).optional(),
  /** What the step must address on this round: the findings that sent it back (D31). */
  feedback: z.string().max(6000).optional(),
  /** How many times a restart interrupted this step while it was live (D33). */
  restarts: z.number().int().positive().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export const runStatuses = ['queued', 'running', 'waiting', 'done', 'failed', 'cancelled'] as const;
export const runStatus = z.enum(runStatuses);

export const attachment = z.object({
  /** Where the file lives: a path under the data dir on desktop, a blob URL when hosted. */
  blobUrl: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  mime: z.string(),
});

/** The factory's templates (lib/factory.ts): a run from one starts with its preset plan. */
export const runTemplates = ['spec', 'goals', 'build'] as const;
export type RunTemplate = (typeof runTemplates)[number];

export const runInput = z.object({
  text: z.string().min(1),
  attachments: z.array(attachment),
  /** Set when the run started from a factory template's plan (D37); a re-fly does the same. */
  template: z.enum(runTemplates).optional(),
  /** The tracker issue a goals or build run works on (D39, D40): the spec, or the goal. */
  issueId: issueId.optional(),
});
/**
 * Something a run produced. An uploaded or hosted file has a `blobUrl`; a file a step created or
 * changed, or a branch it committed to, in a bound repository has `kind`, `repo` and `detail`
 * (D29).
 */
export const runArtifact = z.object({
  name: z.string(),
  blobUrl: z.string().optional(),
  kind: z.enum(['file', 'branch']).optional(),
  repo: z.string().optional(),
  detail: z.string().optional(),
});

export const runOutput = z.object({
  markdown: z.string(),
  artifacts: z.array(runArtifact),
});

export const run = z.object({
  id: runId,
  displayId: z.string().regex(/^flight_[0-9a-z]+$/),
  input: runInput,
  status: runStatus,
  plan: z.array(step),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  usage,
  output: runOutput.nullable(),
  /** The run this one continues (a follow-up) or repeats (a re-fly). */
  parentRunId: runId.nullable(),
  /** Set when the operator closed its card on Home; the Runs screen still lists it. */
  dismissedAt: z.date().nullable(),
  createdBy: z.string(),
  createdAt: z.date(),
});

export const runEventKinds = [
  'plan',
  'message',
  'tool_call',
  'tool_result',
  'memory_write',
  'error',
  'done',
] as const;
export const runEventKind = z.enum(runEventKinds);

export const runEvent = z.object({
  id: eventId,
  /** Monotonic across all events — the SSE stream's resume cursor. */
  seq: z.number().int().positive(),
  runId,
  ts: z.date(),
  stepId: stepId.nullable(),
  /** null = the orchestrator */
  agentId: agentId.nullable(),
  kind: runEventKind,
  text: z.string(),
  payload: z.unknown(),
});

/** A run event before the database assigns `seq`. */
export const newRunEvent = runEvent.omit({ seq: true });

// ─── tools ─────────────────────────────────────────────────────────────────

export const toolStatuses = ['connected', 'needs_auth', 'error'] as const;
export const toolStatus = z.enum(toolStatuses);

export const toolAuth = z.object({
  type: z.enum(['none', 'bearer', 'oauth2', 'apikey']),
  secretRef: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});
export const toolStats = z.object({
  calls24h: z.number().int().nonnegative(),
  lastCallAt: isoDate.nullable(),
  lastError: z.string().optional(),
});

/** A bound repository (D27): the folder agents work in and the package scripts they may run. */
export const repositoryConfig = z.object({
  /** Absolute path of a folder inside a git work tree. */
  path: z.string().min(1),
  scripts: z.array(z.string().regex(/^[A-Za-z0-9][\w:.-]{0,63}$/, 'Not a script name')).max(20),
  /** How long one `run` may take before it is stopped. */
  timeoutSec: z.number().int().min(10).max(3600),
});

export const tool = z.object({
  id: toolId,
  slug,
  name: z.string().min(1),
  /** UI-only: two-letter tile on the ToolCard, e.g. `VN`. */
  glyph: z.string().min(1).max(3),
  kind: z.enum(['mcp', 'builtin', 'repository']),
  /** UI-only: the part after "MCP ·", e.g. `ERP`. */
  category: z.string(),
  description: z.string(),
  transport: z.enum(['http', 'stdio', 'builtin', 'repository']),
  url: z.url().nullable(),
  command: z.string().nullable(),
  /** Set for a bound repository, null for every other tool. */
  repository: repositoryConfig.nullable(),
  auth: toolAuth,
  status: toolStatus,
  /** Tool names discovered from the server (or declared for built-ins). */
  scopes: z.array(z.string()),
  grantedAgents: z.array(agentId),
  stats: toolStats,
  createdAt: z.date(),
  updatedAt: z.date(),
});

// ─── secrets ───────────────────────────────────────────────────────────────

export const secretId = id('sec');

/** A tool credential at rest: AES-256-GCM under MAGPIPE_SECRET_KEY (lib/secrets.ts), base64 fields. */
export const secret = z.object({
  id: secretId,
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  createdAt: z.date(),
});

// ─── memory ────────────────────────────────────────────────────────────────

export const memoryAuthor = z.union([agentId, z.literal('user')]);

export const memoryHistory = z.array(
  z.object({
    value: z.string(),
    confidence: z.number(),
    writtenBy: memoryAuthor,
    at: isoDate,
  }),
);

export const memoryEntry = z.object({
  id: memoryId,
  ns: namespaceKey,
  key: z.string().min(1).max(200),
  value: z.string().max(4000),
  data: z.unknown(),
  confidence: z.number().min(0).max(1),
  source: z.string(),
  writtenBy: memoryAuthor,
  readBy: z.array(agentId),
  expiresAt: z.date().nullable(),
  verifiedAt: z.date(),
  /** Set by the nightly health job (verifiedAt older than 30 days). */
  stale: z.boolean(),
  /** Set when a write moved confidence by more than 0.3 (spec §6). */
  conflict: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
  history: memoryHistory,
});

/** Memory namespaces are user-creatable, so they get their own small table. */
export const memoryNamespace = z.object({
  id: namespaceKey,
  label: z.string().min(1),
  createdAt: z.date(),
});

// ─── settings (single row, id 'settings') ─────────────────────────────────

export const modelDefaults = z.object({ orchestrator: z.string(), default: z.string() });

export const settings = z.object({
  id: z.literal('settings'),
  workspaceName: z.string().min(1),
  region: z.string().min(1),
  /** Dollars a day across all runs; 0 means no cap (D32). */
  spendCapUsd: z.number().nonnegative(),
  models: modelDefaults,
  updatedAt: z.date(),
});

/** The highest daily spend cap the Settings screen accepts, in dollars (D32). */
export const SPEND_CAP_MAX_USD = 10_000;

/** A daily spend cap as the operator types it: dollars, rounded to the cent; 0 means no cap. */
export const spendCapInput = z
  .number({ error: 'Enter the cap in dollars, for example 50' })
  .nonnegative('The cap can’t be negative. Use 0 for no cap')
  .max(SPEND_CAP_MAX_USD, `The cap can be at most $${SPEND_CAP_MAX_USD.toLocaleString('en-US')}`)
  .transform((usd) => Math.round(usd * 100) / 100);

/** PATCH /api/settings: the settings the operator may change. Only the spend cap so far (D32). */
export const settingsPatch = z.object({ spendCapUsd: spendCapInput });

export type SettingsPatch = z.infer<typeof settingsPatch>;

// ─── API bodies ────────────────────────────────────────────────────────────

/** Credentials as the operator types them: the token is stored encrypted and never returned. */
export const toolAuthInput = z.object({
  type: z.enum(['none', 'bearer', 'oauth2', 'apikey']).default('none'),
  scopes: z.array(z.string()).optional(),
  token: z.string().trim().min(1).optional(),
});

const toolFields = z.object({
  name: z.string().trim().min(1, 'Give the tool a name').max(64),
  transport: z.enum(['http', 'stdio', 'repository']),
  url: z.url('The url must be a full http(s) address').optional(),
  command: z.string().trim().min(1).optional(),
  /** A repository: the folder, the package scripts agents may run, and the run timeout. */
  path: z.string().trim().min(1).optional(),
  scripts: repositoryConfig.shape.scripts.optional(),
  timeoutSec: repositoryConfig.shape.timeoutSec.optional(),
  auth: toolAuthInput,
  /** Agent slugs that may use every tool the server exposes. */
  grant: z.array(slug),
  category: z.string().trim().max(40).optional(),
  description: z.string().trim().max(500).optional(),
  glyph: z.string().trim().min(1).max(3).optional(),
});

const needsTarget = (
  v: {
    transport?: 'http' | 'stdio' | 'repository';
    url?: string;
    command?: string;
    path?: string;
    auth?: { type?: string };
  },
  ctx: z.RefinementCtx,
) => {
  if (v.transport === 'repository') {
    if (!v.path) {
      ctx.addIssue({ code: 'custom', path: ['path'], message: 'A repository needs a path' });
    }
    if (v.auth?.type && v.auth.type !== 'none') {
      ctx.addIssue({ code: 'custom', path: ['auth'], message: 'A repository takes no auth' });
    }
  }
  if (v.transport === 'http' && !v.url) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'An http server needs a url' });
  }
  if (v.transport === 'stdio' && !v.command) {
    ctx.addIssue({ code: 'custom', path: ['command'], message: 'A stdio server needs a command' });
  }
};

/** POST /api/tools and /api/tools/test — the Connect panel's JSON (spec §3.5). */
export const toolConnectInput = toolFields
  .extend({
    auth: toolAuthInput.default({ type: 'none' }),
    grant: toolFields.shape.grant.default([]),
  })
  .superRefine(needsTarget);

/** PATCH /api/tools/[id]: any subset; a new token re-tests the connection. */
export const toolPatch = toolFields.partial();

/** A date (`2026-12-06`) or a full timestamp; `null` clears. */
export const dateOrDatetime = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

/** POST /api/memory — a fact written by the operator (spec §3.6, §7.3). */
export const memoryInput = z.object({
  ns: namespaceKey,
  key: z.string().trim().min(1, 'Give the fact a key').max(200),
  value: z.string().trim().min(1, 'Write the fact itself').max(4000),
  confidence: z.number().min(0).max(1).default(1),
  source: z.string().trim().max(200).default('you'),
  expiresAt: dateOrDatetime.nullable().default(null),
  data: z.unknown().optional(),
});

/** PATCH /api/memory/[id]: any subset; `verified: true` stamps verifiedAt and clears stale/conflict. */
export const memoryPatch = z.object({
  value: memoryInput.shape.value.optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.string().trim().max(200).optional(),
  expiresAt: dateOrDatetime.nullable().optional(),
  data: z.unknown().optional(),
  verified: z.literal(true).optional(),
});

/** POST /api/memory/namespaces — namespaces are user-creatable (D8). */
export const namespaceInput = z.object({
  label: z.string().trim().min(1, 'Name the namespace').max(40),
});

/** Settings → Load the development flock (D35): the repository folder and its allowed scripts. */
export const flockLoadInput = z.object({
  path: z.string().trim().min(1, 'Give the repository folder as an absolute path.').max(4096),
  /** Script names separated by commas or spaces; lib/flock.ts checks each one. */
  scripts: z.string().max(2000),
});

export type FlockLoadInput = z.infer<typeof flockLoadInput>;
export type MemoryInput = z.infer<typeof memoryInput>;
export type MemoryPatch = z.infer<typeof memoryPatch>;
export type NamespaceInput = z.infer<typeof namespaceInput>;

/** POST /api/runs — the prompt window's submission (spec §3.2, §8). */
export const runCreateInput = z.object({
  text: z.string().trim().min(1, 'Give Magpipe a task').max(20_000),
  attachmentIds: z
    .array(z.string().regex(/^upl_[0-9a-z]+$/))
    .max(10)
    .default([]),
  /** Continue the conversation of this run: its task and answer become context. */
  parentRunId: runId.optional(),
  /**
   * Run a factory template's preset plan instead of the orchestrator's (D37). Only the spec
   * template starts from a prompt; the goals template starts when a spec is approved (D39).
   */
  template: z.enum(['spec']).optional(),
});

/** POST /api/runs/[id]/approve: let a waiting run go on, with a note for the next steps. */
export const runApproveInput = z.object({ note: z.string().trim().max(2000).optional() });

/** PATCH /api/runs/[id]: close or reopen its card on Home. */
export const runPatchInput = z.object({ dismissed: z.boolean() });

/** An uploaded file's record, kept as a JSON sidecar next to the file (desktop, D3). */
export const upload = z.object({
  id: z.string().regex(/^upl_[0-9a-z]+$/),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  /** Where the bytes live: a path under the data dir on desktop. */
  url: z.string(),
  createdAt: isoDate,
});

export type RunCreateInput = z.infer<typeof runCreateInput>;
export type RunPatchInput = z.infer<typeof runPatchInput>;
export type Upload = z.infer<typeof upload>;
export type Usage = z.infer<typeof usage>;

export type ToolAuthInput = z.infer<typeof toolAuthInput>;
export type ToolConnectInput = z.infer<typeof toolConnectInput>;
export type ToolPatch = z.infer<typeof toolPatch>;
export type RepositoryConfig = z.infer<typeof repositoryConfig>;

/** The editable fields of an agent, without defaults, so a PATCH never resets what it omits. */
const agentFields = z.object({
  name: z.string().trim().min(1, 'Give the bird a name').max(64),
  role: z.string().trim().max(120),
  description: z.string().trim().max(2000),
  initials: z.string().trim().min(1).max(3).optional(),
  model: z.string().min(1, 'Pick a model'),
  systemPrompt: z.string().max(20_000),
  tools: z.array(toolGrant),
  builtins: z.array(z.enum(builtinTools)),
  memoryScope,
  limits: agentLimits,
  pauseAfter: z.boolean(),
  sendBackRounds: z.number().int().min(0, 'At least 0').max(5, 'At most 5 rounds'),
  templateOnly: z.boolean(),
});

/** POST /api/agents. Slug and (unless given) initials are derived from the name. */
export const agentInput = agentFields.extend({
  role: agentFields.shape.role.default(''),
  description: agentFields.shape.description.default(''),
  systemPrompt: agentFields.shape.systemPrompt.default(''),
  tools: agentFields.shape.tools.default([]),
  builtins: agentFields.shape.builtins.default([]),
  memoryScope: memoryScope.default({ read: [], write: [] }),
  limits: agentLimits.default({ maxTokens: 100_000, maxSteps: 30, timeoutSec: 600 }),
  pauseAfter: agentFields.shape.pauseAfter.default(false),
  sendBackRounds: agentFields.shape.sendBackRounds.default(0),
  templateOnly: agentFields.shape.templateOnly.default(false),
});

/** PATCH /api/agents/[id]: any subset of the fields, plus pause/resume. */
export const agentPatch = agentFields.partial().extend({
  status: z.enum(['idle', 'paused']).optional(),
});

export type AgentInput = z.infer<typeof agentInput>;
export type AgentPatch = z.infer<typeof agentPatch>;

export type Agent = z.infer<typeof agent>;
export type AgentStatus = z.infer<typeof agentStatus>;
export type ToolGrant = z.infer<typeof toolGrant>;
export type Step = z.infer<typeof step>;
export type StepWork = z.infer<typeof stepWork>;
export type RunArtifact = z.infer<typeof runArtifact>;
export type StepStatus = z.infer<typeof stepStatus>;
export type Run = z.infer<typeof run>;
export type Attachment = z.infer<typeof attachment>;
export type RunStatus = z.infer<typeof runStatus>;
export type RunEvent = z.infer<typeof runEvent>;
export type NewRunEvent = z.infer<typeof newRunEvent>;
export type RunEventKind = z.infer<typeof runEventKind>;
export type Tool = z.infer<typeof tool>;
export type ToolStatus = z.infer<typeof toolStatus>;
export type MemoryEntry = z.infer<typeof memoryEntry>;
export type MemoryNamespace = z.infer<typeof memoryNamespace>;
export type Settings = z.infer<typeof settings>;
export type Secret = z.infer<typeof secret>;

// ─── the tracker (Linear, D38) ─────────────────────────────────────────────

/**
 * The six states of the factory's pipeline (docs/factory.md), each mapped by the operator onto
 * one of the team's own statuses. `other` is a status none of them maps to.
 */
export const pipelineStates = [
  'spec_ready',
  'approved',
  'building',
  'merge_question',
  'done',
  'needs_you',
] as const;
export type PipelineState = (typeof pipelineStates)[number];
export const issueStages = [...pipelineStates, 'other'] as const;
export type IssueStage = (typeof issueStages)[number];

export const trackerRef = z.object({ id: z.string().min(1), name: z.string() });
export const trackerTeam = trackerRef.extend({ key: z.string() });
export const pipelineStateMap = z.object({
  spec_ready: trackerRef.optional(),
  approved: trackerRef.optional(),
  building: trackerRef.optional(),
  merge_question: trackerRef.optional(),
  done: trackerRef.optional(),
  needs_you: trackerRef.optional(),
});

/** Linear access and the watcher's pace (D38): one row, `linear`. The key is a sealed secret. */
export const linearSettings = z.object({
  id: z.literal('linear'),
  /** The `secrets` row that holds the API key, sealed; the key is never read back out. */
  keyRef: z.string().nullable(),
  /** The key's last four characters, so the operator can tell which key is saved. */
  keyHint: z.string().nullable(),
  /** Who the key belongs to, as Linear said when it was saved. */
  viewer: z.string().nullable(),
  team: trackerTeam.nullable(),
  /** The label that marks the issues the factory owns. */
  label: trackerRef.nullable(),
  states: pipelineStateMap,
  /** Seconds between the watcher's checks: 15 to 1800. */
  pollSeconds: z.number().int().min(15).max(1800),
  paused: z.boolean(),
  lastCheckAt: z.date().nullable(),
  /** What the last check saw: issues with the label, and how many changed stage. */
  lastCheck: z.object({ issues: z.number().int(), changed: z.number().int() }).nullable(),
  lastError: z.string().nullable(),
  updatedAt: z.date(),
});

/** An issue the factory owns, as the watcher last saw it (D38). */
export const trackerIssue = z.object({
  id: issueId,
  /** Linear's id for the issue. */
  externalId: z.string(),
  /** `ENG-12`. */
  identifier: z.string(),
  url: z.string(),
  title: z.string(),
  /** The spec run that filed it; null for an issue the operator labelled by hand. */
  runId: runId.nullable(),
  stage: z.enum(issueStages),
  /** The team's own name for the status it is in. */
  stateName: z.string(),
  /** The spec issue this goal belongs to (D39); null for a spec issue. */
  parentId: issueId.nullable(),
  /** Linear's id of the parent issue, even one Magpipe does not track: a sub-issue is no spec. */
  externalParentId: z.string().nullable(),
  /** The goal a sub-issue was filed for: its key, criteria, files and dependencies. */
  goal: goal.nullable(),
  /** The goals run started when the spec was approved; set once, so it starts once. */
  goalsRunId: runId.nullable(),
  /** A goal's build run (D40); released when the goal goes to needs you, so it can build again. */
  buildRunId: runId.nullable(),
  /** When gate G1 opened, and through which door. */
  approvedAt: z.date().nullable(),
  approvedVia: z.enum(['linear', 'magpipe']).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const POLL_SECONDS_MIN = 15;
export const POLL_SECONDS_MAX = 1800;

/** Settings → Linear: the key, pasted once. */
export const linearKeyInput = z.object({
  key: z.string().trim().min(1, 'Paste the API key from Linear.').max(500),
});

/** Settings → Linear: the team, the label and the six statuses. */
export const linearMappingInput = z.object({
  teamId: z.string().min(1, 'Pick a team.'),
  label: z.string().trim().min(1, 'Name the label that marks factory issues.').max(80),
  states: z.object({
    spec_ready: z.string().min(1, 'Pick a status for each state.'),
    approved: z.string().min(1, 'Pick a status for each state.'),
    building: z.string().min(1, 'Pick a status for each state.'),
    merge_question: z.string().min(1, 'Pick a status for each state.'),
    done: z.string().min(1, 'Pick a status for each state.'),
    needs_you: z.string().min(1, 'Pick a status for each state.'),
  }),
});

/** Settings → Linear: the watcher's pace. */
export const watcherInput = z.object({
  pollSeconds: z.coerce
    .number()
    .int('Whole seconds only.')
    .min(POLL_SECONDS_MIN, `At least ${POLL_SECONDS_MIN} seconds.`)
    .max(POLL_SECONDS_MAX, `At most ${POLL_SECONDS_MAX} seconds (30 minutes).`),
  paused: z.boolean(),
});

export type LinearSettings = z.infer<typeof linearSettings>;
export type TrackerIssue = z.infer<typeof trackerIssue>;
export type TrackerRef = z.infer<typeof trackerRef>;
export type TrackerTeam = z.infer<typeof trackerTeam>;
export type PipelineStateMap = z.infer<typeof pipelineStateMap>;
export type LinearMappingInput = z.infer<typeof linearMappingInput>;
export type LinearKeyInput = z.infer<typeof linearKeyInput>;
export type WatcherInput = z.infer<typeof watcherInput>;

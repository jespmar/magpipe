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
  status: agentStatus,
  createdAt: z.date(),
  updatedAt: z.date(),
});

// ─── runs ──────────────────────────────────────────────────────────────────

export const stepStatus = z.enum(['todo', 'live', 'done', 'failed', 'skipped']);

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
  result: z.object({ summary: z.string().max(1000), data: z.unknown().optional() }).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export const runStatuses = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export const runStatus = z.enum(runStatuses);

export const attachment = z.object({
  /** Where the file lives: a path under the data dir on desktop, a blob URL when hosted. */
  blobUrl: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  mime: z.string(),
});

export const runInput = z.object({ text: z.string().min(1), attachments: z.array(attachment) });
export const runOutput = z.object({
  markdown: z.string(),
  artifacts: z.array(z.object({ blobUrl: z.string(), name: z.string() })),
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
  parentRunId: runId.nullable(),
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

export const tool = z.object({
  id: toolId,
  slug,
  name: z.string().min(1),
  /** UI-only: two-letter tile on the ToolCard, e.g. `VN`. */
  glyph: z.string().min(1).max(3),
  kind: z.enum(['mcp', 'builtin']),
  /** UI-only: the part after "MCP ·", e.g. `ERP`. */
  category: z.string(),
  description: z.string(),
  transport: z.enum(['http', 'stdio', 'builtin']),
  url: z.url().nullable(),
  command: z.string().nullable(),
  auth: toolAuth,
  status: toolStatus,
  /** Tool names discovered from the server (or declared for built-ins). */
  scopes: z.array(z.string()),
  grantedAgents: z.array(agentId),
  stats: toolStats,
  createdAt: z.date(),
  updatedAt: z.date(),
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
  spendCapUsd: z.number().nonnegative(),
  models: modelDefaults,
  updatedAt: z.date(),
});

// ─── API bodies ────────────────────────────────────────────────────────────

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
export type StepStatus = z.infer<typeof stepStatus>;
export type Run = z.infer<typeof run>;
export type RunStatus = z.infer<typeof runStatus>;
export type RunEvent = z.infer<typeof runEvent>;
export type NewRunEvent = z.infer<typeof newRunEvent>;
export type RunEventKind = z.infer<typeof runEventKind>;
export type Tool = z.infer<typeof tool>;
export type ToolStatus = z.infer<typeof toolStatus>;
export type MemoryEntry = z.infer<typeof memoryEntry>;
export type MemoryNamespace = z.infer<typeof memoryNamespace>;
export type Settings = z.infer<typeof settings>;

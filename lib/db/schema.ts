/**
 * Postgres tables (Drizzle). Runs embedded via PGlite in the desktop app; the same schema works
 * on a hosted Postgres later. Column names are snake_case in the database (`casing` option).
 *
 * Row shapes must match the zod schemas in `lib/schemas` — enforced by `schema-check.ts`.
 * After changing this file run `npm run db:generate` and commit the new migration in `drizzle/`.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  agentStatuses,
  issueStages,
  mergeMethods,
  runEventKinds,
  runStatuses,
  toolStatuses,
  type Agent,
  type FactoryProject,
  type LinearSettings,
  type MemoryEntry,
  type TrackerIssue,
  type Run,
  type Settings,
  type Step,
  type Tool,
} from '../schemas';

const timestamptz = () => timestamp({ withTimezone: true, mode: 'date' });

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** `col IN ('a', 'b')` for CHECK constraints on enum-like text columns. */
const oneOf = (col: AnyPgColumn, values: readonly string[]): SQL =>
  sql`${col} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

// ─── agents ────────────────────────────────────────────────────────────────

export const agents = pgTable(
  'agents',
  {
    id: text().primaryKey(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    role: text().notNull(),
    description: text().notNull(),
    initials: text().notNull(),
    model: text().notNull(),
    systemPrompt: text().notNull(),
    tools: jsonb().$type<Agent['tools']>().notNull(),
    builtins: jsonb().$type<Agent['builtins']>().notNull(),
    memoryScope: jsonb().$type<Agent['memoryScope']>().notNull(),
    limits: jsonb().$type<Agent['limits']>().notNull(),
    pauseAfter: boolean().notNull().default(false),
    sendBackRounds: integer().notNull().default(0),
    templateOnly: boolean().notNull().default(false),
    status: text({ enum: agentStatuses }).notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [check('agents_status_check', oneOf(t.status, agentStatuses))],
);

// ─── runs ──────────────────────────────────────────────────────────────────

/** Backs `runs.display_id` (`flight_<base36>`). */
export const runSeq = pgSequence('run_seq');

export const runs = pgTable(
  'runs',
  {
    id: text().primaryKey(),
    displayId: text().notNull().unique(),
    input: jsonb().$type<Run['input']>().notNull(),
    status: text({ enum: runStatuses }).notNull(),
    plan: jsonb().$type<Step[]>().notNull(),
    startedAt: timestamptz(),
    finishedAt: timestamptz(),
    durationMs: integer(),
    usage: jsonb().$type<Run['usage']>().notNull(),
    output: jsonb().$type<NonNullable<Run['output']>>(),
    parentRunId: text().references((): AnyPgColumn => runs.id, { onDelete: 'set null' }),
    dismissedAt: timestamptz(),
    createdBy: text().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index('runs_created_at_idx').on(t.createdAt.desc()),
    index('runs_status_created_at_idx').on(t.status, t.createdAt.desc()),
    check('runs_status_check', oneOf(t.status, runStatuses)),
  ],
);

export const runEvents = pgTable(
  'run_events',
  {
    id: text().primaryKey(),
    seq: bigserial({ mode: 'number' }).notNull().unique(),
    runId: text()
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    ts: timestamptz().notNull().defaultNow(),
    stepId: text(),
    agentId: text(),
    kind: text({ enum: runEventKinds }).notNull(),
    text: text().notNull(),
    payload: jsonb().$type<unknown>(),
  },
  (t) => [
    index('run_events_run_seq_idx').on(t.runId, t.seq),
    check('run_events_kind_check', oneOf(t.kind, runEventKinds)),
  ],
);

// ─── tools ─────────────────────────────────────────────────────────────────

export const tools = pgTable(
  'tools',
  {
    id: text().primaryKey(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    glyph: text().notNull(),
    kind: text({ enum: ['mcp', 'builtin', 'repository'] }).notNull(),
    category: text().notNull(),
    description: text().notNull(),
    transport: text({ enum: ['http', 'stdio', 'builtin', 'repository'] }).notNull(),
    url: text(),
    command: text(),
    repository: jsonb().$type<Tool['repository']>(),
    auth: jsonb().$type<Tool['auth']>().notNull(),
    status: text({ enum: toolStatuses }).notNull(),
    scopes: jsonb().$type<string[]>().notNull(),
    grantedAgents: jsonb().$type<string[]>().notNull(),
    stats: jsonb().$type<Tool['stats']>().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [check('tools_status_check', oneOf(t.status, toolStatuses))],
);

// ─── memory ────────────────────────────────────────────────────────────────

/** Tool credentials at rest, AES-256-GCM under MAGPIPE_SECRET_KEY (lib/secrets.ts). */
export const secrets = pgTable('secrets', {
  id: text().primaryKey(),
  ciphertext: text().notNull(),
  iv: text().notNull(),
  tag: text().notNull(),
  createdAt: timestamptz().notNull().defaultNow(),
});

export const memoryNamespaces = pgTable('memory_namespaces', {
  id: text().primaryKey(),
  label: text().notNull(),
  createdAt: timestamptz().notNull().defaultNow(),
});

export const memory = pgTable(
  'memory',
  {
    id: text().primaryKey(),
    ns: text()
      .notNull()
      .references(() => memoryNamespaces.id, { onUpdate: 'cascade' }),
    key: text().notNull(),
    value: text().notNull(),
    data: jsonb().$type<unknown>(),
    confidence: doublePrecision().notNull(),
    source: text().notNull(),
    writtenBy: text().notNull(),
    readBy: jsonb().$type<string[]>().notNull(),
    expiresAt: timestamptz(),
    verifiedAt: timestamptz().notNull(),
    stale: boolean().notNull().default(false),
    conflict: boolean().notNull().default(false),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
    history: jsonb().$type<MemoryEntry['history']>().notNull(),
    /** Full-text search over key (weight A) and value (weight B) — `memory.search` (§7.3). */
    search: tsvector().generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', "key"), 'A') || setweight(to_tsvector('english', "value"), 'B')`,
    ),
  },
  (t) => [
    uniqueIndex('memory_ns_key_idx').on(t.ns, t.key),
    index('memory_search_idx').using('gin', t.search),
    index('memory_expires_at_idx').on(t.expiresAt),
    check('memory_confidence_check', sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  ],
);

// ─── settings ──────────────────────────────────────────────────────────────

export const settings = pgTable(
  'settings',
  {
    id: text().$type<'settings'>().primaryKey().default('settings'),
    workspaceName: text().notNull(),
    region: text().notNull(),
    spendCapUsd: doublePrecision().notNull(),
    maxRuns: integer().notNull().default(2),
    models: jsonb().$type<Settings['models']>().notNull(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [check('settings_single_row', sql`${t.id} = 'settings'`)],
);

// ─── the tracker (Linear, D38) ─────────────────────────────────────────────

export const linearSettings = pgTable(
  'linear_settings',
  {
    id: text().$type<'linear'>().primaryKey().default('linear'),
    keyRef: text(),
    keyHint: text(),
    viewer: text(),
    keyKind: text({ enum: ['key', 'oauth'] })
      .notNull()
      .default('key'),
    refreshRef: text(),
    expiresAt: timestamptz(),
    oauthClientId: text(),
    tokenClientId: text(),
    team: jsonb().$type<LinearSettings['team']>(),
    label: jsonb().$type<LinearSettings['label']>(),
    states: jsonb().$type<LinearSettings['states']>().notNull(),
    pollSeconds: integer().notNull().default(60),
    paused: boolean().notNull().default(false),
    lastCheckAt: timestamptz(),
    lastCheck: jsonb().$type<LinearSettings['lastCheck']>(),
    lastError: text(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [check('linear_settings_single_row', sql`${t.id} = 'linear'`)],
);

export const trackerIssues = pgTable(
  'tracker_issues',
  {
    id: text().primaryKey(),
    externalId: text().notNull().unique(),
    identifier: text().notNull(),
    url: text().notNull(),
    title: text().notNull(),
    projectId: text().references((): AnyPgColumn => factoryProjects.id, { onDelete: 'set null' }),
    runId: text().references(() => runs.id, { onDelete: 'set null' }),
    stage: text({ enum: issueStages }).notNull(),
    stateName: text().notNull(),
    parentId: text().references((): AnyPgColumn => trackerIssues.id, { onDelete: 'set null' }),
    externalParentId: text(),
    goal: jsonb().$type<TrackerIssue['goal']>(),
    goalsRunId: text().references(() => runs.id, { onDelete: 'set null' }),
    buildRunId: text().references(() => runs.id, { onDelete: 'set null' }),
    prNumber: integer(),
    prUrl: text(),
    mergeRequestedAt: timestamptz(),
    mergeRequestedVia: text({ enum: ['magpipe', 'linear', 'rule'] }),
    landRunId: text().references(() => runs.id, { onDelete: 'set null' }),
    mergedAt: timestamptz(),
    operatorNote: text(),
    approvedAt: timestamptz(),
    approvedVia: text({ enum: ['linear', 'magpipe'] }),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    check('tracker_issues_stage_check', oneOf(t.stage, issueStages)),
    index('tracker_issues_run_idx').on(t.runId),
    index('tracker_issues_parent_idx').on(t.parentId),
  ],
);

// ─── the forge (GitHub, D42) ───────────────────────────────────────────────

export const forgeSettings = pgTable(
  'forge_settings',
  {
    id: text().$type<'github'>().primaryKey().default('github'),
    keySource: text({ enum: ['token', 'gh'] })
      .notNull()
      .default('token'),
    keyRef: text(),
    keyHint: text(),
    viewer: text(),
    repo: text(),
    mergeMethod: text({ enum: mergeMethods }).notNull().default('squash'),
    autoMerge: boolean().notNull().default(false),
    autoMergeLabel: text().notNull().default('auto-merge'),
    autoMergeFirstPass: boolean().notNull().default(true),
    autoMergeChecks: boolean().notNull().default(true),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [check('forge_settings_single_row', sql`${t.id} = 'github'`)],
);

// ─── factory projects (D45) ────────────────────────────────────────────────

export const factoryProjects = pgTable('factory_projects', {
  id: text().primaryKey(),
  name: text().notNull(),
  repoPath: text().notNull(),
  scripts: jsonb().$type<string[]>().notNull(),
  context: text().notNull().default(''),
  linear: jsonb().$type<FactoryProject['linear']>().notNull(),
  github: jsonb().$type<FactoryProject['github']>().notNull(),
  linearKeyRef: text(),
  linearKeyHint: text(),
  githubKeyRef: text(),
  githubKeyHint: text(),
  maxRuns: integer(),
  spendCapUsd: doublePrecision(),
  models: jsonb().$type<FactoryProject['models']>().notNull(),
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
});

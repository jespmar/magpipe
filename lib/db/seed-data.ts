/**
 * Seed data from the design canvas (spec §9): the four agents from the Agents artboard, the
 * nine tools from the Tools artboard, the memory entries from the Memory artboard (plus one
 * incident for the expired Younium token) and the finished runs from the Runs artboard.
 *
 * Pure — no I/O — so tests can validate it against the schemas. Loaded by `seed.ts`. Where the artboards disagree
 * with each other (who may read or write which namespace), the data is made consistent with
 * the agents' memory scopes; see the invariants in tests/seed-data.test.ts.
 */
import type {
  Agent,
  MemoryEntry,
  MemoryNamespace,
  Run,
  NewRunEvent,
  Settings,
  Step,
  StepWork,
  Tool,
} from '../schemas';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type AgentSlug = 'researcher' | 'coder' | 'reviewer' | 'operator';
const agentIdOf = (slug: AgentSlug) => `agt_${slug}`;
const byInitials: Record<string, AgentSlug> = {
  RS: 'researcher',
  CD: 'coder',
  RV: 'reviewer',
  OP: 'operator',
};

export const NAMESPACES = [
  { key: 'rate-limits', label: 'Rate limits' },
  { key: 'facts', label: 'Facts' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'incidents', label: 'Incidents' },
  { key: 'tenants', label: 'Tenants' },
] as const;
const ALL_NS = NAMESPACES.map((n) => n.key);

// ─── agents ────────────────────────────────────────────────────────────────

const AGENTS: Omit<
  Agent,
  | 'id'
  | 'tools'
  | 'pauseAfter'
  | 'sendBackRounds'
  | 'templateOnly'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
>[] = [
  {
    slug: 'researcher',
    name: 'Researcher',
    role: 'Gathers context & sources',
    initials: 'RS',
    model: 'claude-sonnet-5-5',
    description:
      'Reads API docs, changelogs and tickets, then writes what matters into the nest so the other birds never re-read the same page.',
    systemPrompt:
      'You are Researcher, a bird in the Magpipe flock.\nGather only what the current task needs. Prefer primary sources. Write durable facts to memory with a confidence score. Never write code.',
    builtins: ['web.search', 'web.fetch', 'files.read'],
    // Artboard: "Read + write · facts, rate-limits" — plus tenants, which it writes on the Memory artboard.
    memoryScope: {
      read: ['facts', 'rate-limits', 'tenants'],
      write: ['facts', 'rate-limits', 'tenants'],
    },
    limits: { maxTokens: 100_000, maxSteps: 30, timeoutSec: 600 },
  },
  {
    slug: 'coder',
    name: 'Coder',
    role: 'Writes & edits code',
    initials: 'CD',
    model: 'claude-opus-5-5',
    description:
      'Implements changes in the integration repos, runs the test suite and opens a PR for Reviewer. Reads shared memory before every task.',
    systemPrompt:
      'You are Coder, a bird in the Magpipe flock.\nRead memory before you start. Work in small commits. Run the test suite before opening a PR. Hand off to Reviewer; never merge yourself.',
    builtins: ['files.read'],
    memoryScope: { read: [...ALL_NS], write: [] },
    limits: { maxTokens: 400_000, maxSteps: 80, timeoutSec: 1800 },
  },
  {
    slug: 'reviewer',
    name: 'Reviewer',
    role: 'Checks diffs & tests',
    initials: 'RV',
    model: 'claude-sonnet-5-5',
    description:
      'Reviews every PR for correctness, security and tenant isolation. Blocks merges that touch billing paths without a test.',
    systemPrompt:
      'You are Reviewer, a bird in the Magpipe flock.\nReview for correctness, security and multi-tenant isolation. Request changes with a concrete fix. Approve only with green tests.',
    builtins: [],
    memoryScope: { read: ['decisions'], write: [] },
    limits: { maxTokens: 100_000, maxSteps: 30, timeoutSec: 600 },
  },
  {
    slug: 'operator',
    name: 'Operator',
    role: 'Deploys & monitors',
    initials: 'OP',
    model: 'claude-haiku-5-5',
    description:
      'Promotes approved builds to Vercel, watches Inngest for failed runs and raises a flag in the flight log when something drifts.',
    systemPrompt:
      'You are Operator, a bird in the Magpipe flock.\nDeploy only approved builds. Watch function runs for 15 minutes after each deploy. Report anomalies; never fix them yourself.',
    builtins: [],
    memoryScope: { read: ['incidents'], write: ['incidents'] },
    limits: { maxTokens: 50_000, maxSteps: 20, timeoutSec: 900 },
  },
];

// ─── tools ─────────────────────────────────────────────────────────────────

type ToolSeed = Pick<
  Tool,
  'slug' | 'name' | 'glyph' | 'kind' | 'category' | 'description' | 'status' | 'scopes'
> & {
  transport: Tool['transport'];
  url?: string;
  auth: Tool['auth'];
  /** agent → granted scopes (a subset of `scopes`) */
  grants: Partial<Record<AgentSlug, string[]>>;
  calls24h: number;
};

// `.example` URLs are placeholders: connect the real servers from the Tools screen.
const TOOLS: ToolSeed[] = [
  {
    slug: 'visma-net',
    name: 'Visma.net',
    glyph: 'VN',
    kind: 'mcp',
    category: 'ERP',
    status: 'connected',
    description: 'Sales orders, customers, journal transactions. Tenant-scoped tokens per client.',
    scopes: ['salesorder:rw', 'customer:r', 'journal:rw'],
    transport: 'http',
    url: 'https://mcp.visma.example/v1',
    auth: { type: 'oauth2' },
    grants: {
      researcher: ['salesorder:rw', 'customer:r', 'journal:rw'],
      coder: ['salesorder:rw', 'customer:r', 'journal:rw'],
    },
    calls24h: 1284,
  },
  {
    slug: 'shopify-admin',
    name: 'Shopify Admin',
    glyph: 'SH',
    kind: 'mcp',
    category: 'Commerce',
    status: 'connected',
    description: 'Orders, products and inventory via the Admin GraphQL API.',
    scopes: ['orders:r', 'products:r', 'inventory:rw'],
    transport: 'http',
    url: 'https://mcp.shopify.example/v1',
    auth: { type: 'oauth2' },
    grants: {
      researcher: ['orders:r', 'products:r', 'inventory:rw'],
      coder: ['orders:r', 'products:r', 'inventory:rw'],
    },
    calls24h: 2910,
  },
  {
    slug: 'github',
    name: 'GitHub',
    glyph: 'GH',
    kind: 'mcp',
    category: 'Code',
    status: 'connected',
    description: 'Read repos, open and review PRs across the integration monorepos.',
    scopes: ['repo:r', 'pr:rw', 'review:rw'],
    transport: 'http',
    url: 'https://mcp.github.example/v1',
    auth: { type: 'oauth2' },
    // Researcher added: its artboard lists github.read.
    grants: {
      researcher: ['repo:r'],
      coder: ['repo:r', 'pr:rw'],
      reviewer: ['repo:r', 'review:rw'],
    },
    calls24h: 416,
  },
  {
    slug: 'inngest',
    name: 'Inngest',
    glyph: 'IN',
    kind: 'mcp',
    category: 'Workflows',
    status: 'connected',
    description: 'Query function runs with CEL, replay failed events, inspect step output.',
    scopes: ['runs:r', 'events:replay'],
    transport: 'http',
    url: 'https://mcp.inngest.example/v1',
    auth: { type: 'bearer' },
    grants: { researcher: ['runs:r'], operator: ['runs:r', 'events:replay'] },
    calls24h: 233,
  },
  {
    slug: 'mongodb-atlas',
    name: 'MongoDB Atlas',
    glyph: 'DB',
    kind: 'mcp',
    category: 'Data',
    status: 'connected',
    description: 'Read-only access to sync state and mapping collections. No writes from agents.',
    scopes: ['sync_state:r', 'mappings:r'],
    transport: 'http',
    url: 'https://mcp.mongodb.example/v1',
    auth: { type: 'apikey' },
    grants: { researcher: ['sync_state:r', 'mappings:r'] },
    calls24h: 97,
  },
  {
    slug: 'vercel',
    name: 'Vercel',
    glyph: 'VC',
    kind: 'mcp',
    category: 'Deploy',
    status: 'connected',
    description: 'Promote preview builds and read deployment logs.',
    scopes: ['deploy:rw', 'logs:r'],
    transport: 'http',
    url: 'https://mcp.vercel.example/v1',
    auth: { type: 'bearer' },
    grants: { operator: ['deploy:rw', 'logs:r'] },
    calls24h: 18,
  },
  {
    slug: 'slack',
    name: 'Slack',
    glyph: 'SL',
    kind: 'mcp',
    category: 'Chat',
    status: 'connected',
    description: 'Post flight summaries and incident flags to #sync-ops.',
    scopes: ['chat:write'],
    transport: 'http',
    url: 'https://mcp.slack.example/v1',
    auth: { type: 'oauth2' },
    grants: { operator: ['chat:write'] },
    calls24h: 41,
  },
  {
    slug: 'younium',
    name: 'Younium',
    glyph: 'YN',
    kind: 'mcp',
    category: 'Billing',
    status: 'needs_auth',
    description:
      'Subscriptions and invoices. OAuth token expired — reconnect to resume the Visma–Younium sync flights.',
    scopes: ['invoices:r', 'customers:r'],
    transport: 'http',
    url: 'https://mcp.younium.example/v1',
    auth: { type: 'oauth2', scopes: ['invoices:read', 'customers:read'] },
    grants: { researcher: ['invoices:r', 'customers:r'], coder: ['invoices:r', 'customers:r'] },
    calls24h: 0,
  },
  {
    slug: 'workspace-fs',
    name: 'Workspace FS',
    glyph: 'FS',
    kind: 'builtin',
    category: 'Files',
    status: 'connected',
    description: 'Sandboxed file system and shell for the cloned repos. Wiped after every flight.',
    scopes: ['fs:rw', 'shell:run'],
    transport: 'builtin',
    auth: { type: 'none' },
    grants: { coder: ['fs:rw', 'shell:run'], reviewer: ['shell:run'] },
    calls24h: 5602,
  },
];

const toolIdOf = (slug: string) => `tool_${slug.replace(/-/g, '')}`;

// ─── memory ────────────────────────────────────────────────────────────────

type MemorySeed = {
  ns: (typeof ALL_NS)[number];
  key: string;
  value: string;
  /** Initials from the artboard, or 'user' for human decisions. */
  by: keyof typeof byInitials | 'user';
  /** How long ago it was last updated ("10:25", "Tue", "12 d" on the artboard). */
  agoMs: number;
  confidence: number;
  source: string;
  /** Initials from the artboard; filtered to agents whose read scope covers `ns`. */
  readBy: (keyof typeof byInitials)[];
  expires: string | null;
};

// "decision · Jesper" entries were written by a person, so they are `user`, not an agent.
const MEMORY: MemorySeed[] = [
  {
    ns: 'rate-limits',
    key: 'visma.salesorder.rpm',
    value: '300 requests / min per tenant',
    by: 'RS',
    agoMs: 2 * HOUR,
    confidence: 0.96,
    source: 'docs.visma.net · salesorder',
    readBy: ['CD', 'OP'],
    expires: '2026-12-06',
  },
  {
    ns: 'rate-limits',
    key: 'shopify.admin.cost',
    value: '1000 cost points / 50 s, leaky bucket',
    by: 'RS',
    agoMs: 3 * DAY,
    confidence: 0.98,
    source: 'shopify.dev · rate limits',
    readBy: ['CD'],
    expires: '2027-01-15',
  },
  {
    ns: 'rate-limits',
    key: 'younium.api.rpm',
    value: '60 requests / min — unverified',
    by: 'RS',
    agoMs: 12 * DAY,
    confidence: 0.61,
    source: 'support ticket #4471',
    readBy: ['CD'],
    expires: '2026-11-20',
  },
  {
    ns: 'facts',
    key: 'visma.journal.voucher_series',
    value: 'Series "AI" reserved for agent-created vouchers',
    by: 'user',
    agoMs: 4 * DAY,
    confidence: 0.99,
    source: 'decision · Jesper',
    readBy: ['CD', 'RV'],
    expires: null,
  },
  {
    ns: 'facts',
    key: 'shopify.order.financial_status',
    value: 'Only "paid" orders sync; "authorized" waits',
    by: 'RS',
    agoMs: 3 * DAY,
    confidence: 0.95,
    source: 'sync/orders.ts',
    readBy: ['CD', 'RV'],
    expires: null,
  },
  {
    ns: 'facts',
    key: 'sie.encoding',
    value: 'Daily SIE files arrive as CP437, not UTF-8',
    by: 'RS',
    agoMs: 9 * DAY,
    confidence: 0.92,
    source: 'flight_8e1200',
    readBy: ['CD'],
    expires: null,
  },
  {
    ns: 'decisions',
    key: 'pr.merge_policy',
    value: 'Reviewer approves, humans merge',
    by: 'user',
    agoMs: 7 * DAY,
    confidence: 1,
    source: 'decision · Jesper',
    readBy: ['CD', 'RV', 'OP'],
    expires: null,
  },
  {
    ns: 'decisions',
    key: 'billing.tests_required',
    value: 'Any change under /billing needs a test',
    by: 'user',
    agoMs: 14 * DAY,
    confidence: 1,
    source: 'decision · Jesper',
    readBy: ['CD', 'RV'],
    expires: null,
  },
  {
    ns: 'incidents',
    key: 'inngest.inventory.sync.retries',
    value: 'Retries spiked 09:10–09:40; cause: Shopify 429',
    by: 'OP',
    agoMs: 3 * HOUR,
    confidence: 0.88,
    source: 'flight_8f39b7',
    readBy: ['RS'],
    expires: '2026-11-13',
  },
  {
    ns: 'incidents',
    key: 'younium.oauth.expired',
    value: 'Younium refresh token rejected — tool needs re-auth before sync flights resume',
    by: 'OP',
    agoMs: 1 * DAY,
    confidence: 0.99,
    source: 'Younium · token refresh',
    readBy: ['CD'],
    expires: '2026-11-20',
  },
  {
    ns: 'tenants',
    key: 'tenant.acme.visma_company',
    value: 'Company 1042 · SEK · fiscal year Jan–Dec',
    by: 'RS',
    agoMs: 7 * DAY,
    confidence: 0.97,
    source: 'Visma.net · company',
    readBy: ['CD', 'OP'],
    expires: null,
  },
  {
    ns: 'tenants',
    key: 'tenant.nordic.shopify_shop',
    value: 'nordic-outdoor.myshopify.com · 2 locations',
    by: 'RS',
    agoMs: 7 * DAY,
    confidence: 0.97,
    source: 'Shopify Admin · shop',
    readBy: ['CD'],
    expires: null,
  },
];

// ─── runs (finished ones only — live runs come from the engine) ───────────

type StepSeed = {
  agent: AgentSlug | 'magpipe';
  what: string;
  sec: number;
  tokens: number;
  state: 'done' | 'failed';
  /** What the step did in a bound repository (D29). */
  work?: StepWork;
};
type RunSeed = {
  id: string;
  task: string;
  status: 'done' | 'failed';
  started: string;
  steps: StepSeed[];
};

const RUNS: RunSeed[] = [
  {
    id: '8f39e0',
    task: 'Rotate Visma.net client secret for tenant acme',
    status: 'done',
    started: '09:52',
    steps: [
      { agent: 'magpipe', what: 'Route to Operator', sec: 1, tokens: 0, state: 'done' },
      {
        agent: 'operator',
        what: 'Rotate secret, verify token',
        sec: 47,
        tokens: 4_000,
        state: 'done',
      },
    ],
  },
  {
    id: '8f39b7',
    task: 'Investigate Inngest retries on inventory.sync',
    status: 'done',
    started: '09:20',
    steps: [
      { agent: 'magpipe', what: 'Split into 2 subtasks', sec: 2, tokens: 0, state: 'done' },
      {
        agent: 'researcher',
        what: 'Query failed runs (CEL)',
        sec: 130,
        tokens: 19_000,
        state: 'done',
      },
      { agent: 'operator', what: 'Post summary to Slack', sec: 20, tokens: 8_000, state: 'done' },
    ],
  },
  {
    id: '8f3972',
    task: 'Add Younium invoice webhook handler',
    status: 'failed',
    started: '08:47',
    steps: [
      { agent: 'magpipe', what: 'Route to Coder', sec: 1, tokens: 0, state: 'done' },
      {
        agent: 'coder',
        what: 'Implement handler + tests',
        sec: 580,
        tokens: 180_000,
        state: 'done',
        work: {
          branches: [{ repo: 'integrations', name: 'magpipe/younium-webhook', created: true }],
          files: [
            { repo: 'integrations', path: 'src/webhooks/younium.ts', change: 'created' },
            { repo: 'integrations', path: 'src/webhooks/younium.test.ts', change: 'created' },
            { repo: 'integrations', path: 'src/webhooks/index.ts', change: 'updated' },
          ],
          commits: [
            {
              repo: 'integrations',
              branch: 'magpipe/younium-webhook',
              sha: '4e1c9a2',
              message: 'Add the failing invoice webhook tests',
            },
            {
              repo: 'integrations',
              branch: 'magpipe/younium-webhook',
              sha: 'b7d03f5',
              message: 'Handle Younium invoice webhooks',
            },
          ],
          checks: [
            { repo: 'integrations', script: 'test', exit: 1, seconds: 14.2, timedOut: false },
            { repo: 'integrations', script: 'test', exit: 0, seconds: 13.8, timedOut: false },
            { repo: 'integrations', script: 'lint', exit: 0, seconds: 6.1, timedOut: false },
          ],
        },
      },
      {
        agent: 'reviewer',
        what: 'Blocked: missing tenant check',
        sec: 84,
        tokens: 21_000,
        state: 'failed',
      },
    ],
  },
  {
    id: '8f3940',
    task: 'Summarise yesterday’s sync errors',
    status: 'done',
    started: '08:05',
    steps: [
      { agent: 'magpipe', what: 'Route to Researcher', sec: 1, tokens: 0, state: 'done' },
      { agent: 'researcher', what: 'Summarise 14 errors', sec: 71, tokens: 12_000, state: 'done' },
    ],
  },
];

/** Token totals are split 75 / 25 between input and output. Cost is filled in by lib/pricing.ts (PR 5). */
const splitUsage = (tokens: number) => ({
  inputTokens: Math.round(tokens * 0.75),
  outputTokens: tokens - Math.round(tokens * 0.75),
  costUsd: 0,
});

// ─── build ─────────────────────────────────────────────────────────────────

export type SeedData = {
  agents: Agent[];
  tools: Tool[];
  namespaces: MemoryNamespace[];
  memory: MemoryEntry[];
  runs: Run[];
  runEvents: NewRunEvent[];
  settings: Settings;
  runCounter: number;
};

export function buildSeed(now = new Date()): SeedData {
  const t = now.getTime();
  const at = (agoMs: number) => new Date(t - agoMs);

  const agentDocs: Agent[] = AGENTS.map((a) => ({
    ...a,
    id: agentIdOf(a.slug as AgentSlug),
    tools: TOOLS.flatMap((tool) => {
      const scopes = tool.grants[a.slug as AgentSlug];
      return scopes ? [{ toolId: toolIdOf(tool.slug), scopes }] : [];
    }),
    pauseAfter: false,
    sendBackRounds: 0,
    templateOnly: false,
    status: 'idle',
    createdAt: at(30 * DAY),
    updatedAt: at(30 * DAY),
  }));

  const toolDocs: Tool[] = TOOLS.map(({ grants, calls24h, url, ...tool }) => ({
    ...tool,
    url: url ?? null,
    command: null,
    repository: null,
    id: toolIdOf(tool.slug),
    grantedAgents: (Object.keys(grants) as AgentSlug[]).map(agentIdOf),
    stats: { calls24h, lastCallAt: calls24h > 0 ? at(10 * MIN).toISOString() : null },
    createdAt: at(30 * DAY),
    updatedAt: at(DAY),
  }));

  const namespaces: MemoryNamespace[] = NAMESPACES.map((n) => ({
    id: n.key,
    label: n.label,
    createdAt: at(30 * DAY),
  }));

  const canRead = (slug: AgentSlug, ns: string) =>
    AGENTS.find((a) => a.slug === slug)!.memoryScope.read.includes(ns);

  const memory: MemoryEntry[] = MEMORY.map((m, i) => {
    const updated = at(m.agoMs);
    const writtenBy = m.by === 'user' ? 'user' : agentIdOf(byInitials[m.by]!);
    return {
      id: `mem_seed${String(i + 1).padStart(2, '0')}`,
      ns: m.ns,
      key: m.key,
      value: m.value,
      data: null,
      confidence: m.confidence,
      source: m.source,
      writtenBy,
      readBy: m.readBy
        .map((ini) => byInitials[ini]!)
        .filter((slug) => canRead(slug, m.ns))
        .map(agentIdOf),
      expiresAt: m.expires ? new Date(`${m.expires}T00:00:00Z`) : null,
      verifiedAt: updated,
      stale: m.agoMs > 30 * DAY,
      conflict: false,
      createdAt: updated,
      updatedAt: updated,
      history: [{ value: m.value, confidence: m.confidence, writtenBy, at: updated.toISOString() }],
    };
  });

  // Artboard clock times are kept relative to each other; the latest run started 30 min ago.
  const minutesOf = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h! * 60 + m!;
  };
  const latest = Math.max(...RUNS.map((r) => minutesOf(r.started)));
  const anchor = t - 30 * MIN;

  const runs: Run[] = [];
  const runEvents: NewRunEvent[] = [];
  for (const r of RUNS) {
    const runId = `run_${r.id}`;
    const startedAt = new Date(anchor - (latest - minutesOf(r.started)) * MIN);
    let cursor = startedAt.getTime();
    let prev: string | undefined;

    const plan: Step[] = r.steps.map((s, i) => {
      const id = `s${i + 1}`;
      const begin = new Date(cursor);
      cursor += s.sec * 1000;
      const end = new Date(cursor);
      const agentId = s.agent === 'magpipe' ? null : agentIdOf(s.agent);
      const step: Step = {
        id,
        agentId,
        title: s.what,
        dependsOn: prev ? [prev] : [],
        status: s.state,
        startedAt: begin.toISOString(),
        finishedAt: end.toISOString(),
        usage: splitUsage(s.tokens),
        ...(s.work ? { work: s.work } : {}),
        ...(s.state === 'failed'
          ? { error: { code: 'review_blocked', message: s.what } }
          : { result: { summary: s.what } }),
      };
      prev = id;
      runEvents.push({
        id: `evt_${r.id}s${i + 1}`,
        runId,
        ts: end,
        stepId: id,
        agentId,
        kind: s.agent === 'magpipe' ? 'plan' : s.state === 'failed' ? 'error' : 'message',
        text: s.what,
        payload: null,
      });
      return step;
    });

    const finishedAt = new Date(cursor);
    const tokens = r.steps.reduce((n, s) => n + s.tokens, 0);
    if (r.status === 'done') {
      runEvents.push({
        id: `evt_${r.id}done`,
        runId,
        ts: finishedAt,
        stepId: null,
        agentId: null,
        kind: 'done',
        text: 'Flight landed',
        payload: null,
      });
    }

    runs.push({
      id: runId,
      displayId: `flight_${r.id}`,
      input: { text: r.task, attachments: [] },
      status: r.status,
      plan,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      usage: splitUsage(tokens),
      output:
        r.status === 'done'
          ? {
              markdown: [
                `## ${r.task}`,
                '',
                ...r.steps.map(
                  (s) =>
                    `- **${s.agent === 'magpipe' ? 'Magpipe' : AGENTS.find((a) => a.slug === s.agent)!.name}** — ${s.what}`,
                ),
              ].join('\n'),
              artifacts: [],
            }
          : null,
      parentRunId: null,
      dismissedAt: null,
      createdBy: 'seed',
      createdAt: startedAt,
    });
  }

  return {
    agents: agentDocs,
    tools: toolDocs,
    namespaces,
    memory,
    runs,
    runEvents,
    settings: {
      id: 'settings',
      workspaceName: 'Magpipe',
      region: 'eu-north-1',
      spendCapUsd: 50,
      maxRuns: 2,
      models: { orchestrator: 'claude-opus-5-5', default: 'claude-sonnet-5-5' },
      updatedAt: now,
    },
    runCounter: Math.max(...RUNS.map((r) => parseInt(r.id, 36))),
  };
}

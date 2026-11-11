/**
 * Compile-time guard: every Drizzle table must select exactly the row shape its zod schema
 * describes. If you change one side and not the other, `npm run typecheck` fails here.
 */
import type * as t from './schema';
import type {
  Agent,
  FactoryProject,
  ForgeSettings,
  LinearSettings,
  MemoryEntry,
  MemoryNamespace,
  Run,
  RunEvent,
  Secret,
  Settings,
  Tool,
  TrackerIssue,
} from '../schemas';

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type SchemaChecks = [
  Assert<Equals<typeof t.agents.$inferSelect, Agent>>,
  Assert<Equals<typeof t.runs.$inferSelect, Run>>,
  Assert<Equals<typeof t.runEvents.$inferSelect, RunEvent>>,
  Assert<Equals<typeof t.tools.$inferSelect, Tool>>,
  // `search` is a generated column, not part of the entry.
  Assert<Equals<Omit<typeof t.memory.$inferSelect, 'search'>, MemoryEntry>>,
  Assert<Equals<typeof t.memoryNamespaces.$inferSelect, MemoryNamespace>>,
  Assert<Equals<typeof t.settings.$inferSelect, Settings>>,
  Assert<Equals<typeof t.secrets.$inferSelect, Secret>>,
  Assert<Equals<typeof t.linearSettings.$inferSelect, LinearSettings>>,
  Assert<Equals<typeof t.trackerIssues.$inferSelect, TrackerIssue>>,
  Assert<Equals<typeof t.forgeSettings.$inferSelect, ForgeSettings>>,
  Assert<Equals<typeof t.factoryProjects.$inferSelect, FactoryProject>>,
];

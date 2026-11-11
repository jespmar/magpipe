/**
 * Goals split from a spec (D39), checked by Magpipe rather than left to a reviewer's reading:
 * every acceptance criterion belongs to exactly one goal, dependencies name goals that exist and
 * form no cycle, and two goals that touch the same file are ordered. Client-safe.
 */
import type { Goal } from './schemas';

export type Criterion = { n: number; text: string };

/**
 * The numbered acceptance criteria of a spec: the items under its "Acceptance criteria"
 * heading, in order. Empty when the spec has no such section.
 */
export function acceptanceCriteria(spec: string): Criterion[] {
  const lines = spec.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s+acceptance criteria\b/i.test(l.trim()));
  if (start === -1) return [];
  const out: Criterion[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,6}\s/.test(line.trim())) break;
    const m = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    if (m) out.push({ n: Number(m[1]), text: m[2]!.trim() });
    else if (out.length > 0 && /^\s{2,}\S/.test(line))
      out[out.length - 1]!.text += ` ${line.trim()}`;
  }
  return out;
}

/** Every goal a goal depends on, directly or not; null when the dependencies form a cycle. */
export function goalAncestors(goals: readonly Goal[]): Map<string, Set<string>> | null {
  const byKey = new Map(goals.map((g) => [g.key, g]));
  const memo = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const walk = (key: string): Set<string> | null => {
    const known = memo.get(key);
    if (known) return known;
    if (visiting.has(key)) return null;
    visiting.add(key);
    const out = new Set<string>();
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      const up = walk(dep);
      if (!up) return null;
      out.add(dep);
      for (const a of up) out.add(a);
    }
    visiting.delete(key);
    memo.set(key, out);
    return out;
  };
  for (const g of goals) if (!walk(g.key)) return null;
  return memo;
}

/**
 * What is wrong with a set of goals, each problem a sentence the Goal Builder can act on; empty
 * when they hold. `criteria` are the spec's criterion numbers; null skips the coverage check
 * (a spec without a numbered list).
 */
export function checkGoals(goals: readonly Goal[], criteria: readonly number[] | null): string[] {
  const problems: string[] = [];
  if (goals.length === 0) return ['Record at least one goal.'];
  const keys = new Set<string>();
  for (const g of goals) {
    if (keys.has(g.key)) problems.push(`Two goals share the key ${g.key}.`);
    keys.add(g.key);
  }
  for (const g of goals) {
    for (const d of g.dependsOn) {
      if (d === g.key) problems.push(`${g.key} depends on itself.`);
      else if (!keys.has(d)) problems.push(`${g.key} depends on ${d}, which is not a goal.`);
    }
  }
  if (criteria) {
    const owners = new Map<number, string[]>();
    for (const g of goals) {
      for (const n of new Set(g.criteria)) owners.set(n, [...(owners.get(n) ?? []), g.key]);
    }
    for (const n of criteria) {
      const who = owners.get(n) ?? [];
      if (who.length === 0) problems.push(`Acceptance criterion ${n} belongs to no goal.`);
      if (who.length > 1)
        problems.push(`Acceptance criterion ${n} belongs to ${who.join(' and ')}; give it to one.`);
    }
    for (const [n, who] of owners) {
      if (!criteria.includes(n))
        problems.push(`${who.join(' and ')} name criterion ${n}, which the spec does not have.`);
    }
  }
  if (problems.length > 0) return problems;
  const ancestors = goalAncestors(goals);
  if (!ancestors) return ['The goals depend on each other in a cycle.'];
  // Two goals that touch the same file are ordered: one depends on the other, directly or not.
  for (let i = 0; i < goals.length; i++) {
    for (let j = i + 1; j < goals.length; j++) {
      const a = goals[i]!;
      const b = goals[j]!;
      const shared = a.files.filter((f) => b.files.includes(f));
      if (shared.length === 0) continue;
      if (ancestors.get(a.key)!.has(b.key) || ancestors.get(b.key)!.has(a.key)) continue;
      problems.push(
        `${a.key} and ${b.key} both touch ${shared.join(', ')} but neither depends on the other; order them.`,
      );
    }
  }
  return problems;
}

/** Goals that may run at the same time as each other: no order between them. */
export function parallelGroups(goals: readonly Goal[]): string[][] {
  const ancestors = goalAncestors(goals);
  if (!ancestors) return [];
  const depth = new Map<string, number>();
  const level = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    const g = goals.find((x) => x.key === key)!;
    const d = g.dependsOn.length === 0 ? 0 : 1 + Math.max(...g.dependsOn.map(level));
    depth.set(key, d);
    return d;
  };
  const groups: string[][] = [];
  for (const g of goals) (groups[level(g.key)] ??= []).push(g.key);
  return groups.filter(Boolean);
}

/** The goals as Markdown: the document of the step that recorded them and of the run. */
export function renderGoals(goals: readonly Goal[], criteria: readonly Criterion[] = []): string {
  const text = new Map(criteria.map((c) => [c.n, c.text]));
  const parts = goals.map((g, i) =>
    [
      `## ${i + 1}. ${g.title} (\`${g.key}\`)`,
      '',
      g.summary,
      '',
      `**Acceptance criteria:** ${g.criteria
        .map((n) => (text.has(n) ? `${n}. ${text.get(n)}` : `${n}`))
        .join('; ')}`,
      '',
      `**Files:** ${g.files.map((f) => `\`${f}\``).join(', ')}`,
      '',
      `**Depends on:** ${g.dependsOn.length ? g.dependsOn.map((d) => `\`${d}\``).join(', ') : 'nothing'}`,
    ].join('\n'),
  );
  const groups = parallelGroups(goals);
  const together = groups.filter((g) => g.length > 1);
  const order = groups.length
    ? `\n\n**Order:** ${groups.map((g) => g.map((k) => `\`${k}\``).join(' with ')).join(', then ')}.${
        together.length === 0 ? ' No two goals run at the same time.' : ''
      }`
    : '';
  return `# Goals\n\n${parts.join('\n\n')}${order}`;
}

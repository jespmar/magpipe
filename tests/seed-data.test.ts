import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as s from '@/lib/schemas';
import { buildSeed } from '@/lib/db/seed-data';

const seed = buildSeed(new Date('2026-11-06T12:00:00Z'));

describe('seed data', () => {
  it('validates against the schemas', () => {
    expect(() => z.array(s.agent).parse(seed.agents)).not.toThrow();
    expect(() => z.array(s.tool).parse(seed.tools)).not.toThrow();
    expect(() => z.array(s.memoryNamespace).parse(seed.namespaces)).not.toThrow();
    expect(() => z.array(s.memoryEntry).parse(seed.memory)).not.toThrow();
    expect(() => z.array(s.run).parse(seed.runs)).not.toThrow();
    expect(() => z.array(s.newRunEvent).parse(seed.runEvents)).not.toThrow();
    expect(() => s.settings.parse(seed.settings)).not.toThrow();
  });

  it('matches the design inventory (spec §9)', () => {
    expect(seed.agents.map((a) => a.name)).toEqual(['Researcher', 'Coder', 'Reviewer', 'Operator']);
    expect(seed.tools).toHaveLength(9);
    expect(seed.tools.find((t) => t.slug === 'younium')?.status).toBe('needs_auth');
    expect(seed.memory.length).toBeGreaterThanOrEqual(12);
    expect(new Set(seed.memory.map((m) => m.ns))).toEqual(
      new Set(seed.namespaces.map((n) => n.id)),
    );
    expect(seed.runs.every((r) => r.status === 'done' || r.status === 'failed')).toBe(true);
  });

  it('keeps tool grants and agent tools in sync, with scopes the tool offers', () => {
    for (const tool of seed.tools) {
      for (const agentId of tool.grantedAgents) {
        const agent = seed.agents.find((a) => a.id === agentId);
        expect(agent, `${tool.slug} granted to unknown ${agentId}`).toBeDefined();
        const grant = agent!.tools.find((g) => g.toolId === tool.id);
        expect(grant, `${agent!.slug} missing ${tool.slug}`).toBeDefined();
        for (const scope of grant!.scopes) expect(tool.scopes).toContain(scope);
      }
    }
    const grants = seed.agents.flatMap((a) => a.tools.map((g) => [a.id, g.toolId] as const));
    for (const [agentId, toolId] of grants) {
      expect(seed.tools.find((t) => t.id === toolId)?.grantedAgents).toContain(agentId);
    }
  });

  it('only lets agents write and read memory inside their scope (spec §7.3)', () => {
    const byId = new Map(seed.agents.map((a) => [a.id, a]));
    for (const m of seed.memory) {
      if (m.writtenBy !== 'user') {
        expect(
          byId.get(m.writtenBy)?.memoryScope.write,
          `${m.key} written outside scope`,
        ).toContain(m.ns);
      }
      for (const reader of m.readBy) {
        expect(byId.get(reader)?.memoryScope.read, `${m.key} read outside scope`).toContain(m.ns);
      }
    }
  });

  it('has unique (ns, key) pairs and ordered run steps', () => {
    const keys = seed.memory.map((m) => `${m.ns}/${m.key}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const run of seed.runs) {
      expect(run.displayId).toBe(run.id.replace('run_', 'flight_'));
      for (const step of run.plan) {
        for (const dep of step.dependsOn) expect(run.plan.map((p) => p.id)).toContain(dep);
      }
      expect(seed.runEvents.some((e) => e.runId === run.id)).toBe(true);
    }
    expect(seed.runCounter).toBe(
      Math.max(...seed.runs.map((r) => parseInt(r.displayId.slice(7), 36))),
    );
  });
});

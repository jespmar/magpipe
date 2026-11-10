/**
 * Write locks for bound repositories (D28): first come first served, several keys without
 * deadlock, cancellation that gives back what it took, and which agents need a lock at all.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireWriteLocks, lockHolder, writeTargets } from '@/lib/engine/locks';
import type { Tool } from '@/lib/schemas';

const never = () => new AbortController().signal;
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('acquireWriteLocks', () => {
  it('lets one holder at a time through, in the order they asked', async () => {
    const order: string[] = [];
    const releaseA = await acquireWriteLocks(['k1'], 'A', never());
    expect(lockHolder('k1')).toBe('A');
    const waits: string[] = [];
    const b = acquireWriteLocks(['k1'], 'B', never(), (_k, holder) => void waits.push(holder)).then(
      (release) => {
        order.push('B');
        return release;
      },
    );
    const c = acquireWriteLocks(['k1'], 'C', never()).then((release) => {
      order.push('C');
      return release;
    });
    await tick();
    expect(order).toEqual([]);
    expect(waits).toEqual(['A']);
    releaseA();
    const releaseB = await b;
    expect(lockHolder('k1')).toBe('B');
    await tick();
    expect(order).toEqual(['B']);
    releaseB();
    releaseB(); // releasing twice is harmless
    (await c)();
    expect(order).toEqual(['B', 'C']);
    expect(lockHolder('k1')).toBeNull();
  });

  it('takes several keys in sorted order, so crossed requests cannot deadlock', async () => {
    const first = await acquireWriteLocks(['y', 'x'], 'first', never());
    let second = false;
    const waiting = acquireWriteLocks(['x', 'y'], 'second', never()).then((r) => {
      second = true;
      return r;
    });
    await tick();
    expect(second).toBe(false);
    first();
    (await waiting)();
    expect(second).toBe(true);
    expect(lockHolder('x')).toBeNull();
    expect(lockHolder('y')).toBeNull();
  });

  it('stops waiting when cancelled, gives back what it took, and lets the next one in', async () => {
    const holder = await acquireWriteLocks(['b'], 'holder', never());
    const cancel = new AbortController();
    const cancelled = acquireWriteLocks(['a', 'b'], 'cancelled', cancel.signal);
    await tick();
    expect(lockHolder('a')).toBe('cancelled'); // took a, waits for b
    let third = false;
    const next = acquireWriteLocks(['a'], 'third', never()).then((r) => {
      third = true;
      return r;
    });
    cancel.abort();
    await expect(cancelled).rejects.toThrow('Cancelled');
    (await next)();
    expect(third).toBe(true);
    holder();
    expect(lockHolder('a')).toBeNull();
    expect(lockHolder('b')).toBeNull();
  });
});

describe('writeTargets', () => {
  let dir: string;
  let repo: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-locks-'));
    repo = path.join(dir, 'app');
    fs.mkdirSync(path.join(repo, 'docs', 'plans'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const tools = (): Pick<Tool, 'id' | 'name' | 'repository'>[] => [
    { id: 'tool_app', name: 'App', repository: { path: repo, scripts: ['test'], timeoutSec: 60 } },
    {
      id: 'tool_plans',
      name: 'App plans',
      repository: { path: path.join(repo, 'docs', 'plans'), scripts: [], timeoutSec: 60 },
    },
    { id: 'tool_mcp', name: 'GitHub', repository: null },
  ];

  it('names a work tree only for agents that can change it', async () => {
    const key = fs.realpathSync(repo);
    const writer = { tools: [{ toolId: 'tool_app', scopes: ['read', 'write'] }] };
    expect(await writeTargets(writer, tools())).toEqual([{ key, name: 'App' }]);
    const reader = { tools: [{ toolId: 'tool_app', scopes: ['read', 'git_diff'] }] };
    expect(await writeTargets(reader, tools())).toEqual([]);
    const tester = { tools: [{ toolId: 'tool_app', scopes: ['run'] }] };
    expect(await writeTargets(tester, tools())).toEqual([{ key, name: 'App' }]);
    // `run` changes nothing where no script is allowed; an MCP grant never locks.
    const plansRun = {
      tools: [
        { toolId: 'tool_plans', scopes: ['run'] },
        { toolId: 'tool_mcp', scopes: ['x'] },
      ],
    };
    expect(await writeTargets(plansRun, tools())).toEqual([]);
    // The plans folder is the same work tree as the app: one key, not two.
    const both = {
      tools: [
        { toolId: 'tool_plans', scopes: ['write'] },
        { toolId: 'tool_app', scopes: ['git_commit'] },
      ],
    };
    expect(await writeTargets(both, tools())).toEqual([{ key, name: 'App plans' }]);
  });
});

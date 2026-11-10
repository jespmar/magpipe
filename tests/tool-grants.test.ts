/**
 * What a grant allows (D25): an agent's grant names the tools it may call, an empty grant allows
 * none, and a grant made before a server's tools were known is filled the first time they are.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { registryText } from '@/lib/engine/plan';
import type { Agent } from '@/lib/schemas';
import { connectTool, retestTool, updateTool } from '@/lib/tools';
import { fillPendingGrant, grantAllows } from '@/lib/tools-util';

describe('grantAllows', () => {
  it('allows the tools a grant names and nothing else', () => {
    expect(grantAllows({ scopes: ['read_file', 'list_directory'] }, 'read_file')).toBe(true);
    expect(grantAllows({ scopes: ['read_file'] }, 'write_file')).toBe(false);
  });

  it('allows nothing when the grant names nothing', () => {
    expect(grantAllows({ scopes: [] }, 'read_file')).toBe(false);
    expect(grantAllows({ scopes: [] }, 'fs:rw')).toBe(false);
  });
});

describe('fillPendingGrant', () => {
  const grants = [
    { toolId: 'tool_a', scopes: [] },
    { toolId: 'tool_b', scopes: [] },
    { toolId: 'tool_c', scopes: ['x'] },
  ];

  it('fills only the empty grant for the tool that was found', () => {
    expect(fillPendingGrant(grants, 'tool_a', ['echo', 'ping'])).toEqual([
      { toolId: 'tool_a', scopes: ['echo', 'ping'] },
      { toolId: 'tool_b', scopes: [] },
      { toolId: 'tool_c', scopes: ['x'] },
    ]);
  });

  it('leaves a grant that already names tools, and reports nothing to do', () => {
    expect(fillPendingGrant(grants, 'tool_c', ['x', 'y'])).toBeNull();
    expect(fillPendingGrant(grants, 'tool_missing', ['x'])).toBeNull();
    expect(fillPendingGrant(grants, 'tool_a', [])).toBeNull();
  });
});

describe('registryText', () => {
  it('lists only the grants that allow something', () => {
    const agent = {
      slug: 'coder',
      name: 'Coder',
      role: 'Writes code',
      description: 'Writes the change',
      model: 'claude-opus-5-5',
      builtins: ['files.read'],
      tools: [
        { toolId: 'tool_empty', scopes: [] },
        { toolId: 'tool_git', scopes: ['git_status'] },
      ],
      memoryScope: { read: [], write: [] },
    } as unknown as Agent;
    const text = registryText([agent]);
    expect(text).toContain('tools: files.read, tool_git;');
    expect(text).not.toContain('tool_empty');
  });
});

describe('grants made before a server answers', () => {
  let db: Db;
  let close: () => Promise<void>;
  let dir: string;
  beforeAll(async () => {
    ({ db, close } = await openDb('memory://'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-grants-'));
  }, 30_000);
  afterAll(async () => {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const coderGrant = async (toolId: string) => {
    const [coder] = await db.select().from(t.agents).where(eq(t.agents.slug, 'coder'));
    return coder!.tools.find((g) => g.toolId === toolId);
  };

  it('are filled with every tool on the first successful probe, and only then', async () => {
    const { tool, probe } = await connectTool(db, {
      name: 'Echo later',
      transport: 'stdio',
      command: 'no-such-mcp-binary --serve',
      auth: { type: 'none' },
      grant: ['coder'],
    });
    expect(probe.ok).toBe(false);
    expect(tool.scopes).toEqual([]);
    // Granted, but the server's tools are unknown: the grant names nothing and allows nothing.
    expect(await coderGrant(tool.id)).toEqual({ toolId: tool.id, scopes: [] });

    const script = path.join(dir, 'echo.js');
    fs.writeFileSync(
      script,
      `let buf='';process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))!==-1){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'echo',version:'0'}}:{tools:[{name:'echo'},{name:'ping'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});`,
    );
    const fixed = await updateTool(db, tool.id, {
      command: `"${process.execPath}" "${script}"`,
    });
    expect(fixed!.tool.scopes).toEqual(['echo', 'ping']);
    expect(await coderGrant(tool.id)).toEqual({ toolId: tool.id, scopes: ['echo', 'ping'] });

    // Once the tools are known, an empty grant is the operator's choice and stays empty.
    const [coder] = await db.select().from(t.agents).where(eq(t.agents.slug, 'coder'));
    await db
      .update(t.agents)
      .set({
        tools: coder!.tools.map((g) => (g.toolId === tool.id ? { ...g, scopes: [] } : g)),
      })
      .where(eq(t.agents.id, coder!.id));
    await retestTool(db, tool.id);
    expect(await coderGrant(tool.id)).toEqual({ toolId: tool.id, scopes: [] });
  }, 20_000);
});

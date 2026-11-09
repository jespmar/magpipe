import { describe, expect, it } from 'vitest';
import { toolPatch } from '@/lib/schemas';
import {
  CONNECT_EXAMPLE,
  describeProbe,
  glyphOf,
  kindLabel,
  matchesToolQuery,
  parseConnectJson,
} from '@/lib/tools-util';

describe('parseConnectJson', () => {
  it('accepts the example from the design', () => {
    const parsed = parseConnectJson(CONNECT_EXAMPLE);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.name).toBe('younium');
      expect(parsed.data.auth).toEqual({
        type: 'oauth2',
        scopes: ['invoices:read', 'customers:read'],
      });
      expect(parsed.data.grant).toEqual(['researcher', 'coder']);
    }
  });
  it('fills defaults and names the first problem', () => {
    const minimal = parseConnectJson('{"name":"x","transport":"stdio","command":"npx -y srv"}');
    expect(minimal.ok).toBe(true);
    if (minimal.ok) expect(minimal.data.auth).toEqual({ type: 'none' });
    expect(parseConnectJson('{"name":')).toMatchObject({ ok: false });
    expect(parseConnectJson('{"name":"x","transport":"http"}')).toEqual({
      ok: false,
      error: 'An http server needs a url',
    });
    expect(parseConnectJson('{"name":"x","transport":"http","url":"nope"}')).toMatchObject({
      ok: false,
      error: 'The url must be a full http(s) address',
    });
    expect(parseConnectJson('{"transport":"http","url":"http://a"}')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/\(name\)$/),
    });
  });
});

describe('labels', () => {
  it('derives glyphs and kinds', () => {
    expect(glyphOf('Younium')).toBe('YO');
    expect(glyphOf('Workspace FS')).toBe('WF');
    expect(kindLabel({ kind: 'mcp', category: 'ERP' })).toBe('MCP · ERP');
    expect(kindLabel({ kind: 'builtin', category: 'Files' })).toBe('Built-in · Files');
  });
  it('searches across name, category, description and tool names', () => {
    const tool = {
      name: 'GitHub',
      slug: 'github',
      category: 'Code',
      description: 'Repos and PRs',
      scopes: ['pr:rw'],
    };
    expect(matchesToolQuery(tool, 'PR:')).toBe(true);
    expect(matchesToolQuery(tool, 'code')).toBe(true);
    expect(matchesToolQuery(tool, 'slack')).toBe(false);
  });
  it('says what a probe found', () => {
    expect(
      describeProbe(
        { ok: true, server: null, tools: [{ name: 'a' }, { name: 'b' }] },
        'GitHub',
        true,
      ),
    ).toBe('GitHub connected · 2 tools found.');
    expect(describeProbe({ ok: true, server: null, tools: [] }, 'GitHub', false)).toBe(
      'GitHub connected · no tools exposed.',
    );
    expect(
      describeProbe({ ok: false, status: 'needs_auth', error: 'HTTP 401' }, 'Younium', true),
    ).toBe('Younium saved · needs auth: HTTP 401.');
    expect(
      describeProbe({ ok: false, status: 'error', error: 'Could not reach x' }, 'Younium', false),
    ).toBe('Younium: Could not reach x.');
  });
});

describe('toolPatch', () => {
  it('never fills defaults, so a token-only patch leaves the rest alone', () => {
    expect(toolPatch.parse({ auth: { type: 'bearer', token: 't' } })).toEqual({
      auth: { type: 'bearer', token: 't' },
    });
  });
});

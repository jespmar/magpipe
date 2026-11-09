import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDesktopConfig } from '@/electron/config';

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-cfg-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadDesktopConfig', () => {
  it('writes a template on first launch and drops empty values', () => {
    const dir = tmp();
    const cfg = loadDesktopConfig(dir);
    expect(fs.existsSync(cfg.configPath)).toBe(true);
    expect(cfg.env.MAGPIPE_REGION).toBe('local');
    expect(cfg.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(cfg.env).toMatchObject({
      MAGPIPE_DATA_DIR: path.join(dir, 'data'),
      MAGPIPE_DESKTOP: '1',
      AUTH_TRUST_HOST: 'true',
      MAGPIPE_CONFIG_PATH: cfg.configPath,
    });
  });

  it('generates AUTH_SECRET and MAGPIPE_SECRET_KEY once and keeps them across launches', () => {
    const dir = tmp();
    const first = loadDesktopConfig(dir).env;
    expect(first.AUTH_SECRET).toMatch(/^[\w-]{40,}$/);
    expect(first.MAGPIPE_SECRET_KEY).toMatch(/^[\w-]{40,}$/);
    expect(first.MAGPIPE_SECRET_KEY).not.toBe(first.AUTH_SECRET);
    const again = loadDesktopConfig(dir).env;
    expect(again.AUTH_SECRET).toBe(first.AUTH_SECRET);
    expect(again.MAGPIPE_SECRET_KEY).toBe(first.MAGPIPE_SECRET_KEY);
  });

  it('prefers values from magpipe.env', () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, 'magpipe.env'),
      'ANTHROPIC_API_KEY=sk-test\nAUTH_SECRET=from-file\n',
    );
    const { env } = loadDesktopConfig(dir);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.AUTH_SECRET).toBe('from-file');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fsRead, fsWrite, resolveInside, shellRun, splitArgs } from '@/lib/engine/sandbox';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-sandbox-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('sandbox', () => {
  it('keeps paths inside the workspace', async () => {
    expect(() => resolveInside(dir, '../etc/passwd')).toThrow(/escapes/);
    expect(() => resolveInside(dir, '/etc/passwd')).toThrow(/escapes/);
    await fsWrite(dir, 'notes/a.txt', 'hello');
    expect(await fsRead(dir, 'notes/a.txt')).toBe('hello');
    expect(await fsRead(dir, 'notes')).toBe('a.txt');
  });
  it('runs only allow-listed commands without a shell', async () => {
    const ok = await shellRun(dir, 'ls notes');
    expect(ok.stdout.trim()).toBe('a.txt');
    expect(ok.code).toBe(0);
    await expect(shellRun(dir, 'rm -rf notes')).rejects.toThrow(/allow-list/);
    await expect(shellRun(dir, 'cat ../secret')).rejects.toThrow(/inside the workspace/);
    await expect(shellRun(dir, 'cat /etc/hostname')).rejects.toThrow(/inside the workspace/);
    expect(splitArgs(`grep -n "two words" a.txt`)).toEqual(['grep', '-n', 'two words', 'a.txt']);
  });
});

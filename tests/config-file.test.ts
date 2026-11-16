/**
 * The config file editor (D48): magpipe.env read and saved from Settings. Saving checks the text,
 * refuses what would break the app or overwrite a change made elsewhere, and writes the file in
 * one step, owner-only; what waits for a restart is named.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkConfigText, readConfigFile, saveConfigFile } from '@/lib/config-file';

const KEEP = [
  'MAGPIPE_CONFIG_PATH',
  'MAGPIPE_AUTH_DISABLED',
  'MAGPIPE_REGION',
  'MAGPIPE_MODEL_BACKEND',
  'MAGPIPE_SECRET_KEY',
  'MAGPIPE_DESKTOP_TOKEN',
] as const;

describe('the config file editor', () => {
  let dir: string;
  let file: string;
  const saved: Partial<Record<(typeof KEEP)[number], string>> = {};

  beforeAll(() => {
    for (const k of KEEP) saved[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-config-'));
    file = path.join(dir, 'magpipe.env');
    process.env.MAGPIPE_CONFIG_PATH = file;
    process.env.MAGPIPE_AUTH_DISABLED = 'true';
    delete process.env.MAGPIPE_DESKTOP_TOKEN;
    // As the desktop app passes them at launch.
    process.env.MAGPIPE_REGION = 'local';
    process.env.MAGPIPE_MODEL_BACKEND = 'claude-code';
    process.env.MAGPIPE_SECRET_KEY = 'sealed-key-from-the-file';
  });
  afterEach(() => {
    process.env.MAGPIPE_AUTH_DISABLED = 'true';
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of KEEP) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const write = (text: string) => fs.writeFileSync(file, text, { mode: 0o600 });

  it('is not offered to a hosted app with sign-in', async () => {
    write('MAGPIPE_REGION=local\n');
    delete process.env.MAGPIPE_AUTH_DISABLED;
    expect(await readConfigFile()).toBeNull();
    await expect(saveConfigFile('MAGPIPE_REGION=x\n', 'v')).rejects.toThrow(
      'This app has no config file to edit here.',
    );
  });

  it('reads the file with what each key is for, and what waits for a restart', async () => {
    write(
      '# Magpipe\nMAGPIPE_REGION=local\nMAGPIPE_MODEL_BACKEND=claude-code\nMAGPIPE_SECRET_KEY=sealed-key-from-the-file\nANTHROPIC_API_KEY=\n',
    );
    const read = (await readConfigFile())!;
    expect(read.path).toBe(file);
    expect(read.text).toContain('# Magpipe');
    expect(read.pending).toEqual([]);
    expect(read.notes).toEqual([]);
    const region = read.keys.find((k) => k.key === 'MAGPIPE_REGION')!;
    expect(region).toMatchObject({ set: true, pending: false });
    expect(read.keys.find((k) => k.key === 'ANTHROPIC_API_KEY')).toMatchObject({
      set: false,
      secret: true,
    });
    // Keys Magpipe sets itself are not listed for editing.
    expect(read.keys.map((k) => k.key)).not.toContain('MAGPIPE_DATA_DIR');
  });

  it('saves in one step, owner-only, and names what a restart applies', async () => {
    const read = (await readConfigFile())!;
    const next = read.text.replace('MAGPIPE_REGION=local', 'MAGPIPE_REGION=studio');
    const saved = await saveConfigFile(next, read.version);
    expect(fs.readFileSync(file, 'utf8')).toBe(next);
    expect(saved.pending).toEqual(['MAGPIPE_REGION']);
    expect(saved.keys.find((k) => k.key === 'MAGPIPE_REGION')).toMatchObject({ pending: true });
    expect(saved.version).not.toBe(read.version);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    // Nothing is left beside it.
    expect(fs.readdirSync(dir)).toEqual(['magpipe.env']);
    // Line endings are made plain and the file ends with one newline.
    const crlf = await saveConfigFile(
      'MAGPIPE_REGION=studio\r\nMAGPIPE_SECRET_KEY=sealed-key-from-the-file\r\n\r\n',
      saved.version,
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(
      'MAGPIPE_REGION=studio\nMAGPIPE_SECRET_KEY=sealed-key-from-the-file\n',
    );
    expect(crlf.text).toBe(fs.readFileSync(file, 'utf8'));
  });

  it('refuses to overwrite a change made elsewhere since it was opened', async () => {
    const read = (await readConfigFile())!;
    write(`${read.text}MAGPIPE_REGION=edited-elsewhere\n`);
    await expect(saveConfigFile('MAGPIPE_REGION=mine\n', read.version)).rejects.toThrow(
      'The file changed outside Magpipe since you opened it.',
    );
    expect(fs.readFileSync(file, 'utf8')).toContain('edited-elsewhere');
  });

  it('refuses a value a key does not take, and a change to the key that seals stored secrets', async () => {
    write('MAGPIPE_SECRET_KEY=sealed-key-from-the-file\n');
    let read = (await readConfigFile())!;
    await expect(
      saveConfigFile(`${read.text}MAGPIPE_MODEL_BACKEND=openai\n`, read.version),
    ).rejects.toThrow('MAGPIPE_MODEL_BACKEND takes claude-code or api, not openai.');
    await expect(
      saveConfigFile('MAGPIPE_SECRET_KEY=something-else\n', read.version),
    ).rejects.toThrow('MAGPIPE_SECRET_KEY must stay as it is');
    // Taken out of the file, another key would be used: the same.
    await expect(saveConfigFile('MAGPIPE_REGION=x\n', read.version)).rejects.toThrow(
      'MAGPIPE_SECRET_KEY must stay as it is',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('MAGPIPE_SECRET_KEY=sealed-key-from-the-file\n');
    // With no key in the file, adding one is the same change.
    write('MAGPIPE_REGION=local\n');
    read = (await readConfigFile())!;
    await expect(
      saveConfigFile('MAGPIPE_REGION=local\nMAGPIPE_SECRET_KEY=new\n', read.version),
    ).rejects.toThrow('MAGPIPE_SECRET_KEY must stay as it is');
  });

  it('warns about what it ignores or cannot find, and saves anyway', async () => {
    const notes = await checkConfigText(
      [
        'MAGPIPE_REGOIN=typo',
        'this is not a setting',
        'MAGPIPE_DATA_DIR=/elsewhere',
        `MAGPIPE_CLAUDE_PATH=${path.join(dir, 'no-claude')}`,
        'MAGPIPE_MODEL_BACKEND=api',
      ].join('\n'),
      null,
    );
    expect(notes.map((n) => [n.tone, n.text])).toEqual([
      ['warning', 'Line 2 is not KEY=value or a # comment, so it is ignored.'],
      ['warning', 'MAGPIPE_REGOIN is not a setting Magpipe reads. A typo?'],
      ['warning', 'MAGPIPE_DATA_DIR is set by Magpipe itself; this value is ignored.'],
      ['warning', `MAGPIPE_CLAUDE_PATH: there is no command at ${path.join(dir, 'no-claude')}.`],
      [
        'warning',
        'MAGPIPE_MODEL_BACKEND is api but ANTHROPIC_API_KEY is empty: runs would have no key.',
      ],
    ]);
    write('MAGPIPE_REGION=local\n');
    const read = (await readConfigFile())!;
    const saved = await saveConfigFile('MAGPIPE_REGOIN=typo\nMAGPIPE_REGION=local\n', read.version);
    expect(saved.notes.map((n) => n.text)).toEqual([
      'MAGPIPE_REGOIN is not a setting Magpipe reads. A typo?',
    ]);
  });

  it('reads a missing file as empty, and saving makes it', async () => {
    fs.rmSync(file);
    const read = (await readConfigFile())!;
    expect(read.text).toBe('');
    await saveConfigFile('MAGPIPE_REGION=local\n', read.version);
    expect(fs.readFileSync(file, 'utf8')).toBe('MAGPIPE_REGION=local\n');
  });
});

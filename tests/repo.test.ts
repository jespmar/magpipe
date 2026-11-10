/**
 * The repository runner (D27) against a real git repository in a temp folder: binding, the path
 * rules, env files, named scripts with a timeout, and git that never touches the default branch.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gitBranch,
  gitCommit,
  gitDiff,
  gitLog,
  gitStatus,
  inspectRepository,
  isEnvFile,
  repoRead,
  repoRun,
  repoSearch,
  repoToolNames,
  repoWrite,
  resolveRepoPath,
} from '@/lib/repo';

let dir: string;
let repo: string;
const sh = (args: string[]) =>
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-repo-'));
  repo = path.join(dir, 'app');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({
      name: 'app',
      private: true,
      scripts: {
        test: `node -e "console.log('tests ok', process.env.ANTHROPIC_API_KEY ? 'leaked' : 'clean')"`,
        fail: `node -e "console.error('two failed'); process.exit(3)"`,
        slow: `node -e "setTimeout(() => {}, 60000)"`,
        'bad name!': 'true',
      },
    }),
  );
  fs.writeFileSync(path.join(repo, 'src', 'hello.ts'), 'export const hello = "nest";\n');
  fs.writeFileSync(path.join(repo, '.env.example'), 'TOKEN=\n');
  sh(['init', '-q', '-b', 'main']);
  sh(['config', 'user.name', 'Test']);
  sh(['config', 'user.email', 'test@example.com']);
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', 'init']);
  // An env file that is neither tracked nor ignored: the riskiest place for a secret to sit.
  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=shh-secret\n');
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.writeFileSync(path.join(dir, 'outside', 'secret.txt'), 'outside the repository\n');
  fs.symlinkSync(path.join(dir, 'outside'), path.join(repo, 'escape'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('binding', () => {
  it('finds the work tree, the branch, the package manager and the scripts', async () => {
    const found = await inspectRepository(repo);
    expect(found).toMatchObject({
      ok: true,
      branch: 'main',
      packageManager: 'npm',
      scripts: ['test', 'fail', 'slow'],
    });
    if (found.ok) expect(fs.realpathSync(found.root)).toBe(fs.realpathSync(repo));
  });

  it('refuses a relative path, a missing folder, a file and a folder outside git', async () => {
    expect(await inspectRepository('app')).toMatchObject({ ok: false });
    expect(await inspectRepository(path.join(dir, 'nope'))).toMatchObject({ ok: false });
    expect(await inspectRepository(path.join(repo, 'package.json'))).toMatchObject({
      ok: false,
      error: expect.stringContaining('is a file'),
    });
    expect(await inspectRepository(path.join(dir, 'outside'))).toMatchObject({
      ok: false,
      error: expect.stringContaining('not inside a git repository'),
    });
  });

  it('offers run only when a script is allowed', () => {
    expect(repoToolNames({ scripts: ['test'] })).toContain('run');
    expect(repoToolNames({ scripts: [] })).not.toContain('run');
  });
});

describe('paths', () => {
  it('stays inside the folder and keeps .git and env files out', async () => {
    await expect(resolveRepoPath(repo, '../outside/secret.txt')).rejects.toThrow(/leaves/);
    await expect(resolveRepoPath(repo, '/etc/passwd')).rejects.toThrow(/relative/);
    await expect(resolveRepoPath(repo, '.git/config')).rejects.toThrow(/\.git/);
    await expect(resolveRepoPath(repo, '.env')).rejects.toThrow(/Env files/);
    await expect(resolveRepoPath(repo, 'escape/secret.txt')).rejects.toThrow(/leads out/);
    await expect(resolveRepoPath(repo, '.env.example')).resolves.toContain('.env.example');
    await expect(resolveRepoPath(repo, '.env.example', 'write')).rejects.toThrow(/Env files/);
    expect(isEnvFile('.env.local')).toBe(true);
    expect(isEnvFile('.env.example')).toBe(false);
    expect(isEnvFile('environment.ts')).toBe(false);
  });

  it('reads files with line numbers and lists folders without .git', async () => {
    expect((await repoRead(repo, 'src/hello.ts')).text).toBe(
      '1\texport const hello = "nest";\n2\t',
    );
    const listing = (await repoRead(repo, '.')).text.split('\n');
    expect(listing).toEqual(expect.arrayContaining(['src/', 'package.json', '.env.example']));
    expect(listing).not.toContain('.git/');
    expect(await repoRead(repo, 'missing.ts')).toMatchObject({ isError: true });
  });

  it('searches tracked and new files but never env files', async () => {
    expect((await repoSearch(repo, 'nest')).text).toContain('src/hello.ts:1:');
    expect((await repoSearch(repo, 'shh-secret')).text).toBe('No matches for "shh-secret"');
  });
});

describe('scripts', () => {
  it('runs an allowed script without Magpipe secrets, and reports its exit', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak';
    try {
      const config = { path: repo, scripts: ['test', 'fail', 'slow'], timeoutSec: 60 };
      const ok = await repoRun(config, 'test');
      expect(ok.isError).toBe(false);
      expect(ok.text).toMatch(/^\$ npm run test\n/);
      expect(ok.text).toContain('tests ok clean');
      expect(ok.text).toMatch(/exit 0 · [\d.]+ s$/);
      expect(ok.work).toMatchObject({ kind: 'check', script: 'test', exit: 0, timedOut: false });

      const failed = await repoRun(config, 'fail');
      expect(failed).toMatchObject({ isError: true });
      expect(failed.text).toContain('two failed');
      expect(failed.text).toMatch(/exit 3 · /);

      const slow = await repoRun(config, 'slow', { timeoutMs: 1500 });
      expect(slow).toMatchObject({ isError: true });
      expect(slow.text).toContain('Stopped after 2 s without finishing.');
      expect(slow.work).toMatchObject({
        kind: 'check',
        script: 'slow',
        exit: null,
        timedOut: true,
      });

      expect(await repoRun(config, 'deploy')).toMatchObject({
        isError: true,
        text: expect.stringContaining('not a script this repository allows'),
      });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }, 30_000);
});

describe('git', () => {
  it('branches, commits off the default branch only, and leaves env files unstaged', async () => {
    expect((await gitStatus(repo)).text).toContain('## main');
    expect(await gitCommit(repo, 'straight to main', ['src/hello.ts'])).toMatchObject({
      isError: true,
      text: expect.stringContaining('main is the default branch'),
    });
    expect(await gitBranch(repo, '--force', true)).toMatchObject({ isError: true });
    expect(await gitBranch(repo, 'magpipe/feature', true)).toEqual({
      text: 'Created and switched to magpipe/feature',
      work: { kind: 'branch', name: 'magpipe/feature', created: true },
    });

    expect(await repoWrite(repo, 'src/added.ts', 'export const added = 1;\n')).toEqual({
      text: 'Created src/added.ts (24 bytes)',
      work: { kind: 'file', path: 'src/added.ts', change: 'created' },
    });
    // A new file does not block a switch; an edit to a tracked file does.
    fs.appendFileSync(path.join(repo, 'src', 'hello.ts'), 'export const more = 2;\n');
    expect(await gitBranch(repo, 'main', false)).toMatchObject({
      isError: true,
      text: expect.stringContaining('uncommitted changes'),
    });
    const uncommitted = (await gitDiff(repo)).text;
    expect(uncommitted).toContain('New files not yet added:');
    expect(uncommitted).toContain('src/added.ts');

    // Env files, .git and links that lead out cannot be named; everything named is committed.
    expect(await gitCommit(repo, 'leak', ['.env']).catch((e: Error) => e.message)).toMatch(
      /Env files/,
    );
    expect(await gitCommit(repo, 'leak', ['escape']).catch((e: Error) => e.message)).toMatch(
      /leads out/,
    );
    expect(await gitCommit(repo, 'everything', [])).toMatchObject({ isError: true });
    // The operator's own staged work stays staged and out of the agent's commit.
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'mine\n');
    sh(['add', 'notes.txt']);
    const committed = await gitCommit(repo, 'Add the added constant', [
      'src/added.ts',
      'src/hello.ts',
    ]);
    expect(committed.text).toMatch(
      /^Committed on magpipe\/feature: [0-9a-f]+ Add the added constant$/,
    );
    expect(committed.work).toEqual({
      kind: 'commit',
      branch: 'magpipe/feature',
      sha: sh(['rev-parse', '--short', 'HEAD']),
      message: 'Add the added constant',
    });
    expect(sh(['show', '--name-only', '--format=', 'HEAD']).split('\n')).toEqual([
      'src/added.ts',
      'src/hello.ts',
    ]);
    expect(sh(['status', '--porcelain']).split('\n').sort()).toEqual([
      '?? .env',
      '?? escape',
      'A  notes.txt',
    ]);

    const diff = (await gitDiff(repo, 'main')).text;
    expect(diff).toContain('src/added.ts | 1 +');
    expect(diff).toContain('+export const added = 1;');
    expect(await gitDiff(repo, '--output=/tmp/x')).toMatchObject({ isError: true });
    expect((await gitLog(repo, { since: 'main' })).text).toMatch(
      /^[0-9a-f]+ Add the added constant$/,
    );
    expect(await gitCommit(repo, 'again', ['src/added.ts'])).toEqual({
      text: 'Nothing to commit in those files',
    });
    expect(sh(['branch', '--list', 'main'])).toContain('main');
    expect(sh(['log', '-1', '--format=%s', 'main'])).toBe('init');
  }, 30_000);
});

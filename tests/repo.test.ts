/**
 * The repository runner (D27) against a real git repository in a temp folder: binding, the path
 * rules, env files, named scripts with a timeout, and git that never touches the default branch.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
import {
  gitBranch,
  gitCommit,
  gitDiff,
  gitLog,
  gitStatus,
  inspectRepository,
  isEnvFile,
  repoRead,
  nodeDirs,
  pinCommandPath,
  composePath,
  pathFromShellOutput,
  repoRun,
  repoSearch,
  repoToolNames,
  repoWrite,
  resolveRepoPath,
  repositoryEnv,
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

describe('scripts ahead of package.json (D51)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-install-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  // As a factory build run sets it (D53): the lockfile an install writes is kept.
  const config = () => ({ path: dir, scripts: ['test'], timeoutSec: 120, keepLockfiles: true });

  it('says when there is no package.json, or one that is not JSON', async () => {
    expect((await repoRun(config(), 'test')).text).toContain('there is no package.json');
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "scripts": { "test": "x", } }');
    const broken = await repoRun(config(), 'test');
    expect(broken.isError).toBe(true);
    expect(broken.text).toMatch(/^package\.json is not valid JSON \(/);
    expect(broken.work).toBeUndefined();
  });

  const writeDep = (version: string) => {
    fs.mkdirSync(path.join(dir, 'dep'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'dep', 'package.json'),
      JSON.stringify({ name: 'dep', version, main: 'index.js' }),
    );
    fs.writeFileSync(path.join(dir, 'dep', 'index.js'), `module.exports = 'dep ${version}';`);
  };
  const writePackage = (deps: Record<string, string>) =>
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fresh',
        private: true,
        scripts: { test: 'node -e "console.log(require(\'dep\'))"' },
        dependencies: deps,
      }),
    );
  const stateFile = () => path.join(dir, '.git', 'magpipe-install.json');

  it('installs what a new package.json names before the first run, leaving the work tree as it was', async () => {
    writeDep('1.0.0');
    writePackage({ dep: 'file:./dep' });
    // The work tree before: package.json and dep/ are the change, nothing else.
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'the change');
    const ran = await repoRun(config(), 'test');
    expect(ran.isError).toBe(false);
    expect(ran.text).toMatch(/^\$ npm install --ignore-scripts/);
    expect(ran.text).toMatch(/Installed the dependencies in [\d.]+ s\./);
    expect(ran.text).toContain('dep 1.0.0');
    expect(fs.existsSync(path.join(dir, 'node_modules', 'dep'))).toBe(true);
    // node_modules is kept out of git; the lockfile the install wrote is the change's to commit,
    // and the run says so (D53).
    expect(git(dir, 'status', '--porcelain')).toBe('?? package-lock.json');
    expect(ran.text).toContain(
      'The install wrote package-lock.json: commit it with package.json, so a clean install gets the same versions.',
    );
    // Installed once: the next run goes straight to the script.
    const again = await repoRun(config(), 'test');
    expect(again.text).toMatch(/^\$ npm run test/);
  }, 120_000);

  it('installs again when the dependencies change, or when an install was cut off', async () => {
    writeDep('2.0.0');
    writePackage({ dep: 'file:./dep', other: 'file:./dep' });
    const changed = await repoRun(config(), 'test');
    expect(changed.text).toContain('Installed the dependencies');
    expect(changed.text).toContain('dep 2.0.0');
    // A crash mid-install leaves "installing" behind: what is there is thrown away and redone.
    fs.writeFileSync(stateFile(), JSON.stringify({ state: 'installing', key: 'x' }));
    fs.rmSync(path.join(dir, 'node_modules', 'dep'), { recursive: true, force: true });
    const redone = await repoRun(config(), 'test');
    expect(redone.isError).toBe(false);
    expect(redone.text).toContain('Installed the dependencies');
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).state).toBe('done');
  }, 120_000);

  it('leaves a node_modules the operator installed as it is', async () => {
    fs.rmSync(stateFile(), { force: true });
    writePackage({ dep: 'file:./dep', third: 'file:./dep' });
    const ran = await repoRun(config(), 'test');
    expect(ran.text).toMatch(/^\$ npm run test/);
  }, 60_000);

  it('keeps a working node_modules when an update over it fails', async () => {
    // One Magpipe installs, from nothing.
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
    fs.rmSync(stateFile(), { force: true });
    writePackage({ dep: 'file:./dep' });
    expect((await repoRun(config(), 'test')).isError).toBe(false);
    // Magpipe installed it; now the dependencies change and the update fails.
    writePackage({ dep: 'file:./dep', gone: 'file:./missing.tgz' });
    const ran = await repoRun(config(), 'test');
    expect(ran.work).toMatchObject({ skipped: 'install' });
    expect(fs.existsSync(path.join(dir, 'node_modules', 'dep'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).state).toBe('done');
  }, 120_000);

  it('puts back the lockfiles an install cut off by a crash had written', async () => {
    writePackage({ dep: 'file:./dep' });
    // As a crashed install leaves it: "installing", the lockfiles saved before, and a stray one.
    const saved = path.join(dir, '.git', 'magpipe-install-locks');
    fs.mkdirSync(saved, { recursive: true });
    fs.writeFileSync(
      path.join(saved, 'absent.json'),
      JSON.stringify([
        'package-lock.json',
        'npm-shrinkwrap.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'bun.lockb',
        'bun.lock',
      ]),
    );
    fs.writeFileSync(stateFile(), JSON.stringify({ state: 'installing', key: 'x' }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"stray": true}');
    const ran = await repoRun(config(), 'test');
    expect(ran.isError).toBe(false);
    // The stray one is gone; the lockfile there now is the finished install's own.
    expect(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).not.toContain('stray');
    expect(fs.existsSync(saved)).toBe(false);
  }, 120_000);

  it('leaves a node_modules link the operator made in their own checkout', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-nm-'));
    try {
      fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
      fs.cpSync(path.join(dir, 'dep'), path.join(elsewhere, 'dep'), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(dir, 'node_modules'), 'dir');
      writePackage({ dep: 'file:./dep', another: 'file:./dep' });
      const ran = await repoRun(config(), 'test');
      expect(ran.text).toMatch(/^\$ npm run test/);
      expect(fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(path.join(dir, 'node_modules'), { force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 60_000);

  it('says plainly when the package manager cannot be found, and records it as a tool missing (D53)', async () => {
    // A PATH with git and nothing else, as an app opened from Finder may have.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-nopath-'));
    const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.symlinkSync(gitBin, path.join(empty, 'git'));
    pinCommandPath(empty);
    try {
      const ran = await repoRun(config(), 'test');
      expect(ran.isError).toBe(true);
      expect(ran.text).toContain('Magpipe could not find npm on this computer.');
      expect(ran.work).toMatchObject({ kind: 'check', script: 'test', skipped: 'tool' });
    } finally {
      pinCommandPath(undefined);
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('outside a build run, puts the lockfile back; one the repository ignores is never named (D53)', async () => {
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
    fs.rmSync(stateFile(), { force: true });
    fs.rmSync(path.join(dir, 'package-lock.json'), { force: true });
    writePackage({ dep: 'file:./dep' });
    const plain = await repoRun({ ...config(), keepLockfiles: false }, 'test');
    expect(plain.isError).toBe(false);
    expect(fs.existsSync(path.join(dir, 'package-lock.json'))).toBe(false);
    // Ignored by the repository: kept as npm left it, but not the change's to commit.
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
    fs.rmSync(stateFile(), { force: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'package-lock.json\n');
    const ignored = await repoRun(config(), 'test');
    expect(ignored.text).not.toContain('The install wrote');
    fs.rmSync(path.join(dir, '.gitignore'));
  }, 120_000);

  it('a daemon a script leaves behind does not hold a run past its time', async () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'setsid sleep 20 > /dev/stderr & sleep 30' } }),
    );
    const began = Date.now();
    const ran = await repoRun(config(), 'test', { timeoutMs: 1500 });
    expect(ran.text).toContain('without finishing');
    expect(Date.now() - began).toBeLessThan(8000);
  }, 30_000);

  it('records an install that failed as a script that did not run', async () => {
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
    fs.rmSync(stateFile(), { force: true });
    // A tarball that is not there: npm refuses it without the network.
    writePackage({ dep: 'file:./missing.tgz' });
    const ran = await repoRun(config(), 'test');
    expect(ran.isError).toBe(true);
    expect(ran.text).toContain('Its dependencies did not install, so "test" did not run.');
    expect(ran.work).toMatchObject({
      kind: 'check',
      script: 'test',
      exit: null,
      skipped: 'install',
    });
    // Undone: the next run tries again rather than trusting a half-made node_modules.
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(stateFile())).toBe(false);
  }, 120_000);

  it('installs devDependencies and runs the checks outside Magpipe’s production settings (D55)', async () => {
    // The desktop server runs with NODE_ENV=production: an install that sees it leaves out
    // devDependencies, which is where a project's test runner, linter and compiler live.
    const env = process.env as Record<string, string | undefined>;
    const before = { NODE_ENV: env.NODE_ENV, PORT: env.PORT };
    env.NODE_ENV = 'production';
    env.PORT = '3999';
    try {
      writeDep('3.0.0');
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'fresh',
          private: true,
          scripts: {
            test: "node -e \"console.log(require('dep'), process.env.NODE_ENV || 'no NODE_ENV', process.env.PORT || 'no PORT')\"",
          },
          devDependencies: { dep: 'file:./dep' },
        }),
      );
      const ran = await repoRun(config(), 'test');
      expect(ran.isError).toBe(false);
      expect(ran.text).toMatch(/^\$ npm install --ignore-scripts --include=dev/);
      expect(ran.text).toContain('dep 3.0.0 no NODE_ENV no PORT');
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    }
  }, 120_000);

  it('installs again when an install recorded as done is missing a package', async () => {
    // As the installs that left out devDependencies were recorded (D55): done, for these
    // dependencies, and without the package.
    fs.rmSync(path.join(dir, 'node_modules', 'dep'), { recursive: true, force: true });
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).state).toBe('done');
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(true);
    const ran = await repoRun(config(), 'test');
    expect(ran.isError).toBe(false);
    expect(ran.text).toContain('Installed the dependencies');
    expect(ran.text).toContain('dep 3.0.0');
    // Complete again: the next run goes straight to the script.
    expect((await repoRun(config(), 'test')).text).toMatch(/^\$ npm run test/);
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8'))).toMatchObject({ complete: true });
  }, 120_000);

  it('installs once more over an install recorded before D55, then trusts it', async () => {
    const state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    delete state.complete;
    fs.writeFileSync(stateFile(), JSON.stringify(state));
    expect((await repoRun(config(), 'test')).text).toContain('Installed the dependencies');
    expect((await repoRun(config(), 'test')).text).toMatch(/^\$ npm run test/);
  }, 120_000);

  it('does not install again and again when the install itself leaves a package out', async () => {
    // As a bun or workspace config that leaves devDependencies out records it: done, incomplete.
    fs.rmSync(path.join(dir, 'node_modules', 'dep'), { recursive: true, force: true });
    const state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    fs.writeFileSync(stateFile(), JSON.stringify({ ...state, complete: false }));
    const ran = await repoRun(config(), 'test');
    expect(ran.text).toMatch(/^\$ npm run test/);
    expect(ran.isError).toBe(true);
  }, 60_000);

  it('counts a local dependency linked without a package.json as installed', async () => {
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
    fs.rmSync(stateFile(), { force: true });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'index.js'), "module.exports = 'assets';");
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fresh',
        private: true,
        scripts: { test: 'node -e "console.log(require(\'assets\'))"' },
        dependencies: { assets: 'file:./assets' },
      }),
    );
    const first = await repoRun(config(), 'test');
    expect(first.text).toContain('Installed the dependencies');
    expect(first.isError).toBe(false);
    expect((await repoRun(config(), 'test')).text).toMatch(/^\$ npm run test/);
  }, 120_000);

  const has = (tool: string) => {
    try {
      execFileSync(tool, ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  /** A project of its own with one devDependency, `dep`, and the files given. */
  const scratch = (files: Record<string, string>) => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-pm-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: own });
    fs.mkdirSync(path.join(own, 'dep'));
    fs.writeFileSync(
      path.join(own, 'dep', 'package.json'),
      JSON.stringify({ name: 'dep', version: '5.0.0', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(own, 'dep', 'index.js'), "module.exports = 'dep 5.0.0';");
    fs.writeFileSync(
      path.join(own, 'package.json'),
      JSON.stringify({
        name: 'pm-fresh',
        private: true,
        scripts: { test: 'node -e "console.log(require(\'dep\'))"' },
        devDependencies: { dep: 'file:./dep' },
      }),
    );
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(own, name), text);
    return own;
  };

  it('yarn puts back a package removed since its install (D55)', async () => {
    if (!has('yarn')) return;
    const own = scratch({ 'yarn.lock': '' });
    const cfg = { path: own, scripts: ['test'], timeoutSec: 120, keepLockfiles: true };
    try {
      const first = await repoRun(cfg, 'test');
      expect(first.text).toMatch(/^\$ yarn install .*--check-files/);
      expect(first.text).toContain('dep 5.0.0');
      fs.rmSync(path.join(own, 'node_modules', 'dep'), { recursive: true, force: true });
      const again = await repoRun(cfg, 'test');
      expect(again.isError).toBe(false);
      expect(again.text).toContain('dep 5.0.0');
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  }, 120_000);

  it('says what an install its own config cut short left out, and does not repeat it (D55)', async () => {
    if (!has('bun')) return;
    // bun has no flag that brings devDependencies back over a bunfig that leaves them out (and
    // then holds its lockfile frozen, so the one here matches package.json).
    const own = scratch({
      'bun.lock': JSON.stringify({
        lockfileVersion: 1,
        workspaces: { '': { name: 'pm-fresh', devDependencies: { dep: 'file:./dep' } } },
        packages: { dep: ['dep@file:dep', {}] },
      }),
      'bunfig.toml': '[install]\nproduction = true\n',
    });
    const cfg = { path: own, scripts: ['test'], timeoutSec: 120 };
    try {
      const first = await repoRun(cfg, 'test');
      if (first.text.includes('could not find bun')) return;
      expect(first.text).toContain(
        "node_modules still lacks dep: the package manager's own config leaves it out",
      );
      const again = await repoRun(cfg, 'test');
      expect(again.text).toMatch(/^\$ bun run test/);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  }, 120_000);

  it('installs devDependencies with pnpm even where its config says production (D55)', async () => {
    const pnpm = (() => {
      try {
        execFileSync('pnpm', ['--version'], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    })();
    if (!pnpm) return;
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-pnpm-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: own });
      fs.mkdirSync(path.join(own, 'dep'));
      fs.writeFileSync(
        path.join(own, 'dep', 'package.json'),
        JSON.stringify({ name: 'dep', version: '4.0.0', main: 'index.js' }),
      );
      fs.writeFileSync(path.join(own, 'dep', 'index.js'), "module.exports = 'dep 4.0.0';");
      fs.writeFileSync(
        path.join(own, 'package.json'),
        JSON.stringify({
          name: 'pnpm-fresh',
          private: true,
          scripts: { test: 'node -e "console.log(require(\'dep\'))"' },
          devDependencies: { dep: 'file:./dep' },
        }),
      );
      fs.writeFileSync(path.join(own, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      fs.writeFileSync(path.join(own, '.npmrc'), 'production=true\n');
      const ran = await repoRun({ path: own, scripts: ['test'], timeoutSec: 120 }, 'test');
      expect(ran.text).toMatch(/^\$ pnpm install .*--production=false/);
      expect(ran.isError).toBe(false);
      expect(ran.text).toContain('dep 4.0.0');
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('repositoryEnv (D55)', () => {
  it('leaves out Magpipe’s secrets and its own server settings, and keeps the operator’s', () => {
    const env = repositoryEnv({
      HOME: '/home/op',
      PATH: '/usr/bin',
      NODE_OPTIONS: '--max-old-space-size=4096',
      NODE_ENV: 'production',
      PORT: '3999',
      HOSTNAME: '127.0.0.1',
      NEXT_RUNTIME: 'nodejs',
      __NEXT_PRIVATE_ORIGIN: 'x',
      ELECTRON_RUN_AS_NODE: '1',
      npm_config_production: 'true',
      npm_lifecycle_event: 'dev',
      MAGPIPE_DESKTOP_TOKEN: 'secret',
      ANTHROPIC_API_KEY: 'sk',
      // The operator's own: credentials and mirrors their projects read.
      NPM_TOKEN: 'npm-token',
      NPM_CONFIG_REGISTRY: 'https://mirror.example/npm/',
      ELECTRON_MIRROR: 'https://mirror.example/electron/',
      NEXT_TELEMETRY_DISABLED: '1',
      // What git needs to push and clone.
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GIT_ASKPASS: '/usr/bin/askpass',
      GIT_CONFIG_COUNT: '1',
    });
    expect(env).toEqual({
      HOME: '/home/op',
      PATH: '/usr/bin',
      NODE_OPTIONS: '--max-old-space-size=4096',
      NPM_TOKEN: 'npm-token',
      NPM_CONFIG_REGISTRY: 'https://mirror.example/npm/',
      ELECTRON_MIRROR: 'https://mirror.example/electron/',
      NEXT_TELEMETRY_DISABLED: '1',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GIT_ASKPASS: '/usr/bin/askpass',
      GIT_CONFIG_COUNT: '1',
    });
  });

  it('keeps the operator’s lower-case npm_config_* when no npm script started Magpipe', () => {
    expect(
      repositoryEnv({
        HOME: '/home/op',
        TURBOPACK: '1',
        npm_config_registry: 'https://mirror.example/npm/',
        npm_config_https_proxy: 'http://proxy.example:3128',
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({
      HOME: '/home/op',
      npm_config_registry: 'https://mirror.example/npm/',
      npm_config_https_proxy: 'http://proxy.example:3128',
    });
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
      // Allowed before package.json has it (D51): said plainly, nothing is run, and the step's
      // record keeps it as a check that did not run.
      expect(await repoRun({ ...config, scripts: ['typecheck'] }, 'typecheck')).toEqual({
        isError: true,
        text: '"typecheck" did not run: package.json has no script named "typecheck". The operator allows it; until the change adds it, it has not passed.',
        work: {
          kind: 'check',
          script: 'typecheck',
          exit: null,
          seconds: 0,
          timedOut: false,
          skipped: 'missing',
        },
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

describe('finding Node for an app with no PATH of its own (D53)', () => {
  it('reads the PATH a shell printed past whatever its startup files said', () => {
    expect(pathFromShellOutput('Welcome!\nnvm ready\n__MAGPIPE_PATH__/a/bin:/b/bin\n')).toBe(
      '/a/bin:/b/bin',
    );
    expect(pathFromShellOutput('no mark here')).toBeNull();
  });

  it('puts a version manager the shell left out ahead of Homebrew and the system', () => {
    const nvm = '/home/u/.nvm/versions/node/v22.1.0/bin';
    expect(composePath('/opt/homebrew/bin:/usr/bin', '/usr/bin', [nvm, '/opt/homebrew/bin'])).toBe(
      `${nvm}:/opt/homebrew/bin:/usr/bin`,
    );
    // The shell named it already: its own order stands.
    expect(composePath(`/usr/bin:${nvm}`, '', [nvm])).toBe(`/usr/bin:${nvm}`);
  });

  it('follows nvm aliases as nvm does: a major is its newest, lts names another alias', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-home-'));
    try {
      for (const v of ['v22.1.0', 'v22.11.0', 'v20.11.1', 'v23.0.0']) {
        fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', v, 'bin'), { recursive: true });
      }
      fs.mkdirSync(path.join(home, '.nvm', 'alias', 'lts'), { recursive: true });
      const first = async () => (await nodeDirs(home)).filter((d) => d.startsWith(home))[0];
      fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), '22');
      expect(await first()).toBe(path.join(home, '.nvm', 'versions', 'node', 'v22.11.0', 'bin'));
      fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), 'lts/iron');
      fs.writeFileSync(path.join(home, '.nvm', 'alias', 'lts', 'iron'), 'v20.11.1');
      expect(await first()).toBe(path.join(home, '.nvm', 'versions', 'node', 'v20.11.1', 'bin'));
      fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), 'node');
      expect(await first()).toBe(path.join(home, '.nvm', 'versions', 'node', 'v23.0.0', 'bin'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('knows where nvm, Volta and the like put node: the default version first, then the newest', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-home-'));
    try {
      for (const v of ['v18.20.0', 'v22.1.0', 'v20.11.1']) {
        fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', v, 'bin'), { recursive: true });
      }
      fs.mkdirSync(path.join(home, '.nvm', 'alias'), { recursive: true });
      fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), '20\n');
      fs.mkdirSync(path.join(home, '.volta', 'bin'), { recursive: true });
      const dirs = (await nodeDirs(home)).filter((d) => d.startsWith(home));
      expect(dirs).toEqual([
        path.join(home, '.nvm', 'versions', 'node', 'v20.11.1', 'bin'),
        path.join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin'),
        path.join(home, '.nvm', 'versions', 'node', 'v18.20.0', 'bin'),
        path.join(home, '.volta', 'bin'),
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

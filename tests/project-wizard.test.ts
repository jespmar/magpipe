/**
 * The New project wizard (D49): GitHub's repositories and owners, a new repository, its
 * package.json scripts; a clone into a new folder that never lands on files already there and
 * never keeps the token; a new Linear project; and the whole wizard against the scripted tracker
 * and forge, run twice to show a wizard that stopped half-way picks up where it stopped.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkCloneTarget, cloneRepository } from '@/lib/clone';
import { openDb, type Db } from '@/lib/db';
import { saveForgeKey, useForgeFactory } from '@/lib/forge';
import { githubForge } from '@/lib/forge/github';
import { scriptedForge, scriptedForgeStore, SCRIPTED_LOGIN } from '@/lib/forge/scripted';
import { projectView, saveProject } from '@/lib/projects';
import {
  wizardCheckFolder,
  wizardEnsureClone,
  wizardEnsureLinearProject,
  wizardEnsureRepository,
  wizardGitHub,
  wizardRepoScripts,
} from '@/lib/project-wizard';
import { saveLinearKey, useTrackerFactory } from '@/lib/tracker';
import { linearTracker } from '@/lib/tracker/linear';
import { SCRIPTED_TEAM, scriptedStore, scriptedTracker } from '@/lib/tracker/scripted';
import { SCRIPTED_MAPPING } from './stubs/project';

const SECRET = Buffer.from('unit-test-key-unit-test-key-0123').toString('base64url');

type Call = { url: string; method: string; body: unknown };

function fakeFetch(answer: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call = {
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status = 200, json } = answer(call);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

const rawRepo = (owner: string, name: string, push = true) => ({
  full_name: `${owner}/${name}`,
  name,
  owner: { login: owner },
  private: true,
  description: '',
  pushed_at: '2026-10-01T00:00:00Z',
  permissions: { push },
});

describe('GitHub for the wizard', () => {
  it('lists every repository the token can push to, page by page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => rawRepo('me', `r${i}`, i !== 3));
    const f = fakeFetch((c) => ({
      json: c.url.endsWith('&page=1') ? page1 : [rawRepo('acme', 'web')],
    }));
    const repos = await githubForge('ghp_x', f.impl).repositories();
    expect(repos).toHaveLength(100);
    expect(repos.find((r) => r.name === 'r3')).toBeUndefined();
    expect(repos.at(-1)).toEqual({
      fullName: 'acme/web',
      owner: 'acme',
      name: 'web',
      private: true,
      description: null,
      pushedAt: '2026-10-01T00:00:00Z',
    });
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100&page=1',
      'https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100&page=2',
    ]);
  });

  it('names its own account first, and keeps it when the token may not read organizations', async () => {
    const both = fakeFetch((c) => ({
      json: c.url.endsWith('/user') ? { login: 'ada' } : [{ login: 'acme' }],
    }));
    expect(await githubForge('t', both.impl).owners()).toEqual([
      { login: 'ada', kind: 'user' },
      { login: 'acme', kind: 'org' },
    ]);
    const fine = fakeFetch((c) =>
      c.url.endsWith('/user') ? { json: { login: 'ada' } } : { status: 403, json: {} },
    );
    expect(await githubForge('t', fine.impl).owners()).toEqual([{ login: 'ada', kind: 'user' }]);
  });

  it('makes a repository under the account or an organization, with a first commit', async () => {
    const f = fakeFetch((c) =>
      c.method === 'GET'
        ? { json: { login: 'Ada' } }
        : { status: 201, json: rawRepo(c.url.includes('/orgs/') ? 'acme' : 'Ada', 'new') },
    );
    const forge = githubForge('t', f.impl);
    expect(
      (await forge.createRepository({ owner: 'ada', name: 'new', private: true })).fullName,
    ).toBe('Ada/new');
    await forge.createRepository({ owner: 'acme', name: 'new', private: false, description: 'd' });
    const posts = f.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual([
      'https://api.github.com/user/repos',
      'https://api.github.com/orgs/acme/repos',
    ]);
    expect(posts[0]!.body).toEqual({ name: 'new', private: true, auto_init: true });
    expect(posts[1]!.body).toEqual({
      name: 'new',
      private: false,
      description: 'd',
      auto_init: true,
    });
  });

  it('reads the scripts from package.json, and none when there is no package.json', async () => {
    const content = Buffer.from(
      JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint', 'bad name': 'x' } }),
    ).toString('base64');
    const f = fakeFetch((c) =>
      c.url.includes('o/has')
        ? { json: { encoding: 'base64', content } }
        : { status: 404, json: { message: 'Not Found' } },
    );
    const forge = githubForge('t', f.impl);
    expect(await forge.packageScripts('o/has')).toEqual(['test', 'lint']);
    expect(await forge.packageScripts('o/none')).toBeNull();
    expect((await forge.cloneSource('o/has')).url).toBe('https://github.com/o/has.git');
  });
});

describe('Linear for the wizard', () => {
  it('makes a project in the team', async () => {
    const f = fakeFetch(() => ({
      json: { data: { projectCreate: { success: true, project: { id: 'p1', name: 'Shop' } } } },
    }));
    const made = await linearTracker('lin_api_x', f.impl).createProject('team_1', 'Shop');
    expect(made).toEqual({ id: 'p1', name: 'Shop' });
    expect((f.calls[0]!.body as { variables: unknown }).variables).toEqual({
      input: { name: 'Shop', teamIds: ['team_1'] },
    });
  });
});

describe('cloning a project’s repository', () => {
  let root: string;
  let bare: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-clone-'));
    const work = path.join(root, 'work');
    fs.mkdirSync(work);
    git(work, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(work, 'README.md'), '# r\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'first');
    bare = path.join(root, 'r.git');
    git(root, 'clone', '-q', '--bare', work, bare);
    fs.mkdirSync(path.join(root, 'into'));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('checks where the clone goes before anything is made', async () => {
    const at = (parent: string, folder: string) =>
      checkCloneTarget({ parent, folder, repo: 'o/r' }).catch((e: Error) => e.message);
    expect(await at('relative/place', 'r')).toBe('Give the folder as an absolute path.');
    expect(await at(path.join(root, 'missing'), 'r')).toContain('There is no folder at');
    expect(await at(root, '../escape')).toContain('Name the new folder');
    expect(await at(root, '.hidden')).toContain('Name the new folder');
    // The work folder has files and is not a clone of o/r.
    expect(await at(root, 'work')).toContain('already has files in it');
    expect(await checkCloneTarget({ parent: root, folder: 'fresh', repo: 'o/r' })).toEqual({
      path: path.join(root, 'fresh'),
      state: 'new',
    });
  });

  it('clones into a new folder, keeps no token, and uses the folder again when it holds the repository', async () => {
    const source = { url: bare, auth: true };
    const parent = path.join(root, 'into');
    const first = await cloneRepository({
      repo: 'o/r',
      source,
      token: 'ghp_never_kept',
      parent,
      folder: 'r',
    });
    expect(first).toEqual({ path: path.join(parent, 'r'), reused: false });
    expect(fs.readFileSync(path.join(first.path, 'README.md'), 'utf8')).toBe('# r\n');
    expect(fs.readFileSync(path.join(first.path, '.git', 'config'), 'utf8')).not.toContain(
      'extraheader',
    );
    const again = await cloneRepository({ repo: 'o/r', source, token: null, parent, folder: 'r' });
    expect(again).toEqual({ path: first.path, reused: true });
  });

  it('leaves nothing behind when the clone fails, and never repeats the token', async () => {
    const parent = path.join(root, 'into');
    fs.mkdirSync(path.join(parent, 'empty'));
    const failed = await cloneRepository({
      repo: 'o/gone',
      source: { url: path.join(root, 'gone.git'), auth: true },
      token: 'ghp_secret_value',
      parent,
      folder: 'gone',
    }).catch((e: Error) => e.message);
    expect(failed).toContain('git could not clone o/gone');
    expect(failed).not.toContain('ghp_secret_value');
    expect(fs.existsSync(path.join(parent, 'gone'))).toBe(false);
    // An empty folder the operator made is filled, or left empty when the clone fails.
    await expect(
      cloneRepository({
        repo: 'o/gone',
        source: { url: path.join(root, 'gone.git'), auth: false },
        token: null,
        parent,
        folder: 'empty',
      }),
    ).rejects.toThrow('git could not clone');
    expect(fs.readdirSync(path.join(parent, 'empty'))).toEqual([]);
    const filled = await cloneRepository({
      repo: 'o/r',
      source: { url: bare, auth: false },
      token: null,
      parent,
      folder: 'empty',
    });
    expect(filled.reused).toBe(false);
    expect(fs.existsSync(path.join(parent, 'empty', 'README.md'))).toBe(true);
  });
});

describe('the New project wizard', () => {
  let db: Db;
  let close: () => Promise<void>;
  let root: string;
  const store = scriptedStore(true);
  const forgeStore = scriptedForgeStore(true);
  const previous = process.env.MAGPIPE_SECRET_KEY;

  beforeAll(async () => {
    process.env.MAGPIPE_SECRET_KEY = SECRET;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-wizard-'));
    forgeStore.bareRoot = path.join(root, 'github');
    useTrackerFactory((key) => scriptedTracker(key, store));
    useForgeFactory((token) => scriptedForge(token, forgeStore));
    ({ db, close } = await openDb('memory://'));
  }, 30_000);
  afterAll(async () => {
    useTrackerFactory(undefined);
    useForgeFactory(undefined);
    await close();
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MAGPIPE_SECRET_KEY;
    else process.env.MAGPIPE_SECRET_KEY = previous;
  });

  it('asks for the shared GitHub token and Linear key first', async () => {
    await expect(wizardGitHub(db)).rejects.toThrow('Connect GitHub in Settings first');
    await expect(
      wizardEnsureLinearProject(db, { teamId: SCRIPTED_TEAM.id, name: 'Shop' }),
    ).rejects.toThrow('Connect Linear in Settings first');
    await saveForgeKey(db, 'ghp_wizard');
    await saveLinearKey(db, 'lin_api_wizard');
  });

  it('lists the account’s repositories and owners, and reads a repository’s scripts', async () => {
    const gh = await wizardGitHub(db);
    expect(gh.login).toBe(SCRIPTED_LOGIN);
    expect(gh.owners.map((o) => o.login)).toEqual([SCRIPTED_LOGIN, 'magpipe-e2e']);
    expect(gh.repos.map((r) => r.fullName)).toContain('magpipe-e2e/website');
    expect(await wizardRepoScripts(db, 'magpipe-e2e/website')).toEqual(['test', 'lint']);
    await expect(wizardRepoScripts(db, 'not a repo')).rejects.toThrow('owner/name');
  });

  it('makes a project from a new repository and a new Linear project, and runs again where it stopped', async () => {
    const parent = path.join(root, 'code');
    fs.mkdirSync(parent);
    const repoInput = { owner: 'magpipe-e2e', name: 'shop', private: true, description: 'A shop' };
    const where = { repo: 'magpipe-e2e/shop', parent, folder: 'shop' };

    expect(await wizardCheckFolder({ mode: 'clone', ...where })).toEqual({
      path: path.join(parent, 'shop'),
      state: 'new',
      scripts: null,
    });
    expect(await wizardEnsureRepository(db, repoInput)).toEqual({
      repo: 'magpipe-e2e/shop',
      created: true,
    });
    const cloned = await wizardEnsureClone(db, where);
    expect(cloned).toEqual({ path: path.join(parent, 'shop'), reused: false });
    const linear = await wizardEnsureLinearProject(db, { teamId: SCRIPTED_TEAM.id, name: 'Shop' });
    expect(linear.created).toBe(true);

    // The wizard stopped before saving; run again, everything is there and used as it is.
    expect(await wizardEnsureRepository(db, repoInput)).toEqual({
      repo: 'magpipe-e2e/shop',
      created: false,
    });
    expect(await wizardEnsureClone(db, where)).toEqual({ path: cloned.path, reused: true });
    const again = await wizardEnsureLinearProject(db, { teamId: SCRIPTED_TEAM.id, name: 'shop ' });
    expect(again).toEqual({ project: linear.project, created: false });

    // A new repository has no package.json: the project saves with no scripts, and says so.
    const { project } = await saveProject(db, null, {
      name: 'Shop',
      repoPath: cloned.path,
      scripts: '',
      context: '',
      linear: {
        teamId: SCRIPTED_TEAM.id,
        projectId: linear.project.id,
        label: 'magpipe',
        states: SCRIPTED_MAPPING,
      },
      github: {
        repo: 'magpipe-e2e/shop',
        mergeMethod: 'squash',
        autoMerge: false,
        autoMergeLabel: 'auto-merge',
        autoMergeFirstPass: true,
        autoMergeChecks: true,
      },
      maxRuns: null,
      spendCapUsd: null,
      models: {},
    });
    expect(project.scripts).toEqual([]);
    expect((await projectView(db, project)).gaps).toEqual(['scripts']);

    // Its Linear project is now taken: a same-named one is not used for another project.
    await expect(
      wizardEnsureLinearProject(db, { teamId: SCRIPTED_TEAM.id, name: 'Shop' }),
    ).rejects.toThrow('Shop already files into the Linear project Shop');
  });

  it('clones a repository that has a package.json, and checks a folder that holds one already', async () => {
    const parent = path.join(root, 'code');
    const cloned = await wizardEnsureClone(db, {
      repo: 'magpipe-e2e/website',
      parent,
      folder: 'site',
    });
    const held = await wizardCheckFolder({
      mode: 'existing',
      repo: 'magpipe-e2e/website',
      path: cloned.path,
    });
    expect(held).toEqual({ path: cloned.path, state: 'existing', scripts: ['test', 'lint'] });

    // A folder whose origin is another GitHub repository is refused.
    git(cloned.path, 'remote', 'set-url', 'origin', 'https://github.com/someone/else.git');
    await expect(
      wizardCheckFolder({ mode: 'existing', repo: 'magpipe-e2e/website', path: cloned.path }),
    ).rejects.toThrow('The folder’s origin is someone/else, not magpipe-e2e/website.');
  });

  it('refuses a repository name GitHub would not take', async () => {
    await expect(
      wizardEnsureRepository(db, {
        owner: 'magpipe-e2e',
        name: 'has space',
        private: true,
        description: '',
      }),
    ).rejects.toThrow('Name the repository');
    await expect(
      wizardEnsureRepository(db, { owner: 'nobody', name: 'x', private: true, description: '' }),
    ).rejects.toThrow('GitHub found nothing');
  });
});

/**
 * The factory's agents installed with no folder asked for (D50): a factory loaded onto a folder
 * before keeps it while it is there, and moves to the stand-in once it is gone, letting go of the
 * old tool; the stand-in is mended when broken and known by name wherever the data folder went;
 * and a template run must have a project to work in.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAgents } from '@/lib/agents';
import { openDb, type Db } from '@/lib/db';
import {
  FactoryNotReadyError,
  factoryRepository,
  installFactory,
  isStandInRepository,
  loadFactory,
  standInRepositoryPath,
  templatePlan,
} from '@/lib/factory';

describe('installing the factory without a folder', () => {
  let db: Db;
  let close: () => Promise<void>;
  let root: string;
  let legacy: string;
  const previousData = process.env.MAGPIPE_DATA_DIR;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-install-'));
    process.env.MAGPIPE_DATA_DIR = path.join(root, '.data');
    legacy = path.join(root, 'app');
    fs.mkdirSync(legacy);
    fs.writeFileSync(
      path.join(legacy, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e 0' } }),
    );
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: legacy });
    ({ db, close } = await openDb('memory://'));
  }, 30_000);
  afterAll(async () => {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
    if (previousData === undefined) delete process.env.MAGPIPE_DATA_DIR;
    else process.env.MAGPIPE_DATA_DIR = previousData;
  });

  it('keeps the folder a factory was loaded onto while it is there', async () => {
    await loadFactory(db, { path: legacy, scripts: ['test'] });
    const result = await installFactory(db);
    expect(result.path).toBe(fs.realpathSync(legacy));
    expect(result.tools[0]!.outcome).toBe('unchanged');
  });

  it('moves to the stand-in once that folder is gone, and lets go of the old tool', async () => {
    const old = await factoryRepository(db);
    fs.rmSync(legacy, { recursive: true, force: true });
    const result = await installFactory(db);
    expect(result.path).toBe(standInRepositoryPath());
    const held = await factoryRepository(db);
    expect(held.id).not.toBe(old.id);
    const factory = (await listAgents(db)).filter((a) => a.templateOnly);
    expect(factory).toHaveLength(9);
    for (const agent of factory) {
      expect(agent.tools.some((g) => g.toolId === old.id)).toBe(false);
    }
  });

  it('mends a broken stand-in, and knows it by name wherever the data folder went', async () => {
    const pkg = path.join(standInRepositoryPath(), 'package.json');
    fs.writeFileSync(pkg, '{ not json');
    await installFactory(db);
    expect(JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts.test).toBeTypeOf('string');
    // A copy somewhere else (a moved data folder) is still the stand-in; a project is not.
    const moved = path.join(root, 'moved');
    fs.cpSync(standInRepositoryPath(), moved, { recursive: true });
    expect(await isStandInRepository(moved)).toBe(true);
    expect(await isStandInRepository(path.join(root, '.data'))).toBe(false);
  });

  it('starts a template run only in a project', async () => {
    await expect(templatePlan(db, 'spec', { projectId: 'proj_gone' })).rejects.toThrow(
      'That project no longer exists',
    );
    // The loaded folder's Default project is still there: a run with no project named finds it.
    await expect(templatePlan(db, 'spec')).resolves.toBeTruthy();
    const { factoryProjects } = await import('@/lib/db/schema');
    await db.delete(factoryProjects);
    const err = await templatePlan(db, 'spec').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FactoryNotReadyError);
    expect((err as Error).message).toContain('Pick the project this is for');
  });
});

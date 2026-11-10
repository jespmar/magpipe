/** A step's work record and the run's artefacts (D29), from the items repository tools report. */
import { describe, expect, it } from 'vitest';
import {
  foldWork,
  latestChecks,
  mergeWork,
  runArtifacts,
  shownArtifacts,
  workFacts,
  workLine,
  type WorkItem,
} from '@/lib/work';

const items: WorkItem[] = [
  { kind: 'branch', repo: 'App', name: 'magpipe/x', created: true },
  { kind: 'file', repo: 'App', path: 'src/a.ts', change: 'created' },
  { kind: 'check', repo: 'App', script: 'test', exit: 1, seconds: 2.1, timedOut: false },
  { kind: 'file', repo: 'App', path: 'src/a.ts', change: 'updated' },
  { kind: 'file', repo: 'App', path: 'src/b.ts', change: 'updated' },
  { kind: 'check', repo: 'App', script: 'test', exit: 0, seconds: 1.9, timedOut: false },
  { kind: 'check', repo: 'App', script: 'lint', exit: null, seconds: 600, timedOut: true },
  { kind: 'commit', repo: 'App', branch: 'magpipe/x', sha: 'abc1234', message: 'Add a' },
  { kind: 'branch', repo: 'App', name: 'magpipe/x', created: false },
];

describe('foldWork', () => {
  it('keeps nothing for a step that touched no repository', () => {
    expect(foldWork([])).toBeUndefined();
    expect(workLine(undefined)).toBeNull();
    expect(workFacts(undefined)).toEqual([]);
  });

  it('lists each file and branch once, keeps "created", and every commit and check in order', () => {
    const work = foldWork(items)!;
    expect(work.files).toEqual([
      { repo: 'App', path: 'src/a.ts', change: 'created' },
      { repo: 'App', path: 'src/b.ts', change: 'updated' },
    ]);
    expect(work.branches).toEqual([{ repo: 'App', name: 'magpipe/x', created: true }]);
    expect(work.commits).toHaveLength(1);
    expect(work.checks.map((c) => c.exit)).toEqual([1, 0, null]);
    expect(latestChecks(work).map((c) => `${c.script}:${c.exit}`)).toEqual(['test:0', 'lint:null']);
  });

  it('says the work in one line, and as facts for the next prompt', () => {
    const work = foldWork(items)!;
    expect(workLine(work)).toBe('2 files · 1 commit on magpipe/x · test passed · lint timed out');
    expect(workFacts(work)).toEqual([
      'App: created and switched to branch magpipe/x',
      'App: created src/a.ts',
      'App: updated src/b.ts',
      'App: committed abc1234 on magpipe/x: Add a',
      'App: ran test, passed (exit 0) in 1.9 s',
      'App: ran lint, timed out in 600.0 s',
    ]);
    expect(workLine(foldWork([items[0]!]))).toBe('on magpipe/x');
  });
});

describe('runArtifacts', () => {
  it('lists branches with their commits, then files, across steps', () => {
    const first = foldWork(items);
    const second = foldWork([
      { kind: 'file', repo: 'App', path: 'src/a.ts', change: 'updated' },
      { kind: 'file', repo: 'App plans', path: 'docs/plans/x.md', change: 'created' },
      { kind: 'commit', repo: 'App', branch: 'magpipe/x', sha: 'def5678', message: 'Fix a' },
    ]);
    expect(runArtifacts([{ work: first }, {}, { work: second }])).toEqual([
      { kind: 'branch', repo: 'App', name: 'magpipe/x', detail: '2 commits · last def5678 Fix a' },
      { kind: 'file', repo: 'App', name: 'src/a.ts', detail: 'created' },
      { kind: 'file', repo: 'App', name: 'src/b.ts', detail: 'updated' },
      { kind: 'file', repo: 'App plans', name: 'docs/plans/x.md', detail: 'created' },
    ]);
    expect(runArtifacts([{}, { work: undefined }])).toEqual([]);
  });
});

describe('shownArtifacts', () => {
  it('lists recorded work even when a run failed before its merge, then uploaded files', () => {
    const work = foldWork([
      { kind: 'commit', repo: 'App', branch: 'magpipe/x', sha: 'abc1234', message: 'Add a' },
    ]);
    expect(shownArtifacts({ plan: [{ work } as never], output: null })).toEqual([
      { kind: 'branch', repo: 'App', name: 'magpipe/x', detail: '1 commit · last abc1234 Add a' },
    ]);
    const output = {
      markdown: 'done',
      artifacts: [
        { kind: 'branch' as const, repo: 'App', name: 'magpipe/x', detail: 'stale copy' },
        { name: 'report.pdf', blobUrl: '/uploads/report.pdf' },
      ],
    };
    expect(shownArtifacts({ plan: [{ work } as never], output }).map((a) => a.name)).toEqual([
      'magpipe/x',
      'report.pdf',
    ]);
  });
});

describe('mergeWork', () => {
  it("keeps a step's work across rounds", () => {
    const before = foldWork([
      { kind: 'file', repo: 'App', path: 'src/a.ts', change: 'created' },
      { kind: 'commit', repo: 'App', branch: 'magpipe/x', sha: 'abc1234', message: 'Add a' },
    ]);
    const after = foldWork([
      { kind: 'file', repo: 'App', path: 'src/a.ts', change: 'updated' },
      { kind: 'commit', repo: 'App', branch: 'magpipe/x', sha: 'def5678', message: 'Fix a' },
    ]);
    const merged = mergeWork(before, after)!;
    expect(merged.files).toEqual([{ repo: 'App', path: 'src/a.ts', change: 'created' }]);
    expect(merged.commits.map((c) => c.sha)).toEqual(['abc1234', 'def5678']);
    expect(mergeWork(undefined, after)).toBe(after);
    expect(mergeWork(before, undefined)).toBe(before);
  });
});

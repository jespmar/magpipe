/** A step's work record and the run's artefacts (D29), from the items repository tools report. */
import { describe, expect, it } from 'vitest';
import {
  foldWork,
  latestChecks,
  resumeNote,
  runArtifacts,
  shownArtifacts,
  workFacts,
  workItems,
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

describe('workItems', () => {
  it('turns a record back into items, so a resumed step collects on top of it (D33)', () => {
    const work = foldWork(items)!;
    expect(workItems(undefined)).toEqual([]);
    expect(foldWork(workItems(work))).toEqual(work);
    const resumed = foldWork([
      ...workItems(work),
      { kind: 'file', repo: 'App', path: 'src/a.ts', change: 'updated' },
      { kind: 'file', repo: 'App', path: 'src/c.ts', change: 'created' },
      { kind: 'commit', repo: 'App', branch: 'magpipe/x', sha: 'def5678', message: 'Add c' },
    ])!;
    expect(resumed.files.map((f) => `${f.path}:${f.change}`)).toEqual([
      'src/a.ts:created',
      'src/b.ts:updated',
      'src/c.ts:created',
    ]);
    expect(resumed.commits.map((c) => c.sha)).toEqual(['abc1234', 'def5678']);
    expect(resumed.branches).toEqual(work.branches);
    expect(resumed.checks).toEqual(work.checks);
  });
});

describe('resumeNote', () => {
  it('says nothing to a step that was never interrupted', () => {
    expect(resumeNote({})).toBeNull();
    expect(resumeNote({ work: foldWork(items) })).toBeNull();
  });

  it('tells an interrupted step what it had done, or that nothing was recorded', () => {
    const note = resumeNote({ restarts: 1, work: foldWork(items) })!;
    expect(note.split('\n')).toEqual([
      'This step was interrupted by a restart after it had started. Before that, Magpipe recorded:',
      '- App: created and switched to branch magpipe/x',
      '- App: created src/a.ts',
      '- App: updated src/b.ts',
      '- App: committed abc1234 on magpipe/x: Add a',
      '- App: ran test, passed (exit 0) in 1.9 s',
      '- App: ran lint, timed out in 600.0 s',
      'Continue from there: check git_status and the branch, and do not redo work that is already committed.',
    ]);
    expect(resumeNote({ restarts: 2 })).toBe(
      'This step was interrupted by a restart after it had started (2 times). Magpipe recorded no repository work before that. Check what is already in place before you redo anything.',
    );
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

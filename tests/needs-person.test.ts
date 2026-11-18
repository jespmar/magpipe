/**
 * When a build that did not pass is handed to the operator rather than built again (D52, D53):
 * a missing package manager, a budget spent or a step of Magpipe's own that failed; anything the
 * code can fix is built again.
 */
import { describe, expect, it } from 'vitest';
import { needsPerson } from '@/lib/engine/actions';
import type { Step } from '@/lib/schemas';
import { workFacts } from '@/lib/work';

const step = (id: string, extra: Partial<Step> = {}): Step => ({
  id,
  agentId: 'agent_x',
  title: id,
  dependsOn: [],
  status: 'done',
  ...extra,
});

const work = (skipped?: 'missing' | 'install' | 'tool') => ({
  files: [],
  branches: [],
  commits: [],
  checks: [
    {
      repo: 'App',
      script: 'test',
      exit: null,
      seconds: 0,
      timedOut: false,
      ...(skipped ? { skipped } : {}),
    },
  ],
});

describe('needsPerson', () => {
  it('hands over at once when the package manager could not be found (D53)', () => {
    const run = step('Run the tests', { judges: true, verdict: 'fail', work: work('tool') });
    expect(needsPerson([], [run])).toContain('could not find the package manager');
    expect(workFacts(run.work)).toEqual([
      'App: test did not run (its package manager could not be found on this computer)',
    ]);
  });

  it('builds again for what the code can fix: failing tests, a missing script, an install', () => {
    for (const skipped of ['missing', 'install'] as const) {
      expect(
        needsPerson(
          [],
          [step('Run the tests', { judges: true, verdict: 'fail', work: work(skipped) })],
        ),
      ).toBeNull();
    }
    expect(
      needsPerson(
        [step('Build', { status: 'failed', error: { code: 'unknown', message: 'x' } })],
        [],
      ),
    ).toBeNull();
  });

  it('hands over a spent budget or a step of Magpipe’s own that failed', () => {
    expect(
      needsPerson(
        [step('Build', { status: 'failed', error: { code: 'limit_tokens', message: 'x' } })],
        [],
      ),
    ).toBe('A step ran out of its token budget.');
    expect(
      needsPerson(
        [
          step('Open the pull request', {
            agentId: null,
            action: 'open_pr',
            status: 'failed',
            error: { code: 'forge', message: 'refused' },
          }),
        ],
        [],
      ),
    ).toContain('Magpipe could not open the pull request');
  });
});

'use client';

import { useSyncExternalStore } from 'react';
import { Stepper, type StepperStep } from '@/components/arc/stepper/stepper';
import { stepMeta, type AgentChip } from '@/lib/runs-util';
import { workLine } from '@/lib/work';
import type { Step } from '@/lib/schemas';

type Props = {
  plan: Step[];
  agents: AgentChip[];
  now: Date;
  /** What to say when the plan is still empty. */
  emptyMessage?: string;
};

const WIDE = '(min-width: 100rem)';

function subscribe(onChange: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Vertical from 1600 px, where the path stands beside the log; a horizontal chain below that. */
function useWide() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

/**
 * The plan as Arc's stepper (spec §3.4): each step's title with `agent · meta · work` beneath it,
 * the work being what it did in a repository (D29). The live step is current, a failed step
 * carries its error, the steps after it stay upcoming.
 */
export function RunFlightPath({ plan, agents, now, emptyMessage }: Props) {
  const wide = useWide();
  if (plan.length === 0) {
    return <p className="text-body-sm text-body">{emptyMessage ?? 'No steps were planned.'}</p>;
  }
  const current = plan.findIndex((s) => s.status !== 'done' && s.status !== 'skipped');
  const steps: StepperStep[] = plan.map((s) => {
    const who =
      s.agentId === null ? 'Magpipe' : (agents.find((a) => a.id === s.agentId)?.name ?? 'agent');
    const meta = s.status === 'skipped' ? 'skipped' : stepMeta(s, now);
    // What the step did in a repository, as the tools recorded it (D29).
    const work = workLine(s.work);
    const detail = [who, meta, work].filter(Boolean).join(' · ');
    return {
      id: s.id,
      label: s.title,
      description: detail,
      error: s.status === 'failed' ? detail : undefined,
    };
  });
  return (
    <Stepper
      label="Flight path"
      steps={steps}
      current={current === -1 ? plan.length : current}
      orientation={wide ? 'vertical' : 'horizontal'}
      completeLabel="Every step settled"
    />
  );
}

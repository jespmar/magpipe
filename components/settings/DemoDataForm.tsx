'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { plural } from '@/lib/format';
import { loadDemoAction, type DemoState } from '@/app/(shell)/settings/actions';

type Props = {
  /** What the demo contains, computed from the seed so the copy cannot drift. */
  counts: { tools: number; memory: number; runs: number };
  /** When set, the action is unavailable and this says why. */
  disabledReason?: string;
};

/**
 * Load demo data, done properly: a confirm step before anything is written, a pending state
 * while it runs, the result spelled out in a live region that is always mounted (so it is
 * announced), and focus that follows the flow instead of falling to the page body.
 */
export function DemoDataForm({ counts, disabledReason }: Props) {
  const router = useRouter();
  const [state, action] = useActionState<DemoState, FormData>(loadDemoAction, {
    status: 'idle',
  });
  const [confirming, setConfirming] = useState(false);
  const resultRef = useRef<HTMLParagraphElement>(null);

  // When a result lands: close the confirm step, move focus to the result, and re-read the
  // page's server data (the region label and other screens' facts come from what was loaded).
  useEffect(() => {
    if (state.status === 'idle') return;
    setConfirming(false);
    resultRef.current?.focus();
    if (state.status === 'done') router.refresh();
  }, [state, router]);

  if (disabledReason) {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <Button variant="outline" size="sm" disabled aria-describedby="demo-disabled-why">
            Load demo data
          </Button>
        </div>
        <p id="demo-disabled-why" className="text-caption text-mute">
          {disabledReason}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Always mounted so screen readers hear the change when the text arrives. */}
      <p
        ref={resultRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="text-body-sm text-ink focus:outline-none"
      >
        {state.status === 'done' ? (
          <>
            <span className="font-semibold text-emerald">Done.</span> {state.message}
          </>
        ) : null}
        {state.status === 'error' ? <span className="text-danger">{state.message}</span> : null}
      </p>

      {confirming ? (
        <form action={action} className="flex flex-col gap-3">
          <p className="text-body-sm text-ink">
            This adds {plural(counts.tools, 'example tool')},{' '}
            {plural(counts.memory, 'memory', 'memories')} and{' '}
            {plural(counts.runs, 'finished flight')}, and grants your birds their tools. Anything
            you created yourself is left alone.
          </p>
          <div className="flex flex-wrap gap-2">
            <SubmitButton />
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            {state.status === 'idle' ? 'Load demo data' : 'Load it again'}
          </Button>
        </div>
      )}
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="primary"
      size="sm"
      disabled={pending}
      aria-busy={pending}
      // The button that opened this step has unmounted; land focus here, not on <body>.
      autoFocus
    >
      {pending ? 'Loading the demo…' : 'Load it'}
    </Button>
  );
}

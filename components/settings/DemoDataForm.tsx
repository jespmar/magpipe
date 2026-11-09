'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ButtonLink } from '@/components/ui/Button';
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
 * while it runs, the result in a live region that is always mounted (so it is announced), and
 * focus that returns to the trigger button — a visible ring and the obvious next control.
 */
export function DemoDataForm({ counts, disabledReason }: Props) {
  const router = useRouter();
  const [state, action] = useActionState<DemoState, FormData>(loadDemoAction, {
    status: 'idle',
  });
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // Leaving the confirm step (Cancel or a result): focus goes back to the trigger.
  useEffect(() => {
    if (wasConfirming.current && !confirming) triggerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  // When a result lands: close the confirm step and re-read the page's server data.
  useEffect(() => {
    if (state.status === 'idle') return;
    setConfirming(false);
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
      <p role="status" aria-live="polite" className="text-body-sm text-ink">
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
            {plural(counts.memory, 'memory', 'memories')} and {plural(counts.runs, 'finished run')},
            and grants your agents their tools. Anything you created yourself is left alone.
          </p>
          <div className="flex flex-wrap gap-2">
            <SubmitButton />
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button ref={triggerRef} variant="outline" size="sm" onClick={() => setConfirming(true)}>
            {state.status === 'idle' ? 'Load demo data' : 'Load it again'}
          </Button>
          {state.status === 'done' ? (
            <ButtonLink href="/runs" variant="ghost" size="sm">
              See the flights
            </ButtonLink>
          ) : null}
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

'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { loadDemoAction, type DemoState } from '@/app/(shell)/settings/actions';

type Props = {
  /** When set, the action is unavailable and this says why. */
  disabledReason?: string;
};

/**
 * Load demo data, done properly: a confirm step before anything is written, a pending state
 * while it runs, and the result spelled out. Nothing here can crash the page.
 */
export function DemoDataForm({ disabledReason }: Props) {
  const router = useRouter();
  const [state, action] = useActionState<DemoState, FormData>(loadDemoAction, {
    status: 'idle',
  });
  const [confirming, setConfirming] = useState(false);

  // When a result lands: close the confirm step and re-read the page's server data
  // (the region label and the facts on other screens come from what was just loaded).
  useEffect(() => {
    if (state.status === 'idle') return;
    setConfirming(false);
    if (state.status === 'done') router.refresh();
  }, [state, router]);

  if (disabledReason) {
    return (
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" disabled aria-describedby="demo-disabled-why">
          Load demo data
        </Button>
        <p id="demo-disabled-why" className="text-caption text-mute">
          {disabledReason}
        </p>
      </div>
    );
  }

  if (confirming) {
    return (
      <form action={action} className="flex flex-col gap-3">
        <p className="text-body-sm text-ink">
          This adds 9 example tools, 12 shiny bits and 4 finished flights, and grants your birds
          their tools. Anything you created yourself is left alone.
        </p>
        <div className="flex flex-wrap gap-2">
          <SubmitButton />
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {state.status === 'done' ? (
        <p role="status" className="text-body-sm text-ink">
          <span className="font-semibold text-emerald">Done.</span> {state.message}
        </p>
      ) : null}
      {state.status === 'error' ? (
        <p role="alert" className="text-body-sm text-danger">
          {state.message}
        </p>
      ) : null}
      <div>
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
          {state.status === 'idle' ? 'Load demo data' : 'Load it again'}
        </Button>
      </div>
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="sm" disabled={pending} aria-busy={pending}>
      {pending ? 'Loading the demo…' : 'Load it'}
    </Button>
  );
}

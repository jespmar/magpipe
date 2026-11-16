'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { installFactoryAction } from '@/app/(shell)/settings/actions';
import type { RosterLine } from '@/lib/roster';

type Props = {
  /** The nine agents are there and hold the factory's repository. */
  installed: boolean;
  /** When set, the action is unavailable and this says why. */
  disabledReason?: string;
};

type Result = { ok: true; lines: RosterLine[] } | { ok: false; message: string } | null;

/**
 * The software factory's nine agents (D50): installed with the first project the wizard makes, or
 * here, and brought up to date here. No folder is asked for: each run works in its project's.
 */
export function FactoryInstall({ installed, disabledReason }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result>(null);

  function install() {
    start(async () => {
      const res = await installFactoryAction();
      setResult(res);
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-[31rem] text-body-sm text-body">
        {installed
          ? 'Installed. Bring them up to date after an update of Magpipe, or after editing one by hand, to put back their prompts and grants.'
          : 'Not installed yet. They are installed with the first project you create in Factory, or here.'}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={install} loading={pending} disabled={Boolean(disabledReason)}>
          {installed ? 'Bring the agents up to date' : 'Install the factory agents'}
        </Button>
        {disabledReason ? <p className="text-body-sm text-mute">{disabledReason}</p> : null}
      </div>
      <div role="status" aria-live="polite">
        {result?.ok ? (
          <div className="flex flex-col gap-3">
            <p className="text-body-sm font-medium text-emerald">Done.</p>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
              {result.lines.map((line) => (
                <div key={line.label} className="contents">
                  <dt className="text-body-sm text-mute">{line.label}</dt>
                  <dd className="text-body-sm text-body">{line.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : result ? (
          <p className="text-body-sm text-danger">{result.message}</p>
        ) : null}
      </div>
    </div>
  );
}

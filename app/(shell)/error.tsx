'use client';

import { useEffect } from 'react';
import { Button, ButtonLink } from '@/components/ui/Button';

/**
 * Error boundary for every screen inside the shell. The layout (nav, footer) stays, so there is
 * always a way out; the digest lets a bug report be matched to the server log.
 */
export default function ShellError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section role="alert" className="flex flex-col gap-4 card px-6 py-8 md:px-8">
      <h1 className="text-display-md text-ink-strong">Something went wrong</h1>
      <p className="max-w-[34rem] text-body-md text-body">
        Magpipe hit an error while drawing this page. Your data is untouched. Try again; if it keeps
        happening, the server log (File, then Show Logs in the desktop app) has the details.
      </p>
      {error.digest ? (
        <p className="font-mono text-code text-mute">reference {error.digest}</p>
      ) : null}
      <div className="flex flex-wrap gap-3 pt-2">
        <Button variant="primary" onClick={() => reset()}>
          Try again
        </Button>
        <ButtonLink href="/" variant="secondary">
          Back to Magpipe
        </ButtonLink>
      </div>
    </section>
  );
}

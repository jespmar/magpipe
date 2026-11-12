'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { Textarea } from '@/components/arc/textarea/textarea';
import { Button } from '@/components/ui/Button';
import { api, ApiError } from '@/lib/client-api';
import type { Run } from '@/lib/schemas';

/**
 * A project's Specification Agent (D46): describe an idea and the spec template runs for this
 * project. The Spec Builder writes it with the project's context, the Spec Review checks it, and
 * a spec that passes is filed in the project's Linear project. The project page stays put and
 * re-reads itself, so the new run shows in its list.
 */
export function SpecComposer({
  projectId,
  projectName,
  linearReady,
}: {
  projectId: string;
  projectName: string;
  /** Without its Linear project, the spec is written and reviewed but not filed. */
  linearReady: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [started, setStarted] = useState<Pick<Run, 'displayId'> | null>(null);

  async function send() {
    if (sending) return;
    const text = box.current?.value.trim() ?? '';
    if (!text) {
      setProblem('Describe the idea for the spec.');
      box.current?.focus();
      return;
    }
    setProblem(null);
    setSending(true);
    try {
      const { run } = await api<{ run: Run }>('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ text, attachmentIds: [], template: 'spec', projectId }),
      });
      if (box.current) box.current.value = '';
      setStarted(run);
      router.refresh();
    } catch (err) {
      setProblem(
        err instanceof ApiError ? err.message : 'The spec could not be started. Try again.',
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      noValidate
      aria-label="Write a spec"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <Textarea
        ref={box}
        id={`${id}-idea`}
        label={`An idea for ${projectName}`}
        description={
          linearReady
            ? 'The Spec Builder writes it up with the project’s context, the Spec Review checks it, and a spec that passes is filed in the project’s Linear project for your approval.'
            : 'The Spec Builder writes it up and the Spec Review checks it. It is filed in Linear once the project has its Linear project.'
        }
        rows={3}
        placeholder="What should change, for whom, and how you will know it worked…"
        error={problem ?? undefined}
        onInput={() => problem && setProblem(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="text-body-sm text-body">
          {started ? (
            <>
              The Spec Builder is on it:{' '}
              <Link
                href={`/runs/${started.displayId}`}
                className="font-mono text-code text-ink underline underline-offset-2"
              >
                {started.displayId}
              </Link>
            </>
          ) : null}
        </p>
        <Button type="submit" variant="primary" loading={sending}>
          Write the spec
        </Button>
      </div>
    </form>
  );
}

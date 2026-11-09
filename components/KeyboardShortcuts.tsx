'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { GO_TO, isTypingTarget, SHORTCUTS } from '@/lib/shortcuts';

/** How long after `g` the screen letter may follow. */
const CHORD_MS = 1000;

/**
 * Global keyboard shortcuts (spec §10, PR 8) and the `?` sheet that lists them. Single keys are
 * ignored while typing or while any dialog is open; dialogs keep their own Escape.
 */
export function KeyboardShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const chordUntil = useRef(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('dialog[open]')) return;

      const chord = Date.now() < chordUntil.current;
      chordUntil.current = 0;
      if (chord) {
        const to = GO_TO[e.key.toLowerCase()];
        if (to) {
          e.preventDefault();
          router.push(to.href);
        }
        return;
      }
      switch (e.key) {
        case '?':
          e.preventDefault();
          setOpen(true);
          break;
        case '/': {
          const search = document.querySelector<HTMLInputElement>('input[type="search"]');
          if (search) {
            e.preventDefault();
            search.focus();
            search.select();
          }
          break;
        }
        case 'n': {
          e.preventDefault();
          const prompt = document.querySelector<HTMLTextAreaElement>('textarea[name="text"]');
          if (prompt && pathname === '/') prompt.focus();
          else router.push('/?focus=prompt');
          break;
        }
        case 'g':
          chordUntil.current = Date.now() + CHORD_MS;
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, pathname]);

  useEffect(() => {
    const d = dialog.current;
    if (!d || !open) return;
    if (!d.open) d.showModal();
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="shortcuts-title"
      onClose={() => setOpen(false)}
      className="m-auto w-[min(100vw-2rem,28rem)] rounded-md border border-hairline bg-canvas p-0 text-ink backdrop:bg-[rgba(16,16,16,0.7)]"
    >
      <div className="flex flex-col gap-5 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="eyebrow">Shortcuts</span>
            <h2
              id="shortcuts-title"
              tabIndex={-1}
              data-autofocus
              className="text-display-sm text-ink-strong focus:outline-none"
            >
              Keyboard
            </h2>
          </div>
          <Button variant="ghost" size="sm" onClick={() => dialog.current?.close()}>
            Close
          </Button>
        </div>
        <dl className="flex flex-col gap-2.5">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-baseline justify-between gap-6">
              <dt className="text-body-sm text-body">{s.label}</dt>
              <dd className="flex shrink-0 items-center gap-1 font-mono text-code text-ink">
                {s.keys.map((k, i) => (
                  <span key={k} className="inline-flex items-center gap-1">
                    {i > 0 ? (
                      <span aria-hidden className="text-mute">
                        {s.chord ? 'then' : '+'}
                      </span>
                    ) : null}
                    <kbd className="rounded-xs border border-hairline bg-canvas-soft px-1.5 py-0.5 text-caption text-ink-strong">
                      {k}
                    </kbd>
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-caption text-mute">
          Single keys work outside text fields; dialogs keep their own Escape.
        </p>
      </div>
    </dialog>
  );
}

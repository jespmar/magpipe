'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { clsx } from 'clsx';
import { Button } from '@/components/ui/Button';
import { api, ApiError } from '@/lib/client-api';
import { formatBytes } from '@/lib/home-util';
import type { Run, Upload } from '@/lib/schemas';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;

type Chip = {
  key: string;
  name: string;
  size: number;
  state: 'uploading' | 'ready' | 'failed';
  uploadId?: string;
  error?: string;
};

let nextKey = 0;

/**
 * The prompt window (spec §5.6): describe the task, attach files (picker or drop), run with the
 * button or ⌘/Ctrl + Enter. Files upload as soon as they are chosen so Run only has to send ids;
 * submitting creates the run and goes to its flight.
 */
export function PromptComposer() {
  const router = useRouter();
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [mac, setMac] = useState(true);
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform));
  }, []);
  // `/?focus=prompt` (the `n` shortcut from another screen): land with the cursor in the prompt,
  // then drop the flag from the address through the router.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('focus') !== 'prompt') return;
    textarea.current?.focus();
    router.replace('/', { scroll: false });
  }, [router]);

  const uploading = chips.filter((c) => c.state === 'uploading').length;

  function update(key: string, patch: Partial<Chip>) {
    setChips((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }

  async function attach(files: FileList | File[]) {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    setProblem(null);
    const room = MAX_FILES - chips.length;
    if (incoming.length > room) {
      setProblem(`A run takes at most ${MAX_FILES} files; ${incoming.length - room} left out.`);
    }
    for (const file of incoming.slice(0, Math.max(room, 0))) {
      const key = `f${nextKey++}`;
      if (file.size > MAX_BYTES) {
        setChips((prev) => [
          ...prev,
          { key, name: file.name, size: file.size, state: 'failed', error: 'larger than 25 MB' },
        ]);
        continue;
      }
      setChips((prev) => [...prev, { key, name: file.name, size: file.size, state: 'uploading' }]);
      const body = new FormData();
      body.append('file', file);
      try {
        const res = await fetch('/api/uploads', { method: 'POST', body });
        const json = (await res.json()) as {
          uploads?: Upload[];
          error?: { message?: string };
        };
        if (!res.ok || !json.uploads?.[0]) {
          update(key, { state: 'failed', error: json.error?.message ?? 'upload failed' });
        } else {
          update(key, { state: 'ready', uploadId: json.uploads[0].id });
        }
      } catch {
        update(key, { state: 'failed', error: 'upload failed' });
      }
    }
  }

  function remove(key: string) {
    setChips((prev) => prev.filter((c) => c.key !== key));
  }

  async function submit() {
    if (sending) return;
    const text = textarea.current?.value.trim() ?? '';
    if (!text) {
      setProblem('Give Magpipe a task.');
      textarea.current?.focus();
      return;
    }
    if (uploading > 0) {
      setProblem(`Still attaching ${uploading === 1 ? 'a file' : `${uploading} files`}…`);
      return;
    }
    const failed = chips.find((c) => c.state === 'failed');
    if (failed) {
      setProblem(`${failed.name} could not be attached (${failed.error}). Remove it to run.`);
      return;
    }
    setProblem(null);
    setSending(true);
    try {
      const { run } = await api<{ run: Run }>('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          text,
          attachmentIds: chips.map((c) => c.uploadId).filter((x): x is string => !!x),
        }),
      });
      router.push(`/runs/${run.displayId}`);
    } catch (err) {
      setSending(false);
      setProblem(
        err instanceof ApiError ? err.message : 'The run could not be started. Try again.',
      );
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void attach(e.dataTransfer.files);
  }

  return (
    <section
      aria-labelledby={`${id}-label`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      className={clsx(
        'flex flex-col gap-4 panel p-5 transition-[border-color,box-shadow] duration-150 wide:p-6',
        dragging && 'border-cyan/60 shadow-glow-soft',
      )}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label id={`${id}-label`} htmlFor={`${id}-text`} className="self-start eyebrow">
          Ask Magpipe
        </label>
        <textarea
          ref={textarea}
          id={`${id}-text`}
          name="text"
          rows={4}
          placeholder="Describe the task. Magpipe picks the birds, splits the work and reports back…"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          onInput={() => problem && setProblem(null)}
          aria-describedby={problem ? `${id}-problem` : undefined}
          aria-invalid={problem ? true : undefined}
          className="w-full resize-y rounded-sm border border-hairline bg-canvas px-4 py-3 text-body-md text-ink focus:border-ink-strong focus:outline-none wide:px-[18px] wide:py-3.5 wide:text-body-lg"
        />
        {problem ? (
          <p id={`${id}-problem`} role="alert" className="-mt-1 text-body-sm text-danger">
            {problem}
          </p>
        ) : null}
        {chips.length > 0 ? (
          <ul aria-label="Attachments" className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <li
                key={c.key}
                className={clsx(
                  'inline-flex max-w-full items-center gap-2 rounded-pill border bg-canvas py-1 pr-1.5 pl-3 text-body-sm text-ink',
                  c.state === 'failed' ? 'border-danger/50' : 'border-hairline',
                )}
              >
                <FileIcon />
                <span className="truncate font-mono text-code">{c.name}</span>
                <span
                  className={clsx(
                    'shrink-0 text-caption',
                    c.state === 'failed' ? 'text-danger' : 'text-mute',
                  )}
                >
                  {c.state === 'uploading'
                    ? 'attaching…'
                    : c.state === 'failed'
                      ? c.error
                      : formatBytes(c.size)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${c.name}`}
                  onClick={() => remove(c.key)}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-pill text-mute hover:text-ink-strong"
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={picker}
              type="file"
              multiple
              aria-label="Attach files"
              className="sr-only"
              onChange={(e) => {
                void attach(e.target.files ?? []);
                e.target.value = '';
              }}
            />
            <Button variant="soft" onClick={() => picker.current?.click()}>
              <ClipIcon />
              Attach files
            </Button>
            <span className="text-caption text-mute">PDF, CSV, images, code · up to 25 MB</span>
          </div>
          <div className="flex items-center gap-3 max-md:ml-auto">
            <kbd className="font-mono text-code text-mute">{mac ? '⌘' : 'Ctrl'} + Enter</kbd>
            <Button type="submit" variant="run" disabled={sending} aria-busy={sending}>
              {sending ? 'Starting…' : 'Run'}
              {sending ? null : <ArrowIcon />}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function ClipIcon() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" {...stroke}>
      <path d="M10.5 5.5 6.2 9.8a1.3 1.3 0 0 0 1.8 1.8l4.6-4.6a2.6 2.6 0 0 0-3.7-3.7L4.3 7.9a3.9 3.9 0 0 0 5.5 5.5l3.7-3.7" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" {...stroke}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 16 16"
      {...stroke}
      className="shrink-0 text-mute"
    >
      <path d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" {...stroke}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

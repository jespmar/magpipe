'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { clsx } from 'clsx';
import { ArrowRight, FileText, Paperclip, X } from 'lucide-react';
import { Textarea } from '@/components/arc/textarea/textarea';
import { Button } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
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
      aria-label="Ask Magpipe"
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      // One box, not a card around a box: the field is the surface. Half the row at wide.
      className="mx-auto flex w-full max-w-[56rem] flex-col gap-3 wide:max-w-[50%]"
    >
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div
          className={clsx(
            'rounded-(--radius-control) transition-[outline-color] duration-150',
            dragging && 'outline-2 outline-offset-4 outline-cyan',
          )}
        >
          <Textarea
            ref={textarea}
            id={`${id}-text`}
            name="text"
            label="Ask Magpipe"
            rows={3}
            placeholder="Describe the task. Magpipe picks the birds, splits the work and reports back…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            onInput={() => problem && setProblem(null)}
            error={problem ?? undefined}
          />
        </div>
        {chips.length > 0 ? (
          <ul aria-label="Attachments" className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <li
                key={c.key}
                className={clsx(
                  'inline-flex max-w-full items-center gap-2 rounded-pill border bg-canvas py-1 pr-1.5 pl-3 text-body-sm text-ink',
                  c.state === 'failed' ? 'border-danger/60' : 'border-hairline',
                )}
              >
                <FileText size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-mute" />
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
                  className="-m-2.5 [box-sizing:content-box] inline-flex size-6 shrink-0 items-center justify-center rounded-pill p-2.5 text-mute hover:text-ink-strong"
                >
                  <X size={12} strokeWidth={1.75} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
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
            <Button variant="secondary" size="sm" onClick={() => picker.current?.click()}>
              <Paperclip size={16} strokeWidth={1.75} aria-hidden />
              Attach files
            </Button>
            <span className="text-caption text-mute">PDF, CSV, images, code · up to 25 MB</span>
          </div>
          <div className="flex items-center gap-3 max-md:ml-auto">
            <span className="hidden items-center gap-1 font-mono text-code text-mute sm:inline-flex">
              <Kbd>{mac ? '⌘' : 'Ctrl'}</Kbd>
              <span>+</span>
              <Kbd>Enter</Kbd>
            </span>
            <Button type="submit" variant="primary" loading={sending}>
              Run
              <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

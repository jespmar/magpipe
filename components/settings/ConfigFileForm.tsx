'use client';

import { useEffect, useId, useState, useTransition } from 'react';
import { Textarea } from '@/components/arc/textarea/textarea';
import { Button } from '@/components/ui/Button';
import { readConfigFileAction, saveConfigFileAction } from '@/app/(shell)/settings/actions';
import type { ConfigFile } from '@/lib/config-file';

type Note = { tone: 'done' | 'error'; text: string } | null;

const MONO = { fontFamily: 'var(--font-mono)' } as const;

/**
 * Settings → Config file (D48): magpipe.env, edited here. Saving checks the text and refuses a
 * file changed elsewhere since it was opened; the desktop app reads the file at launch, so the
 * editor says what waits for a restart and offers one. The keys Magpipe reads are listed with
 * what each is for; a secret's value is never shown outside the file itself.
 */
export function ConfigFileForm({ initial }: { initial: ConfigFile }) {
  const ids = useId();
  const [file, setFile] = useState(initial);
  const [text, setText] = useState(initial.text);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  // The desktop app can restart itself and open the file in the operator's editor.
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(Boolean(window.magpipeDesktop?.restart)), []);

  const changed = text !== file.text;

  const run = (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    start(async () => {
      try {
        await fn();
      } finally {
        setBusy(null);
      }
    });
  };

  function save() {
    if (!changed) return setNote({ tone: 'done', text: 'Nothing changed since it was opened.' });
    run('save', async () => {
      const res = await saveConfigFileAction(text, file.version);
      if (!res.ok) return setNote({ tone: 'error', text: res.message });
      setFile(res.file);
      setText(res.file.text);
      setNote({
        tone: 'done',
        text: res.file.pending.length
          ? `Saved. A restart applies ${res.file.pending.join(', ')}.`
          : 'Saved. Nothing waits for a restart.',
      });
    });
  }

  function reload() {
    run('reload', async () => {
      const res = await readConfigFileAction();
      if (!res.ok) return setNote({ tone: 'error', text: res.message });
      setFile(res.file);
      setText(res.file.text);
      setNote({ tone: 'done', text: 'Reloaded the file as it is now.' });
    });
  }

  function restart() {
    if (changed) {
      return setNote({ tone: 'error', text: 'Save or discard your changes before restarting.' });
    }
    run('restart', async () => {
      const ok = await window.magpipeDesktop?.restart();
      if (!ok)
        setNote({
          tone: 'error',
          text: 'Magpipe could not restart itself. Quit and open it again.',
        });
    });
  }

  function openInEditor() {
    run('open', async () => {
      const ok = await window.magpipeDesktop?.openConfigFile();
      setNote(
        ok
          ? { tone: 'done', text: 'Opened in your editor. Reload here after saving it there.' }
          : { tone: 'error', text: 'The file could not be opened in another app.' },
      );
    });
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-code break-all text-mute" style={MONO}>
          {file.path}
        </p>
        <Textarea
          id={`${ids}-text`}
          label="magpipe.env"
          description="One KEY=value per line; lines starting with # are notes. Magpipe reads it when it starts."
          rows={16}
          spellCheck={false}
          autoComplete="off"
          style={MONO}
          value={text}
          readOnly={pending}
          onChange={(e) => {
            setText(e.target.value);
            setNote(null);
          }}
        />
        {file.notes.length ? (
          <ul aria-label="About this file" className="flex flex-col gap-1">
            {file.notes.map((n) => (
              <li
                key={n.text}
                className={
                  n.tone === 'error' ? 'text-body-sm text-danger' : 'text-amber text-body-sm'
                }
              >
                {n.text}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={save}
            loading={busy === 'save'}
            disabled={pending && busy !== 'save'}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={reload}
            loading={busy === 'reload'}
            disabled={pending && busy !== 'reload'}
          >
            {changed ? 'Discard changes' : 'Reload'}
          </Button>
          {desktop ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={openInEditor}
              loading={busy === 'open'}
              disabled={pending && busy !== 'open'}
            >
              Open in your editor
            </Button>
          ) : null}
        </div>
        {changed ? <p className="text-caption text-mute">Unsaved changes.</p> : null}
        <p
          role="status"
          aria-live="polite"
          className={
            note?.tone === 'error' ? 'text-body-sm text-danger' : 'text-body-sm text-emerald'
          }
        >
          {note?.text ?? ''}
        </p>
        {file.pending.length ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-amber text-body-sm">
              Saved but not in use yet: {file.pending.join(', ')}.{' '}
              {desktop ? 'A restart applies them.' : 'Restart Magpipe to apply them.'}
            </p>
            {desktop ? (
              <Button
                size="sm"
                onClick={restart}
                loading={busy === 'restart'}
                disabled={pending && busy !== 'restart'}
              >
                Restart Magpipe
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <h3 className="font-medium text-body text-ink">What Magpipe reads</h3>
        <dl className="flex flex-col gap-3">
          {file.keys.map((k) => (
            <div key={k.key} className="flex flex-col gap-0.5">
              <dt className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-code text-ink" style={MONO}>
                  {k.key}
                </span>
                <span className="text-caption text-mute">
                  {k.pending ? 'saved, waits for a restart' : k.set ? 'set' : 'not set'}
                </span>
              </dt>
              <dd className="max-w-[31rem] text-body-sm text-body">{k.description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

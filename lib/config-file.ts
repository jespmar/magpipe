/**
 * The desktop config file, magpipe.env, edited from Settings (D48). The Electron main process
 * reads it once at launch and hands its values to this server, so a saved change applies after
 * a restart. Saving checks the text first, refuses a change that would break the app (the key
 * that seals stored secrets), refuses to overwrite a file changed elsewhere since it was read,
 * and writes the new file in one step, readable by its owner only.
 */
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { accessMode } from './auth-mode';

/** What a key is for, as Settings lists it. */
export type ConfigKey = {
  key: string;
  description: string;
  /** Magpipe sets it itself: a value in the file is ignored, or must not change. */
  managed?: 'ignored' | 'fixed';
  /** Holds a credential: Settings never shows its value. */
  secret?: boolean;
  /** The values it takes, when they are few. */
  values?: readonly string[];
  /** Names a command on this computer. */
  command?: boolean;
};

/** The keys Magpipe reads from magpipe.env, in the order Settings lists them. */
export const CONFIG_KEYS: readonly ConfigKey[] = [
  { key: 'MAGPIPE_REGION', description: 'The label in the footer.' },
  {
    key: 'MAGPIPE_MODEL_BACKEND',
    description:
      'How runs reach Claude: claude-code uses the Claude Code on this computer and its login; api uses the key below.',
    values: ['claude-code', 'api'],
  },
  {
    key: 'ANTHROPIC_API_KEY',
    description: 'The Claude API key, used when MAGPIPE_MODEL_BACKEND is api.',
    secret: true,
  },
  {
    key: 'MAGPIPE_CLAUDE_PATH',
    description: 'Where the claude command is, when it is not on your PATH.',
    command: true,
  },
  {
    key: 'MAGPIPE_GH_PATH',
    description: 'Where the GitHub CLI is, when it is not on your PATH.',
    command: true,
  },
  {
    key: 'MAGPIPE_LINEAR_CLIENT_ID',
    description: 'The Linear OAuth app Sign in with Linear uses. Public: no secret goes with it.',
  },
  {
    key: 'MAGPIPE_SELF_URL',
    description:
      'This app’s own address for Claude Code’s tool calls, when it is not the usual one.',
  },
  {
    key: 'MAGPIPE_SECRET_KEY',
    description:
      'Seals stored keys and tokens. Made once on first launch; changing it makes every stored key unreadable.',
    managed: 'fixed',
    secret: true,
  },
  {
    key: 'AUTH_SECRET',
    description: 'Made once on first launch for the sign-in library the desktop app does not use.',
    secret: true,
  },
  ...['MAGPIPE_DESKTOP', 'MAGPIPE_CONFIG_PATH', 'MAGPIPE_DATA_DIR', 'AUTH_TRUST_HOST'].map(
    (key) => ({
      key,
      description: 'Set by Magpipe when it starts; a value here is ignored.',
      managed: 'ignored' as const,
    }),
  ),
];

const KNOWN = new Map(CONFIG_KEYS.map((k) => [k.key, k]));

/** Larger than any config file has reason to be. */
const MAX_BYTES = 64 * 1024;

export class ConfigFileError extends Error {
  readonly code = 'validation';
}

/**
 * Where the config file is, when it can be edited here: the desktop app names it at launch. A
 * hosted app (sign-in mode) has no file of its own to edit and never shows its environment.
 */
export function configFilePath(): string | null {
  if (accessMode() === 'signin') return null;
  return process.env.MAGPIPE_CONFIG_PATH || null;
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('base64url');
}

/** One line of the file Node's parser skips, said plainly. */
export type ConfigNote = { tone: 'warning' | 'error'; text: string };

/** What the editor shows of a key: whether the file sets it, and whether that waits on a restart. */
export type ConfigKeyState = ConfigKey & { set: boolean; pending: boolean };

export type ConfigFile = {
  path: string;
  text: string;
  /** The file as read: saving refuses when it has changed since. */
  version: string;
  keys: ConfigKeyState[];
  /** Keys the file sets that the running app does not use yet: a restart applies them. */
  pending: string[];
  notes: ConfigNote[];
};

/** Values the file sets: empty ones count as unset, as the desktop app reads them. */
function valuesOf(text: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parseEnv(text)).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
    ),
  );
}

/**
 * What a text says about itself before it is saved: lines that are not settings, unknown keys
 * (typos, most likely), values a key does not take, commands that are not there. Errors stop a
 * save; warnings do not.
 */
export async function checkConfigText(text: string, before: string | null): Promise<ConfigNote[]> {
  const notes: ConfigNote[] = [];
  if (Buffer.byteLength(text) > MAX_BYTES) {
    return [
      { tone: 'error', text: 'The file is larger than 64 KB; a config file is a few lines.' },
    ];
  }
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    if (!/^(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(t)) {
      notes.push({
        tone: 'warning',
        text: `Line ${i + 1} is not KEY=value or a # comment, so it is ignored.`,
      });
    }
  });
  const values = valuesOf(text);
  // In the file's own order, so the notes read top to bottom.
  const order = [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
        .filter((k): k is string => Boolean(k && values[k] !== undefined)),
    ),
  ];
  for (const key of order) {
    const value = values[key]!;
    const known = KNOWN.get(key);
    if (!known) {
      notes.push({ tone: 'warning', text: `${key} is not a setting Magpipe reads. A typo?` });
      continue;
    }
    if (known.managed === 'ignored') {
      notes.push({
        tone: 'warning',
        text: `${key} is set by Magpipe itself; this value is ignored.`,
      });
    }
    if (known.values && !known.values.includes(value)) {
      notes.push({
        tone: 'error',
        text: `${key} takes ${known.values.join(' or ')}, not ${value}.`,
      });
    }
    if (known.command) {
      try {
        await fs.access(value, fs.constants.X_OK);
      } catch {
        notes.push({ tone: 'warning', text: `${key}: there is no command at ${value}.` });
      }
    }
  }
  if (values.MAGPIPE_MODEL_BACKEND === 'api' && !values.ANTHROPIC_API_KEY) {
    notes.push({
      tone: 'warning',
      text: 'MAGPIPE_MODEL_BACKEND is api but ANTHROPIC_API_KEY is empty: runs would have no key.',
    });
  }
  // The key that seals stored secrets stays as it is: changing it, or taking it out of the
  // file, would leave every stored key and token unreadable.
  if (before !== null) {
    const was = valuesOf(before).MAGPIPE_SECRET_KEY ?? null;
    const now = values.MAGPIPE_SECRET_KEY ?? null;
    if (was !== now) {
      notes.push({
        tone: 'error',
        text: 'MAGPIPE_SECRET_KEY must stay as it is: every stored key and token is sealed with it.',
      });
    }
  }
  return notes;
}

/** Keys whose value in the file is not the one the running app has: a restart applies them. */
function pendingKeys(values: Record<string, string>): string[] {
  return CONFIG_KEYS.filter((k) => k.managed !== 'ignored')
    .map((k) => k.key)
    .filter((key) => {
      const file = values[key];
      const running = process.env[key] ?? '';
      // A generated secret is not in the file at all: the one the app made is in use.
      if (file === undefined && (key === 'MAGPIPE_SECRET_KEY' || key === 'AUTH_SECRET')) {
        return false;
      }
      return (file ?? '') !== running;
    });
}

function describe(text: string, filePath: string): Omit<ConfigFile, 'notes'> {
  const values = valuesOf(text);
  const pending = pendingKeys(values);
  return {
    path: filePath,
    text,
    version: hashOf(text),
    pending,
    keys: CONFIG_KEYS.filter((k) => k.managed !== 'ignored').map((k) => ({
      ...k,
      set: values[k.key] !== undefined,
      pending: pending.includes(k.key),
    })),
  };
}

/** The config file as it is now. Null when this app has none it may edit. */
export async function readConfigFile(): Promise<ConfigFile | null> {
  const filePath = configFilePath();
  if (!filePath) return null;
  let text = '';
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { ...describe(text, filePath), notes: await checkConfigText(text, null) };
}

/**
 * Saves the edited text, if the file is still the one the editor read (`version`) and the text
 * has no errors. The new file is written beside the old and renamed over it, so a crash leaves
 * one or the other, never half of each; it is readable by its owner only, like the first one.
 */
export async function saveConfigFile(text: string, version: string): Promise<ConfigFile> {
  const filePath = configFilePath();
  if (!filePath) throw new ConfigFileError('This app has no config file to edit here.');
  let current = '';
  try {
    current = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (hashOf(current) !== version) {
    throw new ConfigFileError(
      'The file changed outside Magpipe since you opened it. Reload it, then make your change again.',
    );
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  const notes = await checkConfigText(normalized, current);
  const error = notes.find((n) => n.tone === 'error');
  if (error) throw new ConfigFileError(error.text);
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(temp, normalized, { mode: 0o600 });
    await fs.rename(temp, filePath);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
  return { ...describe(normalized, filePath), notes };
}

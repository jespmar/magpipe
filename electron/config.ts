/**
 * Desktop configuration lives in <userData>/magpipe.env (same keys as .env.example), so a
 * packaged app never carries secrets from the build machine. AUTH_SECRET is generated once.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export type DesktopConfig = {
  configPath: string;
  logDir: string;
  env: Record<string, string>;
};

const TEMPLATE = `# Magpipe desktop configuration. Restart Magpipe after editing.
# Your data (database, uploads) lives in the "data" folder next to this file.

# Footer label.
MAGPIPE_REGION=local

# Model provider key — used once the run engine lands.
ANTHROPIC_API_KEY=
`;

function readOrCreateSecret(file: string): string {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first launch */
  }
  const secret = randomBytes(32).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadDesktopConfig(userData: string): DesktopConfig {
  fs.mkdirSync(userData, { recursive: true });
  const configPath = path.join(userData, 'magpipe.env');
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, TEMPLATE, { mode: 0o600 });

  const fromFile = Object.fromEntries(
    Object.entries(parseEnv(fs.readFileSync(configPath, 'utf8'))).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
    ),
  );

  const dataDir = path.join(userData, 'data');
  const logDir = path.join(userData, 'logs');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  return {
    configPath,
    logDir,
    env: {
      ...fromFile,
      // Auth.js is mounted even though the desktop app has no sign-in; give it a secret so its
      // routes never error.
      AUTH_SECRET: fromFile.AUTH_SECRET ?? readOrCreateSecret(path.join(userData, 'auth-secret')),
      // Encrypts tool credentials at rest (lib/secrets.ts); generated once, never leaves userData.
      MAGPIPE_SECRET_KEY:
        fromFile.MAGPIPE_SECRET_KEY ?? readOrCreateSecret(path.join(userData, 'secret-key')),
      AUTH_TRUST_HOST: 'true',
      MAGPIPE_DESKTOP: '1',
      MAGPIPE_CONFIG_PATH: configPath,
      MAGPIPE_DATA_DIR: dataDir,
    },
  };
}

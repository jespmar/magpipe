// `npm run dev`: compile the Electron main process, start `next dev`, wait for it, then open
// the Electron window against it. Closing the window stops everything.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT ?? 3456);
const PROBE = `http://127.0.0.1:${PORT}`;
// Window URL: Next normalises loopback hosts to `localhost` in redirects (see electron/server.ts).
const URL_BASE = `http://localhost:${PORT}`;
// Shared by `next dev` (checks it) and Electron (hands it to the window) — docs/decisions.md D4.
const TOKEN = randomBytes(32).toString('base64url');

const tsc = spawnSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '-p', 'electron/tsconfig.json'],
  { stdio: 'inherit' },
);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

let electronBin;
try {
  electronBin = require('electron'); // resolves to the binary path when run from Node
} catch {
  console.error(
    '\n✗ The Electron binary is not installed. Run `node node_modules/electron/install.js`,\n' +
      '  or use `npm run dev:web` to work in the browser.\n',
  );
  process.exit(1);
}

const children = new Set();
let exiting = false;
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

const next = spawn(
  process.execPath,
  [
    require.resolve('next/dist/bin/next'),
    'dev',
    '--turbopack',
    '--port',
    String(PORT),
    '--hostname',
    '127.0.0.1',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, MAGPIPE_DESKTOP: '1', MAGPIPE_DESKTOP_TOKEN: TOKEN },
  },
);
children.add(next);
next.on('exit', (code) => shutdown(code ?? 1));

const deadline = Date.now() + 120_000;
for (;;) {
  try {
    if ((await fetch(`${PROBE}/api/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  if (Date.now() > deadline) {
    console.error(`✗ next dev did not answer on ${PROBE} within 120 s`);
    shutdown(1);
  }
  await new Promise((r) => setTimeout(r, 300));
}

const electron = spawn(electronBin, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, MAGPIPE_DEV_SERVER_URL: URL_BASE, MAGPIPE_DESKTOP_TOKEN: TOKEN },
});
children.add(electron);
electron.on('exit', (code) => shutdown(code ?? 0));

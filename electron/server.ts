/**
 * Boots the Next.js standalone server (`server.js`) in an Electron utility process and waits
 * until /api/health answers.
 */
import { utilityProcess } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export type ServerHandle = {
  url: string;
  port: number;
  /** Ask the server to close the database and exit; kills it after `timeoutMs`. */
  shutdown: (timeoutMs?: number) => Promise<void>;
  onExit: (cb: (code: number) => void) => void;
};

type StartOptions = {
  /** Directory holding `server.js`, `.next/` and `public/` (copied from `.next/standalone`). */
  serverDir: string;
  env: Record<string, string>;
  logFile: string;
  /** Per-launch secret; only requests carrying it are served (docs/decisions.md D4). */
  token: string;
  /** A stable port keeps the origin (and so localStorage) stable across launches. */
  preferredPort?: number;
  timeoutMs?: number;
};

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function randomFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs: number, aborted: () => boolean) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (aborted()) return;
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`The Magpipe server did not start within ${Math.round(timeoutMs / 1000)} s.`);
}

export async function startServer(opts: StartOptions): Promise<ServerHandle> {
  const preferred = opts.preferredPort ?? 3456;
  const port = (await portIsFree(preferred)) ? preferred : await randomFreePort();
  // The server binds 127.0.0.1, but the window uses `localhost`: Next normalises loopback
  // hosts to `localhost` when it builds redirects, and cookies are per host name.
  const url = `http://localhost:${port}`;
  const probe = `http://127.0.0.1:${port}`;

  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const log = fs.createWriteStream(opts.logFile, { flags: 'a' });
  log.write(`\n── ${new Date().toISOString()} starting on ${url}\n`);

  const child = utilityProcess.fork(path.join(opts.serverDir, 'server.js'), [], {
    cwd: opts.serverDir,
    serviceName: 'Magpipe server',
    stdio: 'pipe',
    env: {
      ...(process.env as Record<string, string>),
      ...opts.env,
      MAGPIPE_DESKTOP_TOKEN: opts.token,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
    },
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);

  let exitCode: number | null = null;
  const exitListeners: ((code: number) => void)[] = [];
  child.once('exit', (code) => {
    exitCode = code;
    log.write(`── server exited with code ${code}\n`);
    exitListeners.forEach((cb) => cb(code));
  });

  // The first launch also creates the database, so allow for a slow disk.
  await waitForHealth(probe, opts.timeoutMs ?? 60_000, () => exitCode !== null);
  if (exitCode !== null) {
    throw new Error(`The Magpipe server exited during start-up (code ${exitCode}).`);
  }

  return {
    url,
    port,
    shutdown: async (timeoutMs = 5_000) => {
      if (exitCode !== null) return;
      const exited = new Promise<void>((resolve) => exitListeners.push(() => resolve()));
      try {
        await fetch(`${probe}/api/internal/shutdown`, {
          method: 'POST',
          headers: { 'x-magpipe-token': opts.token },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        /* fall through to the timeout */
      }
      const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), timeoutMs)),
      ]);
      if (timedOut && exitCode === null) child.kill();
    },
    onExit: (cb) => exitListeners.push(cb),
  };
}

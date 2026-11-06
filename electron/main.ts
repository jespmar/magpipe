/**
 * Electron main process. Magpipe is a Next.js app; the desktop build boots the Next standalone
 * server in a utility process on 127.0.0.1 and points a hardened BrowserWindow at it.
 *
 *   dev  → scripts/dev.mjs runs `next dev` and sets MAGPIPE_DEV_SERVER_URL
 *   prod → <resources>/server/server.js (from `.next/standalone`) via ./server.ts
 */
import {
  app,
  BrowserWindow,
  Menu,
  session,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadDesktopConfig, type DesktopConfig } from './config';
import { startServer, type ServerHandle } from './server';
import { loadingPage, errorPage } from './pages';

const DEV_URL = process.env.MAGPIPE_DEV_SERVER_URL;
const isMac = process.platform === 'darwin';

/**
 * Per-launch secret. The server only answers requests that carry it, and only this app's
 * window has it (as a session cookie) — so other local programs and web pages in a normal
 * browser cannot drive Magpipe. In dev, scripts/dev.mjs shares one token with `next dev`.
 */
const TOKEN = process.env.MAGPIPE_DESKTOP_TOKEN || randomBytes(32).toString('base64url');
const TOKEN_COOKIE = 'magpipe_desktop'; // lib/auth-mode.ts DESKTOP_COOKIE

let server: ServerHandle | null = null;
let config: DesktopConfig | null = null;
let appUrl: string | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

function isAppUrl(raw: string): boolean {
  if (!appUrl) return false;
  try {
    return new URL(raw).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

function openExternal(raw: string) {
  try {
    const { protocol } = new URL(raw);
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') {
      void shell.openExternal(raw);
    }
  } catch {
    /* ignore malformed URLs */
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Magpipe',
    backgroundColor: '#101010',
    show: false,
    // macOS: the app's frosted nav doubles as the title bar (see app/globals.css).
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 23 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // New windows (target=_blank, window.open) always go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  // In-place navigation stays on the app origin; everything else opens in the system browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function hardenSessions() {
  const ses = session.defaultSession;
  // Deny every permission except clipboard writes from our own pages (Copy buttons).
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permission === 'clipboard-sanitized-write' && isAppUrl(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return permission === 'clipboard-sanitized-write' && isAppUrl(requestingOrigin);
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function buildMenu() {
  const configItems: MenuItemConstructorOptions[] = config
    ? [
        { label: 'Open Config File', click: () => void shell.openPath(config!.configPath) },
        { label: 'Show Logs', click: () => void shell.openPath(config!.logDir) },
        { type: 'separator' },
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [...configItems, isMac ? { role: 'close' } : { role: 'quit' }],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  hardenSessions();
  mainWindow = createWindow();
  await mainWindow.loadURL(loadingPage());

  try {
    if (DEV_URL) {
      appUrl = DEV_URL;
    } else {
      config = loadDesktopConfig(app.getPath('userData'));
      server = await startServer({
        serverDir: path.join(process.resourcesPath, 'server'),
        env: config.env,
        token: TOKEN,
        logFile: path.join(config.logDir, 'server.log'),
      });
      server.onExit((code) => {
        if (!quitting) {
          void mainWindow?.loadURL(
            errorPage(`The Magpipe server stopped (exit code ${code}).`, config?.logDir),
          );
        }
      });
      appUrl = server.url;
    }
    buildMenu();
    // Session cookie (no expiry): gone when the app quits, like the token itself.
    await session.defaultSession.cookies.set({
      url: appUrl,
      name: TOKEN_COOKIE,
      value: TOKEN,
      httpOnly: true,
      sameSite: 'strict',
    });
    await mainWindow.loadURL(appUrl);
  } catch (err) {
    console.error(err);
    await mainWindow.loadURL(
      errorPage(err instanceof Error ? err.message : String(err), config?.logDir),
    );
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(boot, (err) => {
    console.error(err);
    app.quit();
  });

  app.on('activate', () => {
    // macOS: re-open a window when the dock icon is clicked and none are open.
    if (!mainWindow && appUrl) {
      mainWindow = createWindow();
      void mainWindow.loadURL(appUrl);
    }
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });

  // Close the embedded database cleanly before exiting.
  app.on('before-quit', (event) => {
    if (quitting || !server) return;
    quitting = true;
    event.preventDefault();
    void server.shutdown().finally(() => app.quit());
  });
}

import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { headers } from 'next/headers';
import './globals.css';

// Self-hosted at build time by next/font, so the desktop app needs no network for fonts.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Magpipe', template: '%s · Magpipe' },
  description: 'Magpipe — agent orchestrator',
};

export const viewport: Viewport = {
  themeColor: '#101010',
  colorScheme: 'dark',
};

/**
 * In the Electron window on macOS the nav doubles as the title bar (hidden-inset traffic
 * lights). The default Electron user agent carries `Electron/<version>`, so the server can
 * render the right chrome on the first paint.
 */
async function desktopPlatform(): Promise<string | undefined> {
  const ua = (await headers()).get('user-agent') ?? '';
  if (!/\bElectron\//.test(ua)) return undefined;
  return /Macintosh/.test(ua) ? 'darwin' : 'other';
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} data-desktop={await desktopPlatform()}>
      <body>{children}</body>
    </html>
  );
}

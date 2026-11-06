/** Exposed by electron/preload.ts — undefined in a normal browser. */
interface Window {
  magpipeDesktop?: {
    platform: NodeJS.Platform;
    versions: { electron: string; chrome: string };
  };
}

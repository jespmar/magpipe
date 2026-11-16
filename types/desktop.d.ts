/** What the desktop app's preload (electron/preload.ts) puts on `window`; absent in a browser. */
export {};

declare global {
  interface Window {
    magpipeDesktop?: {
      platform: string;
      versions: { electron: string; chrome: string };
      /** Restarts Magpipe, so a saved config file applies (D48). */
      restart(): Promise<boolean>;
      /** Opens magpipe.env in the operator's own editor (D48). */
      openConfigFile(): Promise<boolean>;
      /** The system's folder picker; null when the operator cancels it (D49). */
      pickFolder(options?: {
        title?: string;
        defaultPath?: string;
        buttonLabel?: string;
      }): Promise<string | null>;
    };
  }
}

/**
 * Sandboxed preload. Exposes a deliberately tiny surface — add IPC here only through named,
 * validated channels (never expose ipcRenderer itself). The main process answers each channel
 * only for the app's own window (main.ts).
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('magpipeDesktop', {
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  /** Restarts Magpipe, so a saved config file applies (D48). */
  restart: (): Promise<boolean> => ipcRenderer.invoke('magpipe:restart'),
  /** Opens magpipe.env in the operator's own editor (D48). */
  openConfigFile: (): Promise<boolean> => ipcRenderer.invoke('magpipe:open-config'),
});

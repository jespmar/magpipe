/**
 * Sandboxed preload. Exposes a deliberately tiny, read-only surface — add IPC here only
 * through named, validated channels (never expose ipcRenderer itself).
 */
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('magpipeDesktop', {
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
});

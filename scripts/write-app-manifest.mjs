// electron-builder's "two package.json" layout: dist-electron/ is the packaged app and gets a
// manifest with no dependencies, so none of the web app's node_modules land in app.asar. The
// Next server and its traced node_modules ship separately as extraResources (server/).
import fs from 'node:fs';

const root = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const manifest = {
  name: root.name,
  productName: root.productName,
  version: root.version,
  description: root.description,
  author: root.author ?? 'Magpipe',
  private: true,
  main: 'main.js',
  // electron-builder: the .desktop file name Electron's window association uses on Linux.
  desktopName: 'magpipe.desktop',
};
fs.mkdirSync('dist-electron', { recursive: true });
fs.writeFileSync('dist-electron/package.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`write-app-manifest: dist-electron/package.json (v${manifest.version})`);

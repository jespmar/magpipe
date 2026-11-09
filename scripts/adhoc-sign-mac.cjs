// electron-builder afterPack hook. Without a signing certificate electron-builder ships the
// macOS app with no signature at all, and macOS then refuses a downloaded copy as "damaged"
// (on Apple Silicon an unsigned binary cannot run). An ad-hoc signature turns that into the
// "unidentified developer" case, where right-click → Open works. A real identity, when one is
// configured, signs during packaging and this hook leaves it alone.
// electron-builder loads hooks with require(), so this file stays CommonJS.
/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  let signed = '';
  try {
    signed = execFileSync('codesign', ['-dv', '--verbose=2', appPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (err) {
    signed = String(err.stderr ?? '');
  }
  if (/Authority=/.test(signed)) {
    console.log('adhoc-sign-mac: app already carries a certificate signature, nothing to do');
    return;
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`adhoc-sign-mac: ad-hoc signed ${path.basename(appPath)}`);
};

// electron-builder afterPack hook (scripts/package.mjs): ad-hoc sign the whole macOS bundle before the dmg/zip
// are made, so Apple Silicon accepts the modified bundle (ADR-014). Developer ID builds do not use this hook.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};

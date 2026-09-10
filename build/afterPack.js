'use strict';

// electron-builder afterPack hook: ad-hoc code sign every packed macOS app.
//
// Builds have no Developer ID certificate, and a completely unsigned app that
// macOS has quarantined (i.e. anything downloaded) is reported as "damaged"
// with no override offered. An ad-hoc signature keeps the bundle internally
// consistent so Gatekeeper instead shows the standard "unidentified
// developer" prompt, where right-click → Open works. Runs for every arch —
// codesign is architecture-independent.

const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = `${context.appOutDir}/${appName}`;
  console.log(`ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};

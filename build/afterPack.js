'use strict';

// electron-builder afterPack hook for macOS builds:
//
// 1. Strip non-English Chromium locales. Electron 44 ships its locale data
//    as ~440 `*.lproj/locale.pak` folders inside the framework (~48 MB of
//    already-compressed data, so it barely compresses further in the DMG).
//    `electronLanguages` does not cover this layout, so walk the bundle and
//    remove every .lproj that is not an English one.
// 2. Ad-hoc code sign the packed app. Builds have no Developer ID
//    certificate, and a completely unsigned app that macOS has quarantined
//    (i.e. anything downloaded) is reported as "damaged" with no override
//    offered. An ad-hoc signature keeps the bundle internally consistent so
//    Gatekeeper instead shows the standard "unidentified developer" prompt,
//    where right-click → Open works. codesign is architecture-independent,
//    so this runs for every arch.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function stripNonEnglishLocales(appPath) {
  let removed = 0;
  let bytes = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.lproj')) {
          if (!/^en([_.]|$)/i.test(entry.name)) {
            bytes += dirSize(full);
            fs.rmSync(full, { recursive: true, force: true });
            removed += 1;
          }
        } else {
          walk(full);
        }
      }
    }
  };
  walk(appPath);
  console.log(`stripped ${removed} non-English .lproj folders (~${Math.round(bytes / 1048576)} MB)`);
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = `${context.appOutDir}/${appName}`;

  stripNonEnglishLocales(appPath);

  console.log(`ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};

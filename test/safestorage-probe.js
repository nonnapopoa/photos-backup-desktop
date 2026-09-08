'use strict';

// Two-phase safeStorage probe: run with `write` first, then `read` in a
// SEPARATE process, to see whether an encrypted blob survives a restart.
// Usage: npx electron test/safestorage-probe.js write|read

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const file = path.join(app.getPath('userData'), 'safeStorage-probe.txt');
const PLAINTEXT = 'photos-backup-probe-fixed-plaintext';

app.whenReady().then(() => {
  const mode = process.argv[process.argv.length - 1];
  console.log(`PROBE: mode=${mode} available=${safeStorage.isEncryptionAvailable()}`);
  try {
    if (mode === 'write') {
      fs.rmSync(file, { force: true });
      const blob = safeStorage.encryptString(PLAINTEXT).toString('base64');
      fs.writeFileSync(file, blob);
      console.log(`PROBE: wrote ${blob.length} chars`);
      process.exit(0);
    } else {
      const blob = fs.readFileSync(file, 'utf8');
      const decrypted = safeStorage.decryptString(Buffer.from(blob, 'base64'));
      console.log(`PROBE: decrypted=${decrypted === PLAINTEXT ? 'MATCH' : 'MISMATCH'} (${decrypted.slice(0, 20)}…)`);
      process.exit(0);
    }
  } catch (error) {
    console.log(`PROBE: FAILED ${error.message}`);
    process.exit(1);
  }
});

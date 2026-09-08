'use strict';

// Credential persistence. The desktop equivalent of the iOS Keychain record in
// App/Sources/CredentialStore.swift: one secret blob, encrypted at rest with
// Electron safeStorage (Keychain on macOS, DPAPI on Windows, libsecret on
// Linux) and stored under userData.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const FILENAME = 'credential.bin';

function credentialPath() {
  return path.join(app.getPath('userData'), FILENAME);
}

class CredentialStore {
  constructor() {
    this.cached = null;
  }

  load() {
    if (this.cached) return this.cached;
    const file = credentialPath();
    if (!fs.existsSync(file)) return null;
    try {
      const blob = fs.readFileSync(file);
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(blob, 'base64'))
        : blob.toString('utf8');
      this.cached = JSON.parse(json);
      return this.cached;
    } catch {
      // A blob we cannot decode is deleted rather than left to fail on every
      // launch (matches the Swift store's .corrupt handling).
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      return null;
    }
  }

  save(credential) {
    this.cached = credential;
    const json = JSON.stringify(credential);
    const data = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json).toString('base64')
      : json;
    fs.writeFileSync(credentialPath(), data, { mode: 0o600 });
    return credential;
  }

  clear() {
    this.cached = null;
    try { fs.unlinkSync(credentialPath()); } catch { /* ignore */ }
  }
}

module.exports = { CredentialStore };

'use strict';

// Credential persistence. The desktop equivalent of the iOS Keychain record in
// App/Sources/CredentialStore.swift: one secret blob, encrypted at rest with
// Electron safeStorage (Keychain on macOS, DPAPI on Windows, libsecret on
// Linux) and stored under userData.
//
// Failure tolerance (learned the hard way): the storage backend's availability
// can differ between runs, and a load must never destroy the file. The blob is
// wrapped in a mode-tagged envelope; unreadable files are quarantined (renamed)
// rather than deleted, and every outcome is logged to credential-store.log.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const FILENAME = 'credential.bin';
const ENVELOPE_VERSION = 1;

function userDataDir() {
  return app.getPath('userData');
}

function credentialPath() {
  return path.join(userDataDir(), FILENAME);
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try { fs.appendFileSync(path.join(userDataDir(), 'credential-store.log'), line); } catch { /* best effort */ }
}

class LoadFailure extends Error {
  constructor(reason, detail) {
    super(`The saved credential could not be read (${reason}); connect the account again.`);
    this.name = 'LoadFailure';
    this.reason = reason;
    this.detail = detail;
  }
}

function writeEnvelope(json) {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const blob = safeStorage.encryptString(json).toString('base64');
      // Round-trip check: if this process cannot read back what it wrote, the
      // next launch cannot either — fall through to plaintext rather than
      // storing a credential that forces a re-login.
      safeStorage.decryptString(Buffer.from(blob, 'base64'));
      const envelope = JSON.stringify({ v: ENVELOPE_VERSION, mode: 'enc', data: blob });
      fs.writeFileSync(credentialPath(), envelope, { mode: 0o600 });
      log(`saved mode=enc ${envelope.length}B (round-trip verified)`);
      return;
    } catch (error) {
      log(`encryptString unusable, falling back to plaintext: ${error.message}`);
    }
  } else {
    log('save: encryption unavailable this run, storing plaintext');
  }
  const envelope = JSON.stringify({ v: ENVELOPE_VERSION, mode: 'plain', data: json });
  fs.writeFileSync(credentialPath(), envelope, { mode: 0o600 });
  log(`saved mode=plain ${envelope.length}B`);
}

function readEnvelope() {
  const raw = fs.readFileSync(credentialPath(), 'utf8');

  // New-format envelope. Failures inside it do NOT fall through to the legacy
  // readers below — a v1 envelope re-parsed as plaintext would just yield the
  // wrapper object, not a credential.
  let envelope = null;
  try { envelope = JSON.parse(raw); } catch { /* not JSON at all */ }
  if (envelope && envelope.v === ENVELOPE_VERSION && typeof envelope.data === 'string') {
    if (envelope.mode === 'enc') {
      try {
        const credential = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.data, 'base64')));
        log('loaded mode=enc');
        return credential;
      } catch (error) {
        throw new LoadFailure('decryption failed', error.message);
      }
    }
    if (envelope.mode === 'plain') {
      try {
        const credential = JSON.parse(envelope.data);
        log('loaded mode=plain');
        return credential;
      } catch (error) {
        throw new LoadFailure('record is corrupt', error.message);
      }
    }
    throw new LoadFailure('unknown envelope mode', String(envelope.mode));
  }

  // Old format (pre-envelope): raw encrypted base64 or raw plaintext JSON.
  try {
    const json = safeStorage.decryptString(Buffer.from(raw, 'base64'));
    const credential = JSON.parse(json);
    log('loaded legacy mode=enc');
    return credential;
  } catch (error) {
    log(`legacy decrypt failed: ${error.message}`);
  }
  try {
    const credential = JSON.parse(raw);
    if (credential && credential.authData) {
      log('loaded legacy mode=plain');
      return credential;
    }
  } catch (error) {
    log(`legacy plain parse failed: ${error.message}`);
  }

  throw new LoadFailure('unreadable data', raw.slice(0, 40));
}

class CredentialStore {
  constructor() {
    this.cached = null;
  }

  load() {
    if (this.cached) return this.cached;
    if (!fs.existsSync(credentialPath())) {
      log('load: no credential file');
      return null;
    }
    try {
      const credential = readEnvelope();
      if (!credential || !credential.authData || !credential.email) {
        throw new LoadFailure('incomplete record', '');
      }
      this.cached = credential;
      return credential;
    } catch (error) {
      // Quarantine, never delete: the file may decrypt again later (backend
      // prompts, locked keychain), and it is the only copy of the master token.
      const quarantined = credentialPath() + '.unreadable';
      try { fs.renameSync(credentialPath(), quarantined); } catch { /* ignore */ }
      const reason = error instanceof LoadFailure ? error.reason : error.message;
      log(`load failed (${reason}); quarantined to ${path.basename(quarantined)}`);
      this.lastLoadFailure = error instanceof LoadFailure ? error : new LoadFailure(reason, '');
      return null;
    }
  }

  save(credential) {
    this.cached = credential;
    writeEnvelope(JSON.stringify(credential));
    return credential;
  }

  // Keep a credential for this session only (used when save() fails).
  adopt(credential) {
    this.cached = credential;
    log('adopted in-memory only (save failed)');
  }

  clear() {
    this.cached = null;
    try { fs.unlinkSync(credentialPath()); } catch { /* ignore */ }
    log('cleared');
  }
}

module.exports = { CredentialStore };

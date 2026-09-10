'use strict';

// App settings + per-account upload memory, persisted as JSON under userData.
// `completed` mirrors the iOS app's account-scoped record of assets already
// backed up, keyed by path+size+mtime so moved-but-unchanged files still skip.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const DEFAULT_SETTINGS = {
  folders: [],
  // Mirrors the iOS app's two independent toggles (Settings → Backup).
  // Defaults match upstream UploadOptions: neither counts against quota nor
  // asks for Storage Saver — uploads go up as Pixel XL originals.
  storageSaver: false,
  useQuota: false,
  // Simultaneous uploads, 1–10 (upstream 0.3.2).
  concurrency: 2,
  autoStart: true,
};

function migrate(data) {
  // Pre-0.2 single "quality" dropdown → upstream's two toggles.
  if ('quality' in data) {
    if (data.quality === 'saver') data.storageSaver = true;
    delete data.quality;
  }
  return data;
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function completedPath(email) {
  const slug = crypto.createHash('sha256').update(email || 'unknown').digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), `completed-${slug}.json`);
}

function signature(item) {
  return `${item.path}|${item.size}|${Math.floor(item.mtimeMs / 1000)}`;
}

class Settings {
  constructor() {
    try {
      this.data = { ...DEFAULT_SETTINGS, ...migrate(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))) };
    } catch {
      this.data = { ...DEFAULT_SETTINGS };
    }
  }

  get(key) { return this.data[key]; }

  update(patch) {
    this.data = { ...this.data, ...patch };
    fs.writeFileSync(settingsPath(), JSON.stringify(this.data, null, 2));
    return this.data;
  }

  loadCompleted(email) {
    try {
      return new Set(JSON.parse(fs.readFileSync(completedPath(email), 'utf8')).signatures || []);
    } catch {
      return new Set();
    }
  }

  markCompleted(email, signatures) {
    if (!signatures.length || !email) return;
    const existing = this.loadCompleted(email);
    for (const sig of signatures) existing.add(sig);
    fs.writeFileSync(completedPath(email), JSON.stringify({ signatures: [...existing] }));
  }

  isCompleted(email, item) {
    return this.loadCompleted(email).has(signature(item));
  }

  // Upstream "Verify Backup": forget the account's completed record so a
  // re-check re-queues everything. The Google-side hash lookup settles what is
  // really in the cloud, so this only costs one hash + one RPC per file.
  clearCompleted(email) {
    try { fs.unlinkSync(completedPath(email)); } catch { /* ignore */ }
  }
}

module.exports = { Settings, signature };

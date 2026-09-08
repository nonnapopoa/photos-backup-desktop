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
  quality: 'original', // 'original' | 'saver' (Storage Saver processing)
  autoStart: true,
};

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
      this.data = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
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
}

module.exports = { Settings, signature };

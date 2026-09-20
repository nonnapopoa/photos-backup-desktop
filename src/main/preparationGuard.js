'use strict';

// Crash-loop guard storage. The desktop counterpart of upstream 0.3.6's
// PreparationMarkerStoring (g8row/PhotosBackup, UploadQueuePersistence.swift):
// which files were mid-preparation — hashing, duplicate check, transfer —
// when the process was executing. A file still marked at the next launch was
// being prepared when the process died, which is what a crash or an
// out-of-memory kill on that one file looks like. Without the guard, one
// poison file is the first thing every relaunch restarts (uploads run
// oldest-first), so the app closes again on every run and nothing else ever
// backs up. Interruption counts are kept per file signature; a file that has
// stopped the process twice is skipped as non-retryable.
//
// Writes are synchronous and atomic (temp file + rename) — the whole point is
// to survive the process being killed a moment later. Without Electron's app
// object (plain-node unit tests) the stores stay in memory and touch no disk.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function userDataDir() {
  try {
    return app && typeof app.getPath === 'function' ? app.getPath('userData') : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

// The set of file signatures the queue is currently preparing. load() reads
// and clears in one step (upstream takePreparationMarkers): whatever is left
// belonged to a previous process.
class PreparationMarkers {
  constructor(file = null) {
    this.explicitFile = file;
    this.ids = new Set();
  }

  filePath() {
    if (this.explicitFile) return this.explicitFile;
    const dir = userDataDir();
    return dir ? path.join(dir, 'preparing-v1.json') : null;
  }

  load() {
    let ids = [];
    const file = this.filePath();
    if (file) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed.signatures)) ids = parsed.signatures;
      } catch { /* absent or unreadable — nothing was being prepared */ }
    }
    this.ids = new Set(ids);
    this.save(this.ids);
    return new Set(ids);
  }

  save(ids) {
    this.ids = new Set(ids);
    const file = this.filePath();
    if (!file) return;
    try {
      if (!this.ids.size) fs.unlinkSync(file);
      else writeJsonAtomic(file, { signatures: [...this.ids].sort() });
    } catch { /* a missed guard write must never take the queue down */ }
  }

  add(id) {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.save(this.ids);
  }

  remove(id) {
    if (!this.ids.delete(id)) return;
    this.save(this.ids);
  }

  clear() {
    if (!this.ids.size) return;
    this.ids = new Set();
    this.save(this.ids);
  }
}

// How many times the process died while a given file was being prepared,
// keyed by the same path|size|mtime signature as the completed record.
class InterruptionCounters {
  constructor(file = null) {
    this.explicitFile = file;
    this.counts = null;
  }

  filePath() {
    if (this.explicitFile) return this.explicitFile;
    const dir = userDataDir();
    return dir ? path.join(dir, 'preparing-interruptions-v1.json') : null;
  }

  load() {
    if (this.counts) return this.counts;
    const file = this.filePath();
    if (file) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.counts = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        this.counts = {};
      }
    } else {
      this.counts = {};
    }
    return this.counts;
  }

  persist() {
    const file = this.filePath();
    if (!file) return;
    try {
      if (!Object.keys(this.counts).length) fs.unlinkSync(file);
      else writeJsonAtomic(file, this.counts);
    } catch { /* best effort */ }
  }

  bump(id) {
    const counts = this.load();
    counts[id] = (counts[id] || 0) + 1;
    this.persist();
    return counts[id];
  }

  get(id) {
    return this.load()[id] || 0;
  }

  clear(id) {
    if (!(id in this.load())) return;
    delete this.counts[id];
    this.persist();
  }
}

module.exports = { PreparationMarkers, InterruptionCounters };

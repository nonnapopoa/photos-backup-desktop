'use strict';

// Upload queue. The desktop counterpart of App/Sources/UploadQueue.swift:
// bounded-concurrency uploads with per-item progress (hash -> duplicate check
// -> send -> finalize), retry with backoff for transient failures,
// cancellation, and an account-scoped record of already-backed-up files.

const { GPMCClient, GPMCError } = require('./gpmc');
const { signature } = require('./settings');

const CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;
const BACKOFF_SECONDS = [1, 5, 15];

class UploadQueue {
  constructor({ credential, settings, onSnapshot }) {
    this.client = new GPMCClient(credential.authData);
    this.email = credential.email;
    this.settings = settings;
    this.onSnapshot = onSnapshot || (() => {});
    this.items = [];
    this.paused = false;
    this.cancelRequested = false;
    this.abort = new AbortController();
    this.snapTimer = null;
  }

  // Replace the queue with a scan of the configured folders. Items already
  // recorded as completed for this account are skipped up front; the rest are
  // still hash-checked against Google's side before any bytes are sent.
  async enqueueScan(scanResults) {
    this.cancelRequested = false;
    this.abort = new AbortController();
    const completed = this.settings.loadCompleted(this.email);
    const existing = new Map(this.items.map((item) => [item.path, item]));
    this.items = scanResults.map((found) => {
      const prior = existing.get(found.path);
      const done = completed.has(signature(found));
      return {
        ...found,
        status: done ? 'alreadyBackedUp' : 'waiting',
        detail: done ? 'recorded from a previous run' : (prior?.detail || null),
        error: null,
        attempts: 0,
      };
    });
    this.emitSnapshot();
    this.pump();
  }

  retryFailed() {
    for (const item of this.items) {
      if (item.status === 'failed' || item.status === 'cancelled') {
        item.status = 'waiting';
        item.error = null;
        item.attempts = 0;
      }
    }
    this.cancelRequested = false;
    this.abort = new AbortController();
    this.emitSnapshot();
    this.pump();
  }

  pause() { this.paused = true; this.emitSnapshot(); }
  resume() { this.paused = false; this.emitSnapshot(); this.pump(); }

  cancelAll() {
    this.cancelRequested = true;
    this.abort.abort();
    for (const item of this.items) {
      if (item.status === 'waiting') item.status = 'cancelled';
    }
    this.emitSnapshot();
  }

  get activeCount() {
    return this.items.filter((i) => !['waiting', 'uploaded', 'alreadyBackedUp', 'failed', 'cancelled'].includes(i.status)).length;
  }

  summary() {
    const counts = { total: this.items.length, waiting: 0, active: 0, uploaded: 0, alreadyBackedUp: 0, failed: 0, cancelled: 0 };
    for (const item of this.items) {
      if (item.status === 'waiting') counts.waiting += 1;
      else if (item.status === 'uploaded') counts.uploaded += 1;
      else if (item.status === 'alreadyBackedUp') counts.alreadyBackedUp += 1;
      else if (item.status === 'failed') counts.failed += 1;
      else if (item.status === 'cancelled') counts.cancelled += 1;
      else counts.active += 1;
    }
    return counts;
  }

  emitSnapshot() {
    if (this.snapTimer) return; // coalesce to one per tick
    this.snapTimer = setTimeout(() => {
      this.snapTimer = null;
      this.onSnapshot({
        counts: this.summary(),
        paused: this.paused,
        items: this.items.map((item) => ({
          path: item.path,
          filename: item.filename,
          size: item.size,
          status: item.status,
          detail: item.detail || null,
          error: item.error || null,
          attempts: item.attempts,
        })),
      });
    }, 100);
  }

  async pump() {
    if (this.paused || this.cancelRequested) return;
    const inFlight = this.items.filter((i) => this.isRunning(i.status)).length;
    let slots = CONCURRENCY - inFlight;
    for (const item of this.items) {
      if (slots <= 0) break;
      if (item.status !== 'waiting') continue;
      slots -= 1;
      this.runItem(item).catch(() => { /* runItem records its own failures */ });
    }
  }

  isRunning(status) {
    return ['hashing', 'checkingDuplicate', 'preparing', 'sending', 'finalizing'].includes(status);
  }

  async runItem(item) {
    const saver = this.settings.get('quality') === 'saver';
    const useQuota = !saver;
    try {
      item.attempts += 1;
      const result = await this.client.upload(item.path, {
        filename: item.filename,
        modified: new Date(item.mtimeMs),
        useQuota,
        saver,
        signal: this.abort.signal,
        onPhase: (phase) => {
          if (this.abort.signal.aborted) return;
          item.status = phase.phase === 'sending' ? 'sending'
            : phase.phase === 'hashing' ? 'hashing'
            : phase.phase === 'checkingDuplicate' ? 'checkingDuplicate'
            : phase.phase === 'preparing' ? 'preparing'
            : 'finalizing';
          item.detail = phase.phase === 'hashing' ? `${Math.round((phase.fraction || 0) * 100)}% hashed`
            : phase.phase === 'sending' ? `${this.formatBytes(phase.sent)} / ${this.formatBytes(phase.total)}`
            : null;
          this.emitSnapshot();
        },
      });
      item.status = result.outcome; // 'uploaded' | 'alreadyBackedUp'
      item.detail = null;
      this.settings.markCompleted(this.email, [signature(item)]);
      this.emitSnapshot();
    } catch (error) {
      if (this.abort.signal.aborted || this.cancelRequested || error.message === 'aborted') {
        item.status = 'cancelled';
        item.detail = null;
      } else {
        const retryable = error instanceof GPMCError && error.retryable;
        if (retryable && item.attempts < MAX_ATTEMPTS) {
          item.status = 'waiting';
          item.error = `attempt ${item.attempts} failed (${error.message}); retrying`;
          const wait = (BACKOFF_SECONDS[Math.min(item.attempts - 1, BACKOFF_SECONDS.length - 1)]) * 1000;
          setTimeout(() => this.pump(), wait);
        } else {
          item.status = 'failed';
          item.error = error.message;
        }
      }
      this.emitSnapshot();
    } finally {
      this.pump();
    }
  }

  formatBytes(n) {
    if (!Number.isFinite(n)) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = n;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }
}

module.exports = { UploadQueue };

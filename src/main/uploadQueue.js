'use strict';

// Upload queue. The desktop counterpart of App/Sources/UploadQueue.swift:
// bounded-concurrency uploads with per-item progress (hash -> duplicate check
// -> send -> finalize), retry with the upstream's backoff schedule
// (min(30, 2^attempt)), a queue-wide halt when the credential is refused, and
// an account-scoped record of already-backed-up files.
//
// Desktop addition the upstream gets for free from iOS: when Google answers
// HTTP 429 (per-minute quota), a queue-wide cooldown pauses *new* item starts
// so one quota window does not burn the retry budget of every queued item.

const { GPMCClient, GPMCError } = require('./gpmc');
const { signature } = require('./settings');

const DEFAULT_CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 10;
// Upstream: scheduleRetry(after: min(30, pow(2, attempt))) — 2s, 4s, 8s.
const backoffSeconds = (attempt) => Math.min(30, 2 ** attempt);
const QUOTA_COOLDOWN_MS = 60000;

const clampConcurrency = (n) => {
  const value = Number(n);
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY,
    Math.round(Number.isFinite(value) ? value : DEFAULT_CONCURRENCY)));
};

class UploadQueue {
  constructor({ credential, settings, onSnapshot, clientFactory, quotaCooldownMs = QUOTA_COOLDOWN_MS }) {
    this.clientFactory = clientFactory || ((authData) => new GPMCClient(authData));
    this.client = this.clientFactory(credential.authData);
    this.email = credential.email;
    this.settings = settings;
    this.onSnapshot = onSnapshot || (() => {});
    this.quotaCooldownMs = quotaCooldownMs;
    this.maxConcurrent = clampConcurrency(settings?.get?.('concurrency') ?? DEFAULT_CONCURRENCY);
    this.items = [];
    this.paused = false;
    this.cancelRequested = false;
    this.abort = new AbortController();
    this.snapTimer = null;
    this.haltReason = null;       // set when the credential is refused / storage is full
    this.cooldownUntil = 0;       // set when Google answers 429
    this.cooldownReason = null;
    this.retryTimers = new Set();
  }

  // Upstream setMaxConcurrent: applying a lower limit lets in-flight work
  // finish; a higher one starts replacements on the next pump.
  setMaxConcurrent(n) {
    const clamped = clampConcurrency(n);
    if (clamped === this.maxConcurrent) return;
    this.maxConcurrent = clamped;
    this.pump();
  }

  // Replace the queue with a scan of the configured folders. Items already
  // recorded as completed for this account are skipped up front; the rest are
  // still hash-checked against Google's side before any bytes are sent.
  // `limit` mirrors the upstream's bounded batches (250 per foreground run).
  async enqueueScan(scanResults, limit = Infinity) {
    this.cancelRequested = false;
    this.abort = new AbortController();
    const completed = this.settings.loadCompleted(this.email);
    const existing = new Map(this.items.map((item) => [item.path, item]));
    // Pending = found items that are neither recorded as completed for this
    // account nor already sitting in the queue (as failed/cancelled rows).
    const pending = scanResults.filter((found) =>
      !completed.has(signature(found)) && !existing.has(found.path));
    const batch = pending.slice(0, limit);
    this.items = [...this.items, ...batch.map((found) => ({
      ...found,
      status: 'waiting',
      detail: null,
      error: null,
      attempts: 0,
    }))];
    this.emitSnapshot();
    this.pump();
    return { queued: batch.length, remaining: Math.max(0, pending.length - batch.length) };
  }

  retryFailed() {
    this.haltReason = null;
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

  // Upstream retryRetryableFailures(): requeue every failed row whose error
  // was transient (transport, 5xx, quota, invalid receipt) so the next run
  // picks them up without the user pressing anything. Permanent failures —
  // unreadable files, refused credentials — are left alone.
  releaseRetryableFailures() {
    let released = 0;
    for (const item of this.items) {
      if (item.status === 'failed' && item.retryable) {
        item.status = 'waiting';
        item.error = null;
        item.detail = 'released for retry';
        item.attempts = 0;
        released += 1;
      }
    }
    if (released) {
      this.haltReason = null;
      this.emitSnapshot();
      this.pump();
    }
    return released;
  }

  pause() { this.paused = true; this.emitSnapshot(); }
  resume() { this.paused = false; this.emitSnapshot(); this.pump(); }

  cancelAll() {
    this.cancelRequested = true;
    this.abort.abort();
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    for (const item of this.items) {
      if (item.status === 'waiting') item.status = 'cancelled';
    }
    this.emitSnapshot();
  }

  get activeCount() {
    return this.items.filter((i) => !['waiting', 'uploaded', 'alreadyBackedUp', 'failed', 'cancelled'].includes(i.status)).length;
  }

  get isIdle() {
    return this.items.every((i) => ['uploaded', 'alreadyBackedUp', 'failed', 'cancelled'].includes(i.status));
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
        halted: this.haltReason,
        cooldownRemainingMs: this.cooldownUntil > Date.now() ? this.cooldownUntil - Date.now() : 0,
        cooldownReason: this.cooldownUntil > Date.now() ? this.cooldownReason : null,
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

  // Upstream pump(): start queued work while slots are free, the queue is not
  // paused/halted, and any quota cooldown has elapsed.
  pump() {
    if (this.paused || this.cancelRequested || this.haltReason) return;
    if (this.cooldownUntil > Date.now()) {
      // Re-check when the cooldown lifts.
      this.scheduleCooldownWake();
      return;
    }
    const inFlight = this.items.filter((i) => this.isRunning(i.status)).length;
    let slots = this.maxConcurrent - inFlight;
    for (const item of this.items) {
      if (slots <= 0) break;
      if (item.status !== 'waiting') continue;
      slots -= 1;
      // Mark the item running synchronously, before any client callback can
      // run (upstream sets .exporting in start() for the same reason): a
      // later pump must not see it as waiting and start it twice.
      item.status = 'exporting';
      item.detail = null;
      this.runItem(item).catch(() => { /* runItem records its own failures */ });
    }
  }

  scheduleCooldownWake() {
    if (this.cooldownWake) return;
    const wait = Math.max(250, this.cooldownUntil - Date.now());
    this.cooldownWake = setTimeout(() => {
      this.cooldownWake = null;
      this.emitSnapshot();
      this.pump();
    }, wait);
    this.cooldownWake.unref?.();
  }

  isRunning(status) {
    return ['exporting', 'hashing', 'checkingDuplicate', 'preparing', 'sending', 'finalizing'].includes(status);
  }

  async runItem(item) {
    const storageSaver = !!this.settings.get('storageSaver');
    const useQuota = !!this.settings.get('useQuota');
    try {
      item.attempts += 1;
      const result = await this.client.upload(item.path, {
        filename: item.filename,
        modified: new Date(item.mtimeMs),
        useQuota,
        saver: storageSaver,
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
      item.error = null;
      this.settings.markCompleted(this.email, [signature(item)]);
      this.emitSnapshot();
    } catch (error) {
      if (this.abort.signal.aborted || this.cancelRequested || error.message === 'aborted') {
        item.status = 'cancelled';
        item.detail = null;
      } else if (error instanceof GPMCError
                 && (error.kind === 'credentialRejected' || error.kind === 'tokenBound' || error.kind === 'storageFull')) {
        // Upstream: the item goes back to queued and the queue halts — no other
        // item can succeed until the account is reconnected (or storage is
        // freed, which only the user can do).
        item.status = 'waiting';
        item.detail = null;
        this.halt(error);
      } else {
        const retryable = error instanceof GPMCError && error.retryable;
        if (error instanceof GPMCError && error.statusCode === 429) {
          this.noteQuotaRejection();
        }
        if (retryable && item.attempts < MAX_ATTEMPTS) {
          item.status = 'waiting';
          item.error = null;
          item.detail = `attempt ${item.attempts} failed (${this.shortReason(error)}); retrying`;
          this.scheduleRetry(item, backoffSeconds(item.attempts));
        } else {
          item.status = 'failed';
          item.retryable = !!retryable;
          item.error = error.message;
          item.detail = null;
        }
      }
      this.emitSnapshot();
    } finally {
      this.pump();
    }
  }

  shortReason(error) {
    return error instanceof GPMCError ? `HTTP ${error.statusCode || error.kind}` : error.message;
  }

  scheduleRetry(item, seconds) {
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (item.status === 'waiting') this.pump();
    }, seconds * 1000);
    timer.unref?.();
    this.retryTimers.add(timer);
  }

  halt(error) {
    if (this.haltReason) return;
    this.haltReason = error.message;
    // Requeue anything in flight; a reconnect (new queue) or Retry resumes.
    this.abort.abort();
    this.abort = new AbortController();
    this.emitSnapshot();
  }

  formatBytes(n) {
    if (!Number.isFinite(n)) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = n;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  // Called when a request came back with HTTP 429: pause new item starts for
  // a minute so the quota window can reset without burning every item's
  // retry budget.
  noteQuotaRejection() {
    this.cooldownUntil = Date.now() + this.quotaCooldownMs;
    this.cooldownReason = 'Google rate limit (429) — pausing new uploads for a minute';
    this.emitSnapshot();
  }
}

module.exports = { UploadQueue, backoffSeconds, clampConcurrency, DEFAULT_CONCURRENCY, MAX_ATTEMPTS };

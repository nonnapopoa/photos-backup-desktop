'use strict';

// Diagnostic event log and report. The desktop counterpart of upstream 0.3.6's
// DiagnosticEventLog.swift / DiagnosticReport.swift (g8row/PhotosBackup):
// every backup decision leaves a plain-language event, repeats fold, routine
// entries are dropped before warnings and errors, and a report can be copied
// to the clipboard for support. Everything that could identify a user —
// tokens, addresses, URLs, paths, media filenames — is redacted on the way in.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

// --- Redaction (DiagnosticRedactor.swift) ---------------------------------

const REDACTIONS = [
  [/\b(authorization|bearer|oauth_token|access_token|master_token|token|cookie)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2<redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>'],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<email>'],
  [/\bhttps?:\/\/[^\s]+/gi, '<url>'],
  // Media filenames can carry a person's name, a place or a date.
  [/[^\s/\\:"'<>]+\.(?:heic|heif|jpe?g|png|gif|tiff?|dng|raw|webp|avif|bmp|mov|mp4|m4v|3gp|avi|mkv|webm|mts|m2ts|mpg|mpeg|hevc)\b/gi, '<filename>'],
  // Absolute paths, POSIX or Windows — queue reasons quote them.
  [/(?:\/[A-Za-z0-9._-]+)+\/[^\s"']*/g, '<path>'],
  [/\b[A-Za-z]:\\[^\s"']*/g, '<path>'],
];

function redact(value, limit = 1000) {
  if (typeof value !== 'string') return value;
  let result = value.slice(0, limit);
  for (const [pattern, replacement] of REDACTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// --- Event log (DiagnosticEventLog.swift) ----------------------------------

const DEFAULT_LIMIT = 400;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const WRITE_DEBOUNCE_MS = 50;

function eventsPath() {
  try {
    return app && typeof app.getPath === 'function'
      ? path.join(app.getPath('userData'), 'diagnostic-events-v1.json')
      : null;
  } catch {
    return null; // no userData yet — the log stays in memory
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

class DiagnosticEventLog {
  // `file` is injectable so tests run without Electron; production resolves
  // it lazily under userData on first use.
  constructor({ file = null, limit = DEFAULT_LIMIT, maxAgeMs = MAX_AGE_MS } = {}) {
    this.file = file;
    this.limit = Math.max(1, limit);
    this.maxAgeMs = maxAgeMs;
    this.events = [];
    this.writeTimer = null;
    this.pendingWrite = false;
    this.load();
  }

  load() {
    try {
      this.events = JSON.parse(fs.readFileSync(this.filePath(), 'utf8'));
      if (!Array.isArray(this.events)) this.events = [];
    } catch {
      this.events = [];
    }
    this.trim(Date.now());
  }

  filePath() {
    if (this.file) return this.file;
    const resolved = eventsPath();
    return resolved || null; // not cached: userData can become available later
  }

  record(category, message, level = 'info') {
    category = String(redact(category, 80));
    message = String(redact(message, 500));
    const now = Date.now();
    const last = this.events[this.events.length - 1];
    if (last && last.level === level && last.category === category && last.message === message) {
      last.firstDate = last.firstDate || last.date;
      last.repeatCount = (last.repeatCount || 1) + 1;
      last.date = now;
    } else {
      this.events.push({ date: now, level, category, message });
      this.trim(now);
    }
    this.pendingWrite = true;
    // Prompt but off the hot path: diagnostics must never block or change
    // backup behavior. flush() makes the write synchronous before quitting.
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => {
        this.writeTimer = null;
        this.writeIfPending();
      }, WRITE_DEBOUNCE_MS);
      this.writeTimer.unref?.();
    }
  }

  flush() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.writeIfPending();
  }

  writeIfPending() {
    if (!this.pendingWrite) return;
    this.pendingWrite = false;
    const file = this.filePath();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, this.events);
    } catch { /* diagnostics must never throw into the caller */ }
  }

  snapshot() {
    return this.events.map((event) => ({ ...event }));
  }

  clear() {
    this.events = [];
    this.pendingWrite = false;
    const file = this.filePath();
    if (file) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
  }

  // Two rules keep the log useful at a fixed size (upstream trimLocked):
  // nothing older than maxAge survives, and when over the limit routine info
  // entries go first — a long healthy backup cannot push out the one failure
  // that explains a report.
  trim(now) {
    const cutoff = now - this.maxAgeMs;
    this.events = this.events.filter((event) => event.date >= cutoff);
    if (this.events.length <= this.limit) return;
    let excess = this.events.length - this.limit;
    const kept = [];
    for (const event of this.events) {
      if (excess > 0 && event.level === 'info') { excess -= 1; continue; }
      kept.push(event);
    }
    if (excess > 0) kept.splice(0, excess);
    this.events = kept;
  }
}

let sharedLog = null;

// The process-wide log. Construction defers the userData lookup until an
// event is actually recorded, so requiring this module stays side-effect-free.
function eventLog() {
  if (!sharedLog) sharedLog = new DiagnosticEventLog();
  return sharedLog;
}

// --- Report (DiagnosticReport.swift, desktop sections only) ----------------

function formatBytes(n) {
  if (!Number.isFinite(n)) return 'unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function describeInterval(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function iso(millis) {
  return new Date(millis).toISOString();
}

function eventLine(event) {
  let text = `${iso(event.date)} [${String(event.level).toUpperCase()}] [${event.category}] ${event.message}`;
  const occurrences = event.repeatCount || 1;
  if (occurrences > 1) {
    text += ` (×${occurrences}${event.firstDate ? ` since ${iso(event.firstDate)}` : ''})`;
  }
  return text;
}

function diskFreeBytes(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

// The conditions most likely to explain "backup is not happening", in the
// order a user can act on them (upstream findings()).
function collectFindings({ queue, settings, freeBytes, now = Date.now() }) {
  const notes = [];
  const info = queue ? queue.diagnosticInfo() : null;
  if (info) {
    if (info.halted) {
      notes.push(`The queue is stopped: ${info.halted}`);
    } else if (info.paused) {
      notes.push('Uploads are paused; press Resume to continue.');
    }
    if (info.cooldownRemainingMs > 0) {
      notes.push(`Google's rate limit is cooling down for about ${Math.ceil(info.cooldownRemainingMs / 1000)}s more.`);
    }
    if (info.counts.failed > 0) {
      notes.push(`${info.counts.failed} file${info.counts.failed === 1 ? '' : 's'} failed; the reasons are listed under Upload Queue.`);
    }
    if (info.crashGuardSkipped > 0) {
      notes.push(`${info.crashGuardSkipped} file${info.crashGuardSkipped === 1 ? ' was' : 's were'} skipped because the app closed unexpectedly while preparing ${info.crashGuardSkipped === 1 ? 'it' : 'them'} more than once.`);
    }
  }
  if (freeBytes != null && freeBytes < 2_000_000_000) {
    notes.push(`Less than 2 GB of storage is free (${formatBytes(freeBytes)}).`);
  }
  if (!notes.length) notes.push('Nothing unusual was detected.');
  return notes.map((note) => redact(note));
}

function buildReport({ version, queue, settings, log, now = Date.now() } = {}) {
  const events = log.snapshot();
  const userDataDir = (() => { try { return app.getPath('userData'); } catch { return os.tmpdir(); } })();
  const freeBytes = diskFreeBytes(userDataDir);
  const findings = collectFindings({ queue, settings, freeBytes, now });
  const info = queue ? queue.diagnosticInfo() : null;
  const profile = require('./gpmc').GPMCClient.commitProfile(
    !!settings?.get?.('useQuota'), !!settings?.get?.('storageSaver'));

  const lines = [];
  const section = (title) => lines.push('', `## ${title}`);
  const field = (name, value) => lines.push(`${name}: ${value === undefined || value === null || value === '' ? 'unavailable' : value}`);

  lines.push('Photos Backup diagnostic report');
  lines.push(`Generated: ${iso(now)}`);
  lines.push('Privacy: credentials, account addresses, filenames, and request URLs are excluded or redacted.');

  section('What stands out');
  for (const finding of findings) lines.push(`- ${finding}`);

  section('App and device');
  field('App version', version);
  field('Platform', `${process.platform} ${process.arch}`);
  field('Electron', process.versions.electron);
  field('Node', process.versions.node);
  field('Chromium', process.versions.chrome);
  field('System uptime', describeInterval(os.uptime() * 1000));
  field('Locale', process.env.LANG || os.locale?.() || 'unavailable');
  field('Time zone GMT offset seconds', -new Date(now).getTimezoneOffset() * 60);
  field('Volume available', freeBytes == null ? 'unavailable' : formatBytes(freeBytes));

  section('Configuration');
  field('Account state', info ? 'connected' : 'disconnected');
  if (info) field('Account', redact(queue.email));
  field('Folder count', (settings?.get?.('folders') || []).length);
  field('Back up automatically', settings?.get?.('autoStart'));
  field('Simultaneous uploads', settings?.get?.('concurrency'));
  field('Storage Saver', settings?.get?.('storageSaver'));
  field('Count against quota', settings?.get?.('useQuota'));
  field('Commit profile', `device ${profile.model}, quality code ${profile.quality} (${settings?.get?.('storageSaver') ? 'Storage Saver' : 'original'})`);

  if (info) {
    section('Upload queue');
    const counts = info.counts;
    field('Rows', counts.total);
    field('State counts', ['waiting', 'active', 'uploaded', 'alreadyBackedUp', 'failed', 'cancelled']
      .filter((key) => counts[key] > 0).map((key) => `${key}=${counts[key]}`).join(', ') || 'empty');
    field('Unfinished', counts.waiting + counts.active);
    field('Maximum concurrency', info.maxConcurrent);
    field('User paused', !!info.paused);
    field('Halt reason', info.halted ? redact(info.halted) : null);
    field('Files skipped after the app stopped', info.crashGuardSkipped);
    field('Completed source records', info.completedCount);
    for (const failure of info.recentFailures.slice().reverse()) {
      lines.push(`- ${iso(failure.date)}; code=${failure.statusCode ?? 'none'}; reason=${redact(failure.reason)}`);
    }
  }

  section(`Event timeline (oldest first)`);
  const warnings = events.filter((event) => event.level === 'warning').length;
  const errors = events.filter((event) => event.level === 'error').length;
  field('Entries', `${events.length} (${errors} errors, ${warnings} warnings); at most ${DEFAULT_LIMIT}, from the last 14 days, with routine entries dropped first`);
  for (const event of events) lines.push(eventLine(event));

  lines.push('', 'End of report');
  return { text: lines.join('\n'), findings };
}

module.exports = {
  redact,
  DiagnosticEventLog,
  eventLog,
  buildReport,
  collectFindings,
  DEFAULT_LIMIT,
  MAX_AGE_MS,
};

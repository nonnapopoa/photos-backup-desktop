'use strict';

// Diagnostics tests: redaction, event folding, trim policy, and the report.
// Run with: node test/diagnostics-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redact, DiagnosticEventLog, buildReport, collectFindings } = require('../src/main/diagnostics');

function tempFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pbdiag-')), name);
}

function fakeSettings(data = {}) {
  return { get: (key) => data[key] };
}

async function main() {
  // 1. Redaction (upstream DiagnosticRedactor).
  assert.strictEqual(redact('Token=abc123 secret'), 'Token=<redacted> secret');
  assert.strictEqual(redact('Bearer ya29.a0ARrdaM...'), 'Bearer <redacted>');
  assert.strictEqual(redact('mail me at someone@example.com please'), 'mail me at <email> please');
  assert.strictEqual(redact('see https://photos.google.com/x for more'), 'see <url> for more');
  assert.strictEqual(redact('failed: /Users/zeeshan/Photos/IMG_0001.jpg'), 'failed: <path>');
  assert.strictEqual(redact('failed: IMG_0001.jpg twice'), 'failed: <filename> twice');
  assert.strictEqual(redact('C:\\Users\\zeeshan\\Pictures\\vacation.mov'), '<path>');
  console.log('test 1 OK: tokens, emails, urls, paths, and media filenames are redacted');

  // 2. Consecutive identical events fold into one entry with a count; a
  // different message starts a new entry (upstream record()).
  {
    const log = new DiagnosticEventLog({ file: tempFile('events.json'), limit: 10 });
    log.record('upload', 'Will retry an upload after a temporary failure', 'warning');
    log.record('upload', 'Will retry an upload after a temporary failure', 'warning');
    log.record('upload', 'Will retry an upload after a temporary failure', 'warning');
    log.record('upload', 'A different thing happened', 'warning');
    const events = log.snapshot();
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].repeatCount, 3);
    assert.ok(events[0].firstDate <= events[0].date);
    assert.strictEqual(events[1].repeatCount, undefined);
    console.log('test 2 OK: repeats fold into one entry with a count');
  }

  // 3. Trim policy: when over the limit, routine info entries go before
  // warnings and errors (upstream trimLocked).
  {
    const log = new DiagnosticEventLog({ file: tempFile('events.json'), limit: 4, maxAgeMs: 60_000 });
    log.record('queue', 'info one');
    log.record('queue', 'warning one', 'warning');
    log.record('queue', 'info two');
    log.record('queue', 'info three');
    log.record('queue', 'error one', 'error');
    log.record('queue', 'info four');
    const levels = log.snapshot().map((event) => event.level);
    assert.ok(levels.includes('warning'), 'the warning survives');
    assert.ok(levels.includes('error'), 'the error survives');
    assert.strictEqual(levels.filter((level) => level === 'info').length, 2, 'only the newest info survives');
    assert.strictEqual(levels.length, 4, 'capped at the limit');
    console.log('test 3 OK: routine entries are dropped before warnings and errors');
  }

  // 4. Nothing older than maxAge survives a reload.
  {
    const file = tempFile('events.json');
    const log = new DiagnosticEventLog({ file, limit: 10, maxAgeMs: 1000 });
    log.record('queue', 'old event');
    log.flush();
    const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
    stale[0].date = Date.now() - 60_000; // simulate an entry from two months of maxAge ago
    fs.writeFileSync(file, JSON.stringify(stale));
    const reloaded = new DiagnosticEventLog({ file, limit: 10, maxAgeMs: 1000 });
    assert.strictEqual(reloaded.snapshot().length, 0, 'expired entries are dropped');
    console.log('test 4 OK: entries older than the maximum age are dropped');
  }

  // 5. Writes are debounced but flush() persists synchronously (upstream's
  // flush-before-suspension).
  {
    const file = tempFile('events.json');
    const log = new DiagnosticEventLog({ file, limit: 10 });
    log.record('queue', 'important');
    assert.throws(() => fs.readFileSync(file, 'utf8'), 'debounced write has not happened yet');
    log.flush();
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].message, 'important');
    console.log('test 5 OK: flush() writes synchronously');
  }

  // 6. Findings name the act-on-able conditions (upstream findings()).
  {
    const findings = collectFindings({
      queue: {
        diagnosticInfo: () => ({
          counts: { total: 5, waiting: 1, active: 0, uploaded: 3, alreadyBackedUp: 0, failed: 1, cancelled: 0 },
          halted: 'The Google account is out of storage.',
          paused: false,
          cooldownRemainingMs: 0,
          crashGuardSkipped: 2,
        }),
      },
      settings: fakeSettings(),
      freeBytes: 10 * 1024 ** 3,
    });
    assert.ok(findings.some((finding) => finding.includes('queue is stopped')));
    assert.ok(findings.some((finding) => finding.includes('1 file failed')));
    assert.ok(findings.some((finding) => finding.includes('2 files were skipped')));
    console.log('test 6 OK: findings surface halts, failures, and crash-guard skips');
  }

  // 7. The report: sections, redaction on the way in, and the commit profile
  // from the single source of truth.
  {
    const log = new DiagnosticEventLog({ file: tempFile('events.json'), limit: 10 });
    log.record('account', 'Connected as someone@example.com');
    log.record('upload', 'An upload failed: /tmp/x/IMG_0042.jpg unreadable', 'error');
    const queue = {
      email: 'someone@example.com',
      diagnosticInfo: () => ({
        counts: { total: 1, waiting: 0, active: 0, uploaded: 0, alreadyBackedUp: 0, failed: 1, cancelled: 0 },
        halted: null, paused: false, cooldownRemainingMs: 0, maxConcurrent: 2,
        crashGuardSkipped: 0, completedCount: 0,
        recentFailures: [{ date: Date.now(), reason: 'bad thing', statusCode: 8 }],
      }),
    };
    const { text } = buildReport({
      version: '0.2.0-test',
      queue,
      settings: fakeSettings({ storageSaver: false, useQuota: false, concurrency: 2, folders: ['/a', '/b'] }),
      log,
    });
    assert.ok(text.includes('## What stands out'));
    assert.ok(text.includes('## App and device'));
    assert.ok(text.includes('## Configuration'));
    assert.ok(text.includes('## Upload queue'));
    assert.ok(text.includes('## Event timeline'));
    assert.ok(text.includes('device Pixel XL, quality code 3 (original)'));
    assert.ok(!text.includes('someone@example.com'), 'emails are redacted everywhere');
    assert.ok(!text.includes('IMG_0042.jpg'), 'filenames are redacted everywhere');
    assert.ok(!text.includes('/tmp/x'), 'paths are redacted everywhere');
    assert.ok(text.includes('End of report'));
    console.log('test 7 OK: the report has the desktop sections and is fully redacted');
  }
}

main().then(
  () => { console.log('diagnostics tests passed'); process.exit(0); },
  (error) => { console.error(error); process.exit(1); },
);

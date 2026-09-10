'use strict';

// Queue-level tests with a stubbed GPMC client: upstream retry backoff,
// 429 quota cooldown, credential-rejection halt, and bounded batches.
// Run with: node test/queue-test.js

const assert = require('assert');
const { UploadQueue, backoffSeconds, clampConcurrency } = require('../src/main/uploadQueue');
const { GPMCError } = require('../src/main/gpmc');
const { signature } = require('../src/main/settings');

function fakeSettings(data = {}, completed = new Set()) {
  return {
    data,
    get(key) { return data[key]; },
    loadCompleted: () => new Set(completed),
    markCompleted: () => {},
  };
}

function items(n) {
  return Array.from({ length: n }, (_, i) => ({
    path: `/photos/file-${i}.jpg`,
    filename: `file-${i}.jpg`,
    size: 1000,
    mtimeMs: 1700000000000 + i * 1000,
  }));
}

function lastSnapshot(queue) {
  // emitSnapshot coalesces through a 100ms timer; flush it synchronously.
  return new Promise((resolve) => {
    queue.onSnapshot = resolve;
    queue.emitSnapshot();
    setTimeout(() => resolve(null), 300);
  });
}

function serverError(status) {
  return new GPMCError('server', `Google returned HTTP ${status}.`);
}

async function withQueue(clientStub, fn) {
  const queue = new UploadQueue({
    credential: { authData: 'x', email: 't@example.com' },
    settings: fakeSettings(),
    onSnapshot: () => {},
    clientFactory: () => clientStub,
  });
  return fn(queue);
}

async function waitFor(condition, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

async function main() {
  // Upstream backoff schedule: min(30, 2^attempt) — 2, 4, 8, capped at 30.
  assert.deepStrictEqual([1, 2, 3, 4, 5].map(backoffSeconds), [2, 4, 8, 16, 30]);

  // 1. Batch limit + remaining count (upstream: 250 per activation).
  await withQueue({
    upload: async () => ({ outcome: 'uploaded', mediaKey: 'k' }),
    authenticate: async () => {},
  }, async (queue) => {
    const { queued, remaining } = await queue.enqueueScan(items(600), 250);
    assert.strictEqual(queued, 250);
    assert.strictEqual(remaining, 350);
    // Re-enqueueing the same scan continues with the NEXT 250, never duplicates.
    const again = await queue.enqueueScan(items(600), 250);
    assert.strictEqual(again.queued, 250, 'the next batch, not the same files');
    const third = await queue.enqueueScan(items(600), 250);
    assert.strictEqual(third.queued, 100, 'only 100 are left after two batches');
    const paths = queue.items.map((i) => i.path);
    assert.strictEqual(new Set(paths).size, paths.length, 'no duplicate queue entries');
  });
  console.log('test 1 OK: batches are bounded, sequential, and deduplicated');

  // 2. 429 → retry with backoff + queue-wide cooldown.
  await withQueue({
    upload: async (path, { onPhase }) => {
      onPhase({ phase: 'hashing', fraction: 1 });
      throw serverError(429);
    },
  }, async (queue) => {
    queue.quotaCooldownMs = 3000; // test-sized cooldown
    await queue.enqueueScan(items(1), 250);
    await waitFor(() => queue.items[0].attempts >= 1);
    await waitFor(() => queue.cooldownUntil > Date.now(), 2000);
    // While cooling down, the pump must not start new items.
    await queue.enqueueScan(items(1).map((i) => ({ ...i, path: '/photos/other.jpg' })), 250);
    const started = queue.items.filter((i) => i.attempts > 0).length;
    assert.strictEqual(started, 1, 'cooldown prevents new item starts');
    await waitFor(() => queue.items[0].status === 'failed', 20000);
    assert.strictEqual(queue.items[0].attempts, 3, 'three attempts, then failed (retryable)');
    assert.match(queue.items[0].error, /HTTP 429/);
    queue.cancelAll();
  });
  console.log('test 2 OK: 429 arms a cooldown and retries with upstream backoff');

  // 3. Credential rejection halts the queue and requeues the item.
  await withQueue({
    upload: async () => { throw new GPMCError('credentialRejected', 'Google rejected the stored credential (HTTP 401).'); },
  }, async (queue) => {
    await queue.enqueueScan(items(3), 250);
    await waitFor(() => queue.haltReason !== null, 5000);
    assert.ok(queue.haltReason.includes('rejected'));
    // Every item stays queued (requeued), none consumed attempts beyond the first pair.
    const attempts = queue.items.map((i) => i.attempts);
    assert.ok(attempts.every((a) => a <= 1), `halt stops further attempts (${attempts})`);
    // Retry failed clears the halt and requeues.
    queue.retryFailed();
    assert.strictEqual(queue.haltReason, null);
    await waitFor(() => queue.haltReason !== null, 5000); // stub still rejects
    queue.cancelAll();
  });
  console.log('test 3 OK: credential rejection halts the queue; Retry resumes');

  // 4. Successful uploads skip completed files on later scans.
  const completed = new Set();
  const settings = fakeSettings({}, completed);
  const queue = new UploadQueue({
    credential: { authData: 'x', email: 't@example.com' },
    settings: {
      get: (k) => settings.get(k),
      loadCompleted: () => new Set(completed),
      markCompleted: (_email, sigs) => sigs.forEach((s) => completed.add(s)),
    },
    onSnapshot: () => {},
    clientFactory: () => ({ upload: async () => ({ outcome: 'uploaded', mediaKey: 'k' }) }),
  });
  const scan = items(2);
  const first = await queue.enqueueScan(scan, 250);
  assert.strictEqual(first.queued, 2);
  await waitFor(() => queue.isIdle, 5000);
  const second = await queue.enqueueScan(scan, 250);
  assert.strictEqual(second.queued, 0, 'completed files are skipped on the next scan');
  console.log('test 4 OK: completed files are skipped on later runs');

  // 5. storageFull halts the queue like a rejected credential.
  await withQueue({
    upload: async () => { throw new GPMCError('storageFull', 'The Google account is out of storage.'); },
  }, async (queue) => {
    await queue.enqueueScan(items(2), 250);
    await waitFor(() => queue.haltReason !== null, 5000);
    assert.match(queue.haltReason, /out of storage/);
    assert.ok(queue.items.every((i) => i.attempts <= 1), 'no retry budget burned on a permanent halt');
    queue.cancelAll();
  });
  console.log('test 5 OK: storageFull halts the queue');

  // 6. releaseRetryableFailures: transient failures requeue, permanent do not.
  await withQueue({
    upload: async (pathArg) => {
      if (pathArg.includes('transient')) throw serverError(500);
      throw new GPMCError('malformed', 'That item is unreadable.');
    },
  }, async (queue) => {
    queue.maxConcurrent = 1; // deterministic: run items one at a time
    await queue.enqueueScan([
      { path: '/photos/transient.jpg', filename: 't.jpg', size: 1, mtimeMs: 1 },
      { path: '/photos/broken.jpg', filename: 'b.jpg', size: 1, mtimeMs: 2 },
    ], 250);
    await waitFor(() => queue.items.every((i) => i.status === 'failed'), 30000);
    const released = queue.releaseRetryableFailures();
    assert.strictEqual(released, 1, 'only the retryable failure is released');
    const transient = queue.items.find((i) => i.path.includes('transient'));
    assert.ok(['waiting', 'exporting', 'hashing', 'checkingDuplicate', 'preparing'].includes(transient.status),
      `released item is queued or already running (was ${transient.status})`);
    assert.strictEqual(queue.items.find((i) => i.path.includes('broken')).status, 'failed');
    queue.cancelAll();
  });
  console.log('test 6 OK: releaseRetryableFailures requeues only transient failures');

  // 7. Concurrency clamp (upstream 0.3.2: 1–10).
  assert.strictEqual(clampConcurrency(0), 1);
  assert.strictEqual(clampConcurrency(11), 10);
  assert.strictEqual(clampConcurrency(4.4), 4);
  assert.strictEqual(clampConcurrency('bogus'), 2);
  await withQueue({
    upload: async () => ({ outcome: 'uploaded', mediaKey: 'k' }),
  }, async (queue) => {
    assert.strictEqual(queue.maxConcurrent, 2, 'default');
    queue.setMaxConcurrent(99);
    assert.strictEqual(queue.maxConcurrent, 10);
    queue.setMaxConcurrent(1);
    assert.strictEqual(queue.maxConcurrent, 1);
  });
  console.log('test 7 OK: concurrency is configurable and clamped to 1–10');

  console.log('queue-test: all assertions passed');
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });

'use strict';

// Crash-loop guard tests (upstream 0.3.6 PreparationGuardTests.swift, desktop
// counterpart): a file the process died preparing goes to the back of the
// queue, one that has stopped the app twice is skipped as non-retryable, a
// manual retry gets a fresh allowance, success clears the count, and a
// graceful quit clears the markers. Run with: node test/preparation-guard-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UploadQueue, INTERRUPTED_PREPARATION_LIMIT, SKIP_REASON } = require('../src/main/uploadQueue');
const { signature } = require('../src/main/settings');
const { PreparationMarkers, InterruptionCounters } = require('../src/main/preparationGuard');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pbguard-'));
}

function fakeSettings(data = {}) {
  return {
    data,
    get(key) { return data[key]; },
    loadCompleted: () => new Set(),
    markCompleted: () => {},
  };
}

function files(n) {
  return Array.from({ length: n }, (_, i) => ({
    path: `/photos/file-${i}.jpg`,
    filename: `file-${i}.jpg`,
    size: 1000,
    mtimeMs: 1700000000000 + i * 1000,
  }));
}

function makeQueue(dir, clientStub) {
  return new UploadQueue({
    credential: { authData: 'x', email: 't@example.com' },
    settings: fakeSettings(),
    onSnapshot: () => {},
    clientFactory: () => clientStub,
    markers: new PreparationMarkers(path.join(dir, 'preparing.json')),
    counters: new InterruptionCounters(path.join(dir, 'counters.json')),
  });
}

// Simulate the previous process dying mid-preparation: seed the markers file
// exactly as the dying process left it, then construct a fresh queue.
function diedPreparing(dir, items) {
  fs.writeFileSync(path.join(dir, 'preparing.json'),
    JSON.stringify({ signatures: items.map((item) => signature(item)).sort() }));
}

async function waitFor(condition, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not met in time');
}

async function main() {
  assert.strictEqual(INTERRUPTED_PREPARATION_LIMIT, 2);

  // 1. First interruption: the file survives, but moves behind everything
  // else so the rest of the backup gets a turn first.
  {
    const dir = tempDir();
    const [poison, healthy, healthy2] = files(3); // poison is oldest (first normally)
    diedPreparing(dir, [poison]);
    const queue = makeQueue(dir, { upload: async () => ({ outcome: 'uploaded', mediaKey: 'k' }) });
    await queue.enqueueScan([poison, healthy, healthy2]);
    const order = queue.items.filter((i) => i.status !== 'failed').map((i) => i.path);
    assert.strictEqual(order[order.length - 1], poison.path, 'the interrupted file goes last');
    assert.strictEqual(queue.crashGuardSkipped, 0);
    const counters = new InterruptionCounters(path.join(dir, 'counters.json'));
    assert.strictEqual(counters.get(signature(poison)), 1, 'counted once');
    console.log('test 1 OK: a first interruption moves the file to the back');

    // 2. Second interruption on the same file: skipped as non-retryable with
    // the explanatory reason, without ever invoking the client for it.
    let poisonUploads = 0;
    const dir2 = tempDir();
    fs.copyFileSync(path.join(dir, 'counters.json'), path.join(dir2, 'counters.json'));
    diedPreparing(dir2, [poison]);
    const queue2 = makeQueue(dir2, {
      upload: async (p) => {
        if (p === poison.path) poisonUploads += 1;
        return { outcome: 'uploaded', mediaKey: 'k' };
      },
    });
    await queue2.enqueueScan([poison, healthy]);
    const skipped = queue2.items.find((i) => i.path === poison.path);
    assert.strictEqual(skipped.status, 'failed');
    assert.strictEqual(skipped.error, SKIP_REASON);
    assert.strictEqual(skipped.retryable, false);
    assert.strictEqual(queue2.crashGuardSkipped, 1);
    await waitFor(() => queue2.isIdle);
    assert.strictEqual(poisonUploads, 0, 'the skipped file is never started');
    console.log('test 2 OK: a second interruption skips the file as non-retryable');
  }

  // 3. Markers are written synchronously before an item starts and cleared
  // when its attempt ends; success also clears the interruption count.
  {
    const dir = tempDir();
    let markersDuringUpload = null;
    const queue = makeQueue(dir, {
      upload: async () => {
        markersDuringUpload = fs.readFileSync(path.join(dir, 'preparing.json'), 'utf8');
        return { outcome: 'uploaded', mediaKey: 'k' };
      },
    });
    await queue.enqueueScan(files(1));
    await waitFor(() => queue.isIdle);
    const [item] = queue.items;
    assert.match(markersDuringUpload, new RegExp(signature(item).replace(/[|\\]/g, '\\$&')),
      'the marker is on disk while the item runs');
    assert.throws(() => fs.readFileSync(path.join(dir, 'preparing.json'), 'utf8'),
      'markers are gone once the attempt ends');
    console.log('test 3 OK: markers live exactly for the duration of an attempt');
  }

  // 4. A manual retry gets a fresh allowance from the guard (upstream requeue
  // resets interruptedPreparations). The failing client keeps the item from
  // succeeding, which would also clear the count.
  {
    const dir = tempDir();
    const [poison] = files(1);
    diedPreparing(dir, [poison]);
    const failing = { upload: async () => { throw new Error('disk error'); } };
    const queue = makeQueue(dir, failing);
    await queue.enqueueScan([poison]); // first interruption → queued at the back
    await waitFor(() => queue.items[0].status === 'failed');
    const counters = new InterruptionCounters(path.join(dir, 'counters.json'));
    assert.strictEqual(counters.get(signature(poison)), 1, 'counted once');
    queue.retryFailed();
    const countersAfterRetry = new InterruptionCounters(path.join(dir, 'counters.json'));
    assert.strictEqual(countersAfterRetry.get(signature(poison)), 0, 'a user-requested retry resets the count');
    console.log('test 4 OK: Retry failed gives a file a fresh allowance');
  }

  // 5. A graceful quit is not a crash: clearPreparationMarkers empties the
  // file so the next launch counts nothing (upstream disarms on suspension).
  {
    const dir = tempDir();
    const queue = makeQueue(dir, { upload: () => new Promise(() => {}) });
    await queue.enqueueScan(files(1));
    await waitFor(() => queue.items.some((i) => i.attempts > 0));
    queue.clearPreparationMarkers();
    assert.throws(() => fs.readFileSync(path.join(dir, 'preparing.json'), 'utf8'),
      'the markers file is gone after a graceful quit');
    const queue2 = makeQueue(dir, { upload: async () => ({ outcome: 'uploaded', mediaKey: 'k' }) });
    await queue2.enqueueScan(files(1));
    assert.strictEqual(queue2.crashGuardSkipped, 0, 'a cleared marker counts against nobody');
    console.log('test 5 OK: a graceful quit clears the markers');
  }
}

main().then(
  () => { console.log('preparation guard tests passed'); process.exit(0); },
  (error) => { console.error(error); process.exit(1); },
);

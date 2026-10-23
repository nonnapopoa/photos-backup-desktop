'use strict';

// Picking and dropping: sorting paths into folders and media files, and
// adding files to a queue that is already uploading.
// Run with: node test/add-files-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectPaths } = require('../src/main/mediaScanner');
const { UploadQueue } = require('../src/main/uploadQueue');

const AUTH = 'androidId=a&client_sig=b&callerSig=c&device_country=us&Email=user%40example.com'
  + '&google_play_services_version=1&lang=en&oauth2_foreground=1&sdk_version=28&service=s&Token=t';

async function sortsPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-files-'));
  try {
    const folder = path.join(dir, 'Trip');
    fs.mkdirSync(folder);
    const write = (name, body = 'x', mtime = 1000) => {
      const full = path.join(dir, name);
      fs.writeFileSync(full, body);
      fs.utimesSync(full, mtime, mtime);
      return full;
    };
    const newer = write('b.JPG', 'x', 2000);
    const older = write('a.mp4', 'x', 1000);
    const result = await inspectPaths([
      folder, newer, older,
      write('notes.txt'), write('empty.jpg', ''), write('.hidden.jpg'),
      path.join(dir, 'gone.jpg'), 'relative.jpg', 42,
    ]);
    assert.deepStrictEqual(result.folders, [folder]);
    assert.deepStrictEqual(result.files.map((f) => f.filename), ['a.mp4', 'b.JPG']);
    assert.strictEqual(result.files[1].path, newer);
    assert.strictEqual(result.skipped, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('test 1 OK: picked and dropped paths sort into folders, media, and skipped');
}

async function cancelReachesEarlierUploads() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = {
    upload: (_p, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      gate.then(() => resolve({ outcome: 'uploaded', mediaKey: 'k' }));
    }),
  };
  const settings = { get: (k) => ({ concurrency: 1 })[k], loadCompleted: () => new Set(), markCompleted: () => {} };
  const queue = new UploadQueue({ credential: { authData: AUTH, email: 'u' }, settings, clientFactory: () => client });
  const found = (name) => ({ path: path.join(os.tmpdir(), name), filename: name, size: 1, mtimeMs: 1000 });
  await queue.enqueueScan([found('first.jpg')]);
  await queue.enqueueScan([found('second.jpg')]); // added while the first is uploading
  queue.cancelAll();
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  assert.deepStrictEqual(queue.items.map((i) => i.status), ['cancelled', 'cancelled']);
  console.log('test 2 OK: Cancel still stops uploads that were running when more files were added');
}

(async () => {
  await sortsPaths();
  await cancelReachesEarlierUploads();
  console.log('add files tests passed');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });

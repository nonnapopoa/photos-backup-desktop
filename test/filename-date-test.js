'use strict';

// Capture dates from filenames: the patterns ported from gotohp, the
// fallback to the modification time, and the date reaching the commit RPC.
// Run with: node test/filename-date-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dateFromFilename, captureDate } = require('../src/main/filenameDate');
const { GPMCClient } = require('../src/main/gpmc');
const { UploadQueue } = require('../src/main/uploadQueue');
const { fields, numberAt, bytesField, stringField } = require('../src/main/proto');

const AUTH = 'androidId=a&client_sig=b&callerSig=c&device_country=us&Email=user%40example.com'
  + '&google_play_services_version=1&lang=en&oauth2_foreground=1&sdk_version=28&service=s&Token=t';
const NOW = new Date(2026, 9, 23);
const local = (...parts) => new Date(...parts).getTime();
const parsed = (name) => {
  const result = dateFromFilename(name, NOW);
  return result && { at: result.date.getTime(), hasTime: result.hasTime };
};

function patterns() {
  const cases = [
    ['IMG_20240709_182027.jpg', local(2024, 6, 9, 18, 20, 27), true],
    ['PXL_20231123_182518628.jpg', local(2023, 10, 23, 18, 25, 18), true],
    ['20240709-182027.mp4', local(2024, 6, 9, 18, 20, 27), true],
    ['2022-10-24-150226287.mp4', local(2022, 9, 24, 15, 2, 26), true],
    ['Screenshot 2026-02-13 093505.png', local(2026, 1, 13, 9, 35, 5), true],
    ['2023-1-5 party.jpg', local(2023, 0, 5, 12), false],
    ['lv_7324034615860006160_20240617193045.mp4', local(2024, 5, 17, 19, 30, 45), true],
    ['FaceApp_1658848332262.jpg', 1658848332262, true],
    ['VID_20240709.mp4', local(2024, 6, 9, 12), false],
    ['IMG-20261023-WA0001.jpg', local(2026, 9, 23, 12), false],
    ['WA20261023.jpg', local(2026, 9, 23, 12), false],
    // An impossible time (25:60:00) drops to the date alone.
    ['IMG_20230101_256000.jpg', local(2023, 0, 1, 12), false],
    // Only the name is read, never the folders above it.
    [path.join('2019-01-01', 'IMG_20240709_182027.jpg'), local(2024, 6, 9, 18, 20, 27), true],
  ];
  for (const [name, at, hasTime] of cases) {
    assert.deepStrictEqual(parsed(name), { at, hasTime }, name);
  }
  for (const name of [
    'DSC_0042.JPG',             // no date
    'IMG_20230231_101010.jpg',  // 31 February
    'IMG_20231301.jpg',         // month 13
    'scan_19850704.jpg',        // before 1990
    'plan_20300101.jpg',        // more than a year ahead
    'DSC_12345678.jpg',         // eight digits that are not a date
    'photo.jpg',
    '',
  ]) {
    assert.strictEqual(dateFromFilename(name, NOW), null, name);
  }
  console.log('test 1 OK: filename patterns parse, and non-dates are rejected');
}

function fallback() {
  const mtime = local(2025, 2, 1, 8, 15);
  assert.strictEqual(captureDate('IMG_20240709_182027.jpg', mtime, NOW).getTime(), local(2024, 6, 9, 18, 20, 27));
  assert.strictEqual(captureDate('DSC_0042.JPG', mtime, NOW).getTime(), mtime);
  // A day without a time keeps a same-day modification time, else noon.
  const sameDay = local(2024, 6, 9, 7, 45, 3);
  assert.strictEqual(captureDate('VID_20240709.mp4', sameDay, NOW).getTime(), sameDay);
  assert.strictEqual(captureDate('VID_20240709.mp4', mtime, NOW).getTime(), local(2024, 6, 9, 12));
  console.log('test 2 OK: the filename wins, and the modification time fills in');
}

async function reachesCommit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filename-date-'));
  const file = path.join(dir, 'IMG_20240709_182027.jpg');
  fs.writeFileSync(file, 'not really a jpeg');
  const mtime = local(2025, 2, 1, 8, 15);
  fs.utimesSync(file, mtime / 1000, mtime / 1000);

  let commit = null;
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const reply = (body = Buffer.alloc(0), headers = {}) => new Response(body, { status: 200, headers });
    if (url.includes('android.googleapis.com/auth')) return reply('Auth=tok\nExpiry=4070880000\n');
    if (url.endsWith(GPMCClient.HASH_CHECK_METHOD)) return reply();
    if (url.includes('upload_id=')) {
      for await (const _chunk of init.body) { /* drain the streamed file */ }
      return reply(bytesField(2, Buffer.from('token')));
    }
    if (url.startsWith(GPMCClient.UPLOAD_ENDPOINT)) return reply(Buffer.alloc(0), { 'x-guploader-uploadid': 'up-1' });
    if (url.endsWith(GPMCClient.COMMIT_METHOD)) {
      commit = Buffer.from(init.body);
      return reply(bytesField(1, bytesField(3, stringField(1, 'media-key'))));
    }
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const stat = fs.statSync(file);
    const found = { path: file, filename: path.basename(file), size: stat.size, mtimeMs: stat.mtimeMs };
    const settings = (data) => ({
      get: (k) => data[k], loadCompleted: () => new Set(), markCompleted: () => {},
    });
    const commitSeconds = async (data) => {
      commit = null;
      const queue = new UploadQueue({ credential: { authData: AUTH, email: 'u' }, settings: settings(data) });
      await queue.enqueueScan([found]);
      for (let i = 0; i < 500 && !queue.isIdle; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(queue.items[0].status, 'uploaded', queue.items[0].error);
      // Commit field 1 (metadata) -> field 4 (timestamps) -> field 1 (seconds).
      return Number(numberAt(1, fields(fields(commit)[1][0])[4][0]));
    };
    assert.strictEqual(await commitSeconds({ dateFromFilename: true }), local(2024, 6, 9, 18, 20, 27) / 1000);
    assert.strictEqual(await commitSeconds({ dateFromFilename: false }), Math.floor(mtime / 1000));
  } finally {
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('test 3 OK: the commit carries the filename date as UNIX seconds');
}

(async () => {
  patterns();
  fallback();
  await reachesCommit();
  console.log('filename date tests passed');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });

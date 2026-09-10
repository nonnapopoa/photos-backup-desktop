'use strict';

// End-to-end test of the GPMC upload pipeline against a mock Google server.
// Run with: node test/upload-flow-test.js

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GPMCClient } = require('../src/main/gpmc');
const { encodeForm } = require('../src/main/tokenExchange');
const { bytesField, stringField } = require('../src/main/proto');

const AUTH_URL = 'https://android.googleapis.com/auth';
const RPC_BASE = 'https://photosdata-pa.googleapis.com/6439526531001121323/';
const UPLOAD_URL = 'https://photos.googleapis.com/data/upload/uploadmedia/interactive';

async function main() {
  const calls = [];
  let uploadIDCounter = 0;
  const seenUploads = new Map(); // uploadID -> Buffer

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      calls.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (req.url === '/auth') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Auth=mock-token-1\nExpiry=4070880000\n');
        return;
      }
      if (req.url === '/' + GPMCClient.HASH_CHECK_METHOD) {
        if (process.env.MOCK_HASH_HIT === '1') {
          // Mimic "already backed up": media key at [1,2,2,1]
          res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
          res.end(bytesField(1, bytesField(2, bytesField(2, stringField(1, 'existing-media-key')))));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
          res.end(Buffer.alloc(0));
        }
        return;
      }
      if (req.url === UPLOAD_URL.replace('https://photos.googleapis.com', '')) {
        uploadIDCounter += 1;
        res.writeHead(200, { 'x-guploader-uploadid': `upid-${uploadIDCounter}` });
        res.end();
        return;
      }
      if (req.url.startsWith(UPLOAD_URL.replace('https://photos.googleapis.com', '') + '?upload_id=')) {
        seenUploads.set(new URL(req.url, 'http://x').searchParams.get('upload_id'), body);
        // A valid receipt: the opaque upload token lives in field 2.
        const receipt = bytesField(2, Buffer.from('mock-upload-token'));
        res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
        res.end(receipt);
        return;
      }
      if (req.url === '/' + GPMCClient.COMMIT_METHOD) {
        assert.strictEqual(req.headers['x-goog-ext-173412678-bin'], 'CgcIAhClARgC');
        assert.strictEqual(req.headers['x-goog-ext-174067345-bin'], 'CgIIAg==');
        res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
        res.end(bytesField(1, bytesField(3, stringField(1, 'new-media-key'))));
        return;
      }
      res.writeHead(404); res.end('not found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const realFetch = global.fetch;
  global.fetch = (url, options) => {
    let target = String(url)
      .replace(AUTH_URL, base + '/auth')
      .replace(RPC_BASE, base + '/')
      .replace(UPLOAD_URL, base + UPLOAD_URL.replace('https://photos.googleapis.com', ''));
    return realFetch(target, options);
  };

  // 1 MB of deterministic content.
  const tmp = path.join(os.tmpdir(), `pb-test-${Date.now()}.bin`);
  const content = crypto.randomBytes(1024 * 1024);
  fs.writeFileSync(tmp, content);
  const sha1 = crypto.createHash('sha1').update(content).digest();

  const cred = encodeForm([
    ['androidId', '1234567890abcdef'], ['client_sig', 'x'], ['callerSig', 'x'],
    ['device_country', 'us'], ['Email', 'user@gmail.com'],
    ['google_play_services_version', '240913000'], ['lang', 'en_US'],
    ['oauth2_foreground', '1'], ['sdk_version', '33'],
    ['service', 'oauth2:openid x'], ['Token', 'master-token'],
  ]);

  try {
    // Full upload path
    const client = new GPMCClient(cred);
    const phases = [];
    const result = await client.upload(tmp, {
      filename: 'photo.jpg',
      modified: new Date(1700000000000),
      onPhase: (p) => phases.push(p.phase),
      signal: new AbortController().signal,
    });

    assert.strictEqual(result.outcome, 'uploaded');
    assert.strictEqual(result.mediaKey, 'new-media-key');
    assert.deepStrictEqual(phases.filter((p, i, a) => a[i - 1] !== p),
      ['hashing', 'checkingDuplicate', 'preparing', 'sending', 'finalizing']);

    // Auth request shape
    const authCall = calls[0];
    assert.strictEqual(authCall.headers['device'], '1234567890abcdef');
    assert.ok(authCall.body.includes('Email=user%40gmail.com'));

    // Prepare call carried the right hash + size
    const prepareCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/uploadmedia/interactive'));
    assert.strictEqual(prepareCall.headers['x-goog-hash'], `sha1=${sha1.toString('base64')}`);
    assert.strictEqual(prepareCall.headers['x-upload-content-length'], String(content.length));

    // PUT carried the exact bytes
    const putCall = calls.find((c) => c.method === 'PUT');
    assert.deepStrictEqual(putCall.body, content);
    assert.strictEqual(putCall.headers['content-type'], 'application/octet-stream');
    assert.strictEqual(putCall.headers['authorization'], 'Bearer mock-token-1');

    // Bearer + UA on the Photos RPCs and the upload session calls
    const rpcCalls = calls.filter((c) =>
      c.url === '/' + GPMCClient.HASH_CHECK_METHOD
      || c.url === '/' + GPMCClient.COMMIT_METHOD
      || c.url.startsWith('/data/upload/uploadmedia/interactive'));
    assert.strictEqual(rpcCalls.length, 4); // prepare, PUT, hash check, commit
    assert.ok(rpcCalls.every((c) => c.headers['authorization'] === 'Bearer mock-token-1'));
    assert.ok(rpcCalls.every((c) => c.headers['user-agent'].startsWith('com.google.android.apps.photos/')));

    // Duplicate path: server reports the hash already exists
    process.env.MOCK_HASH_HIT = '1';
    const client2 = new GPMCClient(cred);
    const result2 = await client2.upload(tmp, { filename: 'photo.jpg' });
    assert.strictEqual(result2.outcome, 'alreadyBackedUp');
    assert.strictEqual(result2.mediaKey, 'existing-media-key');
    // No prepare/PUT happened for the duplicate
    assert.strictEqual(calls.filter((c) => c.method === 'PUT').length, 1);

    console.log('upload-flow-test: all assertions passed');
    process.exit(0);
  } finally {
    global.fetch = realFetch;
    fs.unlinkSync(tmp);
    server.closeAllConnections();
    server.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });

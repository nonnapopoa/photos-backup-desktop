'use strict';

// Tests for the 0.3.5+ error handling: google.rpc.Status parsing, storageFull,
// receipt validation, and rejectsReceipt. Run with: node test/status-test.js

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GPMCClient, GPMCError, parseGoogleStatus, validateReceipt } = require('../src/main/gpmc');
const { intField, bytesField, stringField, numberAt } = require('../src/main/proto');
const { encodeForm } = require('../src/main/tokenExchange');

const AUTH_URL = 'https://android.googleapis.com/auth';
const RPC_BASE = 'https://photosdata-pa.googleapis.com/6439526531001121323/';

function statusBody(code, message) {
  return Buffer.concat([
    intField(1, BigInt(code)),
    ...(message ? [stringField(2, message)] : []),
  ]);
}

const CRED = encodeForm([
  ['androidId', '1234567890abcdef'], ['client_sig', 'x'], ['callerSig', 'x'],
  ['device_country', 'us'], ['Email', 'user@gmail.com'],
  ['google_play_services_version', '240913000'], ['lang', 'en_US'],
  ['oauth2_foreground', '1'], ['sdk_version', '33'],
  ['service', 'x'], ['Token', 'm'],
]);

function withMock(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const realFetch = global.fetch;
      global.fetch = (url, options) => realFetch(String(url)
        .replace(AUTH_URL, base + '/auth')
        .replace(RPC_BASE, base + '/'), options);
      try {
        await fn();
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        global.fetch = realFetch;
        server.closeAllConnections();
        server.close();
      }
    });
  });
}

async function main() {
  // --- proto.numberAt -------------------------------------------------------
  const msg = Buffer.concat([intField(1, 8), stringField(2, 'resource exhausted')]);
  assert.strictEqual(numberAt(1, msg), 8n);
  assert.strictEqual(numberAt(3, msg), null);
  assert.strictEqual(numberAt(1, stringField(2, 'x')), null, 'field 2 is not a varint field');

  // --- parseGoogleStatus ----------------------------------------------------
  const status = parseGoogleStatus(statusBody(8, 'Resource has been exhausted (e.g. check quota).'));
  assert.strictEqual(status.rawCode, 8);
  assert.strictEqual(status.code, 'resourceExhausted');
  assert.strictEqual(status.message.includes('exhausted'), true);
  assert.strictEqual(parseGoogleStatus(Buffer.alloc(0)), null);
  assert.strictEqual(parseGoogleStatus(statusBody(0, 'ok')), null, 'code 0 is OK, not a failure');
  assert.strictEqual(parseGoogleStatus(Buffer.from('plain text')), null);
  assert.strictEqual(parseGoogleStatus(statusBody(99, '?')).code, null, 'unknown code keeps its number');

  // --- validateReceipt ------------------------------------------------------
  assert.doesNotThrow(() => validateReceipt(bytesField(2, Buffer.from('token'))));
  assert.throws(() => validateReceipt(bytesField(1, Buffer.from('no field 2'))), /invalidUploadReceipt|usable upload receipt/);
  assert.throws(() => validateReceipt(Buffer.alloc(0)), /usable upload receipt/);
  {
    const error = (() => { try { validateReceipt(Buffer.alloc(0)); } catch (e) { return e; } })();
    assert.strictEqual(error.retryable, true, 'invalid receipt is retryable');
  }

  // --- rejectsReceipt -------------------------------------------------------
  const blueprintError = new GPMCError('server', 'Google returned HTTP 400. Google said: ... is not a valid blueprint ...');
  assert.strictEqual(GPMCError.rejectsReceipt(blueprintError), true, 'blueprint wording is the fallback');
  const codeError = new GPMCError('server', 'Google returned HTTP 400.', { rawCode: 3, code: 'invalidArgument', message: null });
  assert.strictEqual(GPMCError.rejectsReceipt(codeError), true, 'INVALID_ARGUMENT is the structural signal');
  const quotaError = new GPMCError('server', 'Google returned HTTP 429.', { rawCode: 8, code: 'resourceExhausted', message: 'quota' });
  assert.strictEqual(GPMCError.rejectsReceipt(quotaError), false);
  assert.strictEqual(GPMCError.rejectsReceipt(new GPMCError('transport', 'offline')), false);

  // --- storageFull via a mocked RPC ---------------------------------------
  await withMock((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/auth') { res.writeHead(200); res.end('Auth=t\nExpiry=4070880000\n'); return; }
      // Hash check answers with RESOURCE_EXHAUSTED + HTTP 409.
      res.writeHead(409, { 'Content-Type': 'application/x-protobuf' });
      res.end(statusBody(8, 'Resource has been exhausted (e.g. check quota).'));
    });
  }, async () => {
    const client = new GPMCClient(CRED);
    const error = await client.validateReadAccess().then(() => null, (e) => e);
    assert.ok(error instanceof GPMCError, 'throws');
    assert.strictEqual(error.kind, 'storageFull', 'code 8 with non-429 maps to storageFull');
    assert.strictEqual(error.retryable, false, 'storage full is not retryable');
    assert.match(error.message, /out of storage/);
    assert.match(error.message, /exhausted/, 'explanation prefers the status message over hex');
  });

  // --- rate-limit 429 stays a retryable server error ----------------------
  await withMock((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/auth') { res.writeHead(200); res.end('Auth=t\nExpiry=4070880000\n'); return; }
      res.writeHead(429, { 'Content-Type': 'application/x-protobuf' });
      res.end(statusBody(8, 'Resource has been exhausted (e.g. check quota).'));
    });
  }, async () => {
    const client = new GPMCClient(CRED);
    const error = await client.validateReadAccess().then(() => null, (e) => e);
    assert.strictEqual(error.kind, 'server');
    assert.strictEqual(error.statusCode, 429);
    assert.strictEqual(error.retryable, true, '429 stays retryable');
    assert.strictEqual(error.status.code, 'resourceExhausted');
  });

  // --- unauthenticated code maps to credentialRejected --------------------
  await withMock((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/auth') { res.writeHead(200); res.end('Auth=t\nExpiry=4070880000\n'); return; }
      res.writeHead(403, { 'Content-Type': 'application/x-protobuf' });
      res.end(statusBody(16, 'Request had invalid authentication credentials.'));
    });
  }, async () => {
    const client = new GPMCClient(CRED);
    const error = await client.validateReadAccess().then(() => null, (e) => e);
    assert.strictEqual(error.kind, 'credentialRejected');
  });

  console.log('status-test: all assertions passed');
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });

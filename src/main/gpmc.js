'use strict';

// Google Photos private-API client. Direct port of GPMC/Core/GPMCClient.swift.
// Uses Node's global fetch (undici); uploads stream from disk with progress.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { intField, bytesField, stringField, fields, stringAt } = require('./proto');

class GPMCError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'GPMCError';
    this.kind = kind; // credentialRejected | tokenBound | transport | server | malformed
    this.statusCode = kind === 'server' ? Number(message.match(/HTTP (\d+)/)?.[1] || 0) : 0;
  }
  get retryable() {
    if (this.kind === 'transport') return true;
    if (this.kind === 'server') return this.statusCode === 408 || this.statusCode === 429 || this.statusCode >= 500;
    return false;
  }
}

const REQUIRED_FIELDS = [
  'androidId', 'client_sig', 'callerSig', 'device_country', 'Email',
  'google_play_services_version', 'lang', 'oauth2_foreground', 'sdk_version', 'service', 'Token',
];

// Parse the stored `&`-joined auth body into a map; throws when a required
// field is missing (that means the credential must be reconnected).
function parseAuthData(text) {
  const parsed = {};
  for (const pair of text.trim().split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const decode = (s) => decodeURIComponent(s.replace(/\+/g, ' '));
    parsed[decode(pair.slice(0, eq))] = decode(pair.slice(eq + 1));
  }
  const missing = REQUIRED_FIELDS.filter((k) => !parsed[k]);
  if (missing.length) {
    throw new GPMCError('credentialRejected', `Missing auth fields: ${missing.join(', ')}`);
  }
  return parsed;
}

// Serialize the map back to the urlencoded body the /auth endpoint expects.
function authDataBody(values) {
  const filtered = {};
  for (const key of Object.keys(values)) {
    if (REQUIRED_FIELDS.includes(key)) filtered[key] = values[key];
  }
  filtered.app = 'com.google.android.apps.photos';
  filtered.callerPkg = 'com.google.android.apps.photos';
  return Object.keys(filtered).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(filtered[k])}`)
    .join('&');
}

// Quote Google's error bodies: printable text as-is, protobuf as a hex prefix.
function explanation(buffer, limit = 240) {
  if (!buffer || !buffer.length) return '';
  const text = buffer.toString('utf8');
  const printable = [...text].every((ch) => ch === '\n' || ch === '\t' || (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f));
  let detail;
  if (printable) {
    detail = text.trim().slice(0, limit);
  } else {
    detail = '0x' + [...buffer.subarray(0, Math.floor(limit / 4))].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return detail ? ` Google said: ${detail}` : '';
}

async function checkedStatus(response) {
  if (response.status === 401 || response.status === 403) {
    throw new GPMCError('credentialRejected',
      `Google rejected the stored credential (HTTP ${response.status}). Connect the account again.`);
  }
  if (!(response.status >= 200 && response.status < 300)) {
    const body = Buffer.from(await response.arrayBuffer());
    throw new GPMCError('server',
      `Google returned HTTP ${response.status}. Check your connection and try again.${explanation(body)}`);
  }
  return response;
}

// Stream a file through SHA-1, reporting progress. Returns {hash, size}.
function hashFile(filePath, onFraction, signal) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stat = fs.statSync(filePath);
    let size = 0;
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    const onAbort = () => stream.destroy(new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk) => {
      if (signal?.aborted) { stream.destroy(new Error('aborted')); return; }
      hash.update(chunk);
      size += chunk.length;
      onFraction?.(Math.min(1, size / Math.max(1, stat.size)));
    });
    stream.on('error', (error) => { signal?.removeEventListener('abort', onAbort); reject(error); });
    stream.on('close', () => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) { reject(new Error('aborted')); return; }
      resolve({ hash: hash.digest(), size, stat });
    });
  });
}

// Upload the file with fetch, streaming from disk and reporting bytes sent.
// undici pulls from the ReadableStream as it writes to the socket, so counting
// pulled chunks is accurate progress. The caller supplies the auth headers.
async function streamUpload(url, filePath, headers, onProgress, signal) {
  const stat = fs.statSync(filePath);
  let sent = 0;
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  signal?.addEventListener('abort', () => stream.destroy(new Error('aborted')), { once: true });
  const body = new ReadableStream({
    pull(controller) {
      return new Promise((resolve) => {
        stream.once('readable', () => {
          const chunk = stream.read();
          if (chunk === null) {
            if (!signal?.aborted) controller.close();
            resolve();
            return;
          }
          sent += chunk.length;
          controller.enqueue(chunk);
          onProgress?.(sent, stat.size);
          resolve();
        });
      });
    },
    cancel() { stream.destroy(); },
  });
  let response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers,
      body,
      duplex: 'half',
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('aborted');
    throw new GPMCError('transport', `Could not reach Google: ${error.message}`);
  }
  return response;
}

class GPMCClient {
  static HASH_CHECK_METHOD = '5084965799730810217';
  static COMMIT_METHOD = '16538846908252377752';
  // Only some photosdata-pa calls carry these; the hash lookup must NOT.
  static EXT_HEADERS = {
    'x-goog-ext-173412678-bin': 'CgcIAhClARgC',
    'x-goog-ext-174067345-bin': 'CgIIAg==',
  };
  static UPLOAD_ENDPOINT = 'https://photos.googleapis.com/data/upload/uploadmedia/interactive';
  static USER_AGENT = 'com.google.android.apps.photos/49029607 (Linux; U; Android 9; en_US; Pixel XL; Build/PQ2A.190205.001; Cronet/127.0.6510.5) (gzip)';

  constructor(authData) {
    this.values = parseAuthData(authData);
    this.token = '';
    this.expiry = 0;
  }

  get accountEmail() { return this.values.Email || ''; }

  async authenticate() {
    let response;
    try {
      response = await fetch('https://android.googleapis.com/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'app': 'com.google.android.apps.photos',
          'device': this.values.androidId,
          'User-Agent': 'GoogleAuth/1.4 (Pixel XL PQ2A.190205.001); gzip',
        },
        body: authDataBody(this.values),
        signal: AbortSignal.timeout(60000),
      });
    } catch (error) {
      throw new GPMCError('transport', `Could not reach Google: ${error.message}`);
    }
    const text = await response.text();
    const parsed = {};
    for (const line of text.split(/\r\n|\r|\n/)) {
      const eq = line.indexOf('=');
      if (eq > 0) parsed[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (parsed.TokenEncrypted === '1') {
      throw new GPMCError('tokenBound',
        'Google returned an encrypted (bound) token. This build does not implement token binding; connect an account whose token is unbound.');
    }
    // The endpoint answers a dead master token with 200 or 403 plus an
    // `Error=` line, so read the body before judging the status code.
    if (parsed.Error) {
      throw new GPMCError('credentialRejected',
        `Google rejected the stored credential (${parsed.Error}). Connect the account again.`);
    }
    await checkedStatus(response);
    if (!parsed.Auth) {
      throw new GPMCError('credentialRejected', 'Google did not issue a token. Connect the account again.');
    }
    this.token = parsed.Auth;
    const expiry = Number(parsed.Expiry);
    this.expiry = Number.isFinite(expiry) && expiry > 0 ? expiry * 1000 : Date.now() + 300000;
  }

  // Read-only credential check: authenticate, then a dummy hash lookup.
  async validateReadAccess() {
    await this.authenticate();
    const dummyHash = Buffer.alloc(20);
    const check = bytesField(1, Buffer.concat([
      bytesField(1, bytesField(1, dummyHash)),
      bytesField(2, Buffer.alloc(0)),
    ]));
    await this.rpc(GPMCClient.HASH_CHECK_METHOD, check);
  }

  async request(url, { method = 'POST', body = undefined, headers = {}, signal } = {}) {
    if (this.expiry <= Date.now() + 30000) await this.authenticate();
    const merged = {
      'Authorization': `Bearer ${this.token}`,
      'User-Agent': GPMCClient.USER_AGENT,
      'Accept-Language': 'en_US',
      'Content-Type': 'application/x-protobuf',
      ...headers,
    };
    let response;
    try {
      response = await fetch(url, { method, headers: merged, body, signal, redirect: 'error' });
    } catch (error) {
      if (signal?.aborted) throw new Error('aborted');
      throw new GPMCError('transport', `Could not reach Google: ${error.message}`);
    }
    // A token revoked elsewhere dies mid-session; spend one forced refresh.
    if (response.status === 401 || response.status === 403) {
      this.expiry = 0;
      await this.authenticate();
      try {
        response = await fetch(url, { method, headers: merged, body, signal, redirect: 'error' });
      } catch (error) {
        if (signal?.aborted) throw new Error('aborted');
        throw new GPMCError('transport', `Could not reach Google: ${error.message}`);
      }
    }
    await checkedStatus(response);
    return response;
  }

  async rpc(method, body, { ext = false } = {}) {
    const url = `https://photosdata-pa.googleapis.com/6439526531001121323/${method}`;
    const headers = ext ? GPMCClient.EXT_HEADERS : {};
    const response = await this.request(url, { body, headers });
    return Buffer.from(await response.arrayBuffer());
  }

  // SHA-1 the file, ask whether Google already holds it, and otherwise
  // upload and commit it. Phases mirror the iOS UploadPhase enum.
  async upload(filePath, { filename = path.basename(filePath), modified = null, useQuota = true, saver = false, onPhase = () => {}, signal } = {}) {
    const stat = fs.statSync(filePath);
    if (!stat.size) throw new GPMCError('malformed', 'That item is empty; there is nothing to upload.');

    onPhase({ phase: 'hashing', fraction: 0 });
    const { hash, size } = await hashFile(filePath, (fraction) => onPhase({ phase: 'hashing', fraction }), signal);

    onPhase({ phase: 'checkingDuplicate' });
    const check = bytesField(1, Buffer.concat([
      bytesField(1, bytesField(1, hash)),
      bytesField(2, Buffer.alloc(0)),
    ]));
    const existing = await this.rpc(GPMCClient.HASH_CHECK_METHOD, check);
    const existingKey = stringAt([1, 2, 2, 1], existing);
    if (existingKey) return { outcome: 'alreadyBackedUp', mediaKey: existingKey };

    onPhase({ phase: 'preparing' });
    const prepareBody = Buffer.concat([
      intField(1, 2), intField(2, 2), intField(3, 1), intField(4, 3), intField(7, BigInt(size)),
    ]);
    const prepared = await this.request(GPMCClient.UPLOAD_ENDPOINT, {
      body: prepareBody,
      headers: {
        'X-Goog-Hash': `sha1=${hash.toString('base64')}`,
        'X-Upload-Content-Length': String(size),
      },
      signal,
    });
    const uploadID = prepared.headers.get('x-guploader-uploadid');
    if (!uploadID) throw new GPMCError('malformed', 'Google did not return an upload ID.');
    // Drain the body so the connection returns to the pool before the PUT.
    await prepared.arrayBuffer().catch(() => undefined);

    onPhase({ phase: 'sending', sent: 0, total: size });
    const putHeaders = {
      'Authorization': `Bearer ${this.token}`,
      'User-Agent': GPMCClient.USER_AGENT,
      'Accept-Language': 'en_US',
      'Content-Type': 'application/octet-stream',
    };
    const receiptResponse = await streamUpload(
      `${GPMCClient.UPLOAD_ENDPOINT}?upload_id=${encodeURIComponent(uploadID)}`,
      filePath,
      putHeaders,
      (sent, total) => onPhase({ phase: 'sending', sent, total: total > 0 ? total : size }),
      signal,
    );
    if (!(receiptResponse.status >= 200 && receiptResponse.status < 300)) {
      await checkedStatus(receiptResponse); // throws with the body quoted
    }
    const receipt = Buffer.from(await receiptResponse.arrayBuffer());
    fields(receipt); // must parse; otherwise it is not what we expect

    onPhase({ phase: 'finalizing' });
    const date = modified ?? stat.mtime;
    const stamp = BigInt(Math.max(0, Math.floor(date.getTime() / 1000)));
    const metadata = Buffer.concat([
      bytesField(1, receipt),
      stringField(2, filename),
      bytesField(3, hash),
      bytesField(4, Buffer.concat([intField(1, stamp), intField(2, 46000000)])),
      intField(7, saver ? 1 : 3),
      intField(10, 1),
    ]);
    const device = Buffer.concat([
      stringField(3, useQuota ? 'Pixel 8' : (saver ? 'Pixel 2' : 'Pixel XL')),
      stringField(4, 'Google'),
      intField(5, 28),
    ]);
    const committed = await this.rpc(GPMCClient.COMMIT_METHOD,
      Buffer.concat([bytesField(1, metadata), bytesField(2, device), bytesField(3, Buffer.from([1, 3]))]),
      { ext: true });
    const mediaKey = stringAt([1, 3, 1], committed);
    if (!mediaKey) throw new GPMCError('malformed', 'Google rejected the upload during finalization.');
    return { outcome: 'uploaded', mediaKey };
  }
}

module.exports = { GPMCClient, GPMCError, parseAuthData, authDataBody };

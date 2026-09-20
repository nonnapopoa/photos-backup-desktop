'use strict';

// Google Photos private-API client. Direct port of GPMC/Core/GPMCClient.swift.
// Uses Node's global fetch (undici); uploads stream from disk with progress.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { intField, bytesField, stringField, fields, numberAt, stringAt } = require('./proto');

// The `google.rpc.Status` Google puts in a protobuf error body: a canonical
// code in field 1, an English message in field 2. The code is the half worth
// branching on — the message is prose Google can reword at any time.
const RPC_CODES = {
  3: 'invalidArgument',
  4: 'deadlineExceeded',
  7: 'permissionDenied',
  8: 'resourceExhausted',
  9: 'failedPrecondition',
  10: 'aborted',
  14: 'unavailable',
  16: 'unauthenticated',
};

function parseGoogleStatus(buffer) {
  if (!buffer || !buffer.length) return null;
  let rawNumber;
  try { rawNumber = numberAt(1, buffer); } catch { return null; }
  if (rawNumber == null || rawNumber <= 0n) return null; // code 0 is OK, not a failure
  const rawCode = Number(rawNumber);
  let message = null;
  try { message = stringAt([2], buffer); } catch { /* absent */ }
  return { rawCode, code: RPC_CODES[rawCode] || null, message };
}

class GPMCError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'GPMCError';
    this.kind = kind; // credentialRejected | tokenBound | transport | server | malformed | invalidUploadReceipt | storageFull
    this.status = status; // parsed google.rpc.Status, when Google sent one
    this.statusCode = kind === 'server' ? Number(message.match(/HTTP (\d+)/)?.[1] || 0) : 0;
  }
  get retryable() {
    if (this.kind === 'transport' || this.kind === 'invalidUploadReceipt') return true;
    if (this.kind === 'server') return this.statusCode === 408 || this.statusCode === 429 || this.statusCode >= 500;
    return false;
  }
  // Whether a commit failure says the receipt itself is unusable, so the item
  // is worth another preflight and transfer rather than being failed.
  // INVALID_ARGUMENT is the structural signal; the "valid blueprint" wording
  // is the fallback for rejections that arrive without a parseable status.
  static rejectsReceipt(error) {
    if (!(error instanceof GPMCError) || error.kind !== 'server') return false;
    if (error.status?.code) return error.status.code === 'invalidArgument';
    return /valid blueprint/i.test(error.message);
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

// Quote Google's error bodies. Prefer the status message, fall back to a
// printable body, and keep the hex prefix for anything else.
function explanation(buffer, limit = 240) {
  if (!buffer || !buffer.length) return '';
  const status = parseGoogleStatus(buffer);
  const text = status?.message ?? buffer.toString('utf8');
  const printable = [...text].every((ch) => ch === '\n' || ch === '\t' || (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f));
  let detail;
  if (printable) {
    detail = text.trim().slice(0, limit);
  } else {
    detail = '0x' + [...buffer.subarray(0, Math.floor(limit / 4))].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return detail ? ` Google said: ${detail}` : '';
}

// CommitToken's field 2 contains the opaque upload token. Parsing alone
// accepts an empty message (or an unrelated protobuf error) as a receipt.
function validateReceipt(receipt) {
  let token;
  try { token = (fields(receipt)[2] || [])[0]; } catch { token = undefined; }
  if (!token || !token.length) {
    throw new GPMCError('invalidUploadReceipt',
      'Google did not return a usable upload receipt. The file must be transferred again.');
  }
}

async function checkedStatus(response, operation = 'request') {
  const body = Buffer.from(await response.arrayBuffer());
  if (response.status === 401 || response.status === 403) {
    throw new GPMCError('credentialRejected',
      `Google rejected the stored credential (HTTP ${response.status}). Connect the account again.`);
  }
  if (!(response.status >= 200 && response.status < 300)) {
    const status = parseGoogleStatus(body);
    const detail = explanation(body);
    // The canonical code says more than the HTTP status: rate limiting shares
    // RESOURCE_EXHAUSTED with 429 (already retryable), but a non-429 code 8
    // means the account itself has no room left, which retrying cannot fix.
    if (status?.code === 'resourceExhausted' && response.status !== 429) {
      throw new GPMCError('storageFull',
        `The Google account is out of storage. Free up space in Google Photos, then resume.${detail}`, status);
    }
    if (status?.code === 'unauthenticated' || status?.code === 'permissionDenied') {
      throw new GPMCError('credentialRejected',
        `Google rejected the stored credential during ${operation}. Connect the account again.${detail}`, status);
    }
    throw new GPMCError('server',
      `Google returned HTTP ${response.status} during ${operation}.${detail}`, status);
  }
  return body;
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
// The Node stream is piped through a counting PassThrough and converted with
// Readable.toWeb() — undici pulls from it with proper backpressure. (A
// hand-rolled pull() waiting on 'readable' events races with the stream and
// can deadlock mid-file; this way there is no manual event bookkeeping.)
//
// A watchdog aborts the request when no bytes have moved for `idleTimeoutMs`
// (default 90s) so a stalled upload surfaces as a retryable transport error
// instead of hanging a queue slot forever.
async function streamUpload(url, filePath, headers, onProgress, signal, { idleTimeoutMs = 90000 } = {}) {
  const { PassThrough, Readable } = require('stream');
  const stat = fs.statSync(filePath);
  const total = stat.size;
  let sent = 0;
  let lastProgress = Date.now();

  const source = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
  const counter = new PassThrough();
  counter.on('data', (chunk) => {
    sent += chunk.length;
    lastProgress = Date.now();
    onProgress?.(sent, total);
  });
  source.on('error', (error) => counter.destroy(error));
  const piped = source.pipe(counter);

  // Abort both the streams and the fetch itself: if the server stops reading
  // mid-body the stream destroy propagates, and if the body is fully sent but
  // the response never arrives only aborting the fetch can break the wait.
  const localAbort = new AbortController();
  let stallError = null;
  signal?.addEventListener('abort', () => localAbort.abort(), { once: true });

  const watchdog = setInterval(() => {
    if (Date.now() - lastProgress > idleTimeoutMs) {
      stallError = new GPMCError('transport',
        `Upload stalled: no progress for ${Math.round(idleTimeoutMs / 1000)}s (sent ${sent}/${total} bytes).`);
      localAbort.abort();
      source.destroy(stallError);
      counter.destroy(stallError);
    }
  }, Math.min(5000, Math.max(250, Math.floor(idleTimeoutMs / 4))));
  watchdog.unref?.();

  signal?.addEventListener('abort', () => {
    source.destroy(new Error('aborted'));
    counter.destroy();
  }, { once: true });

  const body = Readable.toWeb(piped);
  try {
    return await fetch(url, {
      method: 'PUT',
      headers,
      body,
      duplex: 'half',
      signal: localAbort.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('aborted'); // user cancellation wins
    if (stallError) throw stallError;
    if (error instanceof GPMCError) throw error;
    throw new GPMCError('transport', `Could not reach Google: ${error.message}`);
  } finally {
    clearInterval(watchdog);
  }
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

  // The device model and quality code a commit declares, the same mapping
  // upstream gpmc uses (upstream 0.3.6). The model decides how Google accounts
  // for the upload's storage — an older Pixel's uploads do not count against
  // it — and the quality code asks for original bytes (3) or Storage Saver
  // (1). The Google Photos app labels an upload from the free-storage models
  // "Storage saver" even when the original bytes were kept; exposed so the
  // diagnostic report shows exactly what was sent.
  static commitProfile(useQuota, saver) {
    return {
      model: useQuota ? 'Pixel 8' : (saver ? 'Pixel 2' : 'Pixel XL'),
      quality: saver ? 1 : 3,
    };
  }

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
    if (!(response.status >= 200 && response.status < 300)) {
      const body = Buffer.from(text);
      const status = parseGoogleStatus(body);
      throw new GPMCError('server',
        `Google returned HTTP ${response.status} during authentication.${explanation(body)}`, status);
    }
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

  // Authenticated request. The body is always drained (so the connection
  // returns to the pool) and validated; returns { response, body }.
  async request(url, { method = 'POST', body = undefined, headers = {}, operation = 'request', signal } = {}) {
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
    // A token revoked elsewhere dies mid-session; spend one forced refresh on
    // these small replayable data requests (the file PUT bypasses this helper
    // and retains its own upload ID).
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
    const drained = await checkedStatus(response, operation);
    return { response, body: drained };
  }

  async rpc(method, body, { ext = false } = {}) {
    const url = `https://photosdata-pa.googleapis.com/6439526531001121323/${method}`;
    const headers = ext ? GPMCClient.EXT_HEADERS : {};
    const { body: payload } = await this.request(url, {
      body,
      headers,
      operation: method === GPMCClient.COMMIT_METHOD ? 'finalization' : 'duplicate check',
    });
    return payload;
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
    const { response: prepared, body: _prepareBody } = await this.request(GPMCClient.UPLOAD_ENDPOINT, {
      body: prepareBody,
      headers: {
        'X-Goog-Hash': `sha1=${hash.toString('base64')}`,
        'X-Upload-Content-Length': String(size),
      },
      operation: 'upload initialization',
      signal,
    });
    const uploadID = prepared.headers.get('x-guploader-uploadid');
    if (!uploadID) throw new GPMCError('malformed', 'Google did not return an upload ID.');

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
    // checkedStatus drains and maps the error body; validateReceipt then makes
    // sure the receipt actually carries an upload token in field 2 — an empty
    // or unrelated protobuf here would otherwise fail later as HTTP 400.
    const receipt = await checkedStatus(receiptResponse, 'file transfer');
    validateReceipt(receipt);

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
      stringField(3, GPMCClient.commitProfile(useQuota, saver).model),
      stringField(4, 'Google'),
      intField(5, 28),
    ]);
    let committed;
    try {
      committed = await this.rpc(GPMCClient.COMMIT_METHOD,
        Buffer.concat([bytesField(1, metadata), bytesField(2, device), bytesField(3, Buffer.from([1, 3]))]),
        { ext: true });
    } catch (error) {
      // A commit that rejects the receipt itself (INVALID_ARGUMENT) is worth a
      // fresh preflight and transfer, not a permanent failure.
      if (GPMCError.rejectsReceipt(error)) {
        throw new GPMCError('invalidUploadReceipt', error.message, error.status);
      }
      throw error;
    }
    const mediaKey = stringAt([1, 3, 1], committed);
    if (!mediaKey) throw new GPMCError('malformed', 'Google rejected the upload during finalization.');
    return { outcome: 'uploaded', mediaKey };
  }
}

module.exports = { GPMCClient, GPMCError, parseAuthData, authDataBody, streamUpload, parseGoogleStatus, validateReceipt };

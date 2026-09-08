'use strict';

// oauth_token -> Android master token -> Google Photos credential.
// Direct port of App/Sources/TokenExchange.swift, which is itself a port of
// gotohp's backend/googleauth.go (exchangeOAuthToken + buildGooglePhotosCredential).

const crypto = require('crypto');

const AUTH_URL = 'https://android.clients.google.com/auth';
// First-party "android" package signature (ac2dm step).
const ANDROID_SIG = '38918a453d07199354f8b19af05ec6562ced5788';
// Google Photos package signature (credential step).
const PHOTOS_SIG = '24bb24c05e47e0aefa68a58a766179d9b613a600';

class ExchangeFailure extends Error {
  constructor(stage, message) {
    super(`${stage}: ${message}`);
    this.name = 'ExchangeFailure';
    this.stage = stage;
  }
}

function encodeForm(pairs) {
  return pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function randomAndroidId() {
  // 16 hex chars, matching gotohp's generator.
  return crypto.randomBytes(8).toString('hex');
}

function oauthExchangeBody(oauthToken, androidId) {
  return [
    ['accountType', 'HOSTED_OR_GOOGLE'],
    ['Email', 'oauth-token@example.com'], // placeholder; real value comes back
    ['has_permission', '1'],
    ['add_account', '1'],
    ['ACCESS_TOKEN', '1'],
    ['Token', oauthToken],
    ['service', 'ac2dm'],
    ['source', 'android'],
    ['androidId', androidId],
    ['device_country', 'us'],
    ['operatorCountry', 'us'],
    ['lang', 'en'],
    ['sdk_version', '17'],
    ['google_play_services_version', '240913000'],
    ['client_sig', ANDROID_SIG],
    ['callerSig', ANDROID_SIG],
    ['droidguard_results', 'dummy123'],
  ];
}

function googlePhotosCredentialPairs(androidId, email, masterToken) {
  return [
    ['androidId', androidId],
    ['app', 'com.google.android.apps.photos'],
    ['callerPkg', 'com.google.android.apps.photos'],
    ['callerSig', PHOTOS_SIG],
    ['client_sig', PHOTOS_SIG],
    ['device_country', 'us'],
    ['Email', email],
    ['google_play_services_version', '240913000'],
    ['lang', 'en_US'],
    ['oauth2_foreground', '1'],
    ['operatorCountry', 'us'],
    ['sdk_version', '33'],
    ['service', 'oauth2:openid https://www.googleapis.com/auth/mobileapps.native https://www.googleapis.com/auth/photos.native'],
    ['source', 'android'],
    ['Token', masterToken],
  ];
}

// Google's auth endpoint returns `Key=Value` lines (one per line).
function parseAuthResponse(text) {
  const out = {};
  for (const line of text.split(/\r\n|\r|\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

async function postAuth(body, stage) {
  let response;
  try {
    response = await fetch(AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'GoogleAuth/1.4',
        'Accept-Encoding': 'identity',
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    throw new ExchangeFailure(stage, `Network error: ${error.message}`);
  }
  // gotohp rejects redirects here: a 3xx means the token was not usable.
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new ExchangeFailure(stage, `Google redirected the auth request (HTTP ${response.status || '3xx'}); the oauth_token was rejected.`);
  }
  const text = await response.text();
  // 403 still carries an Error= body worth surfacing.
  if (!(response.status === 200 || response.status === 403)) {
    throw new ExchangeFailure(stage, `HTTP ${response.status}. ${text.slice(0, 200)}`);
  }
  return parseAuthResponse(text);
}

function googleError(code, fields) {
  switch (code) {
    case 'BadAuthentication':
      return 'BadAuthentication — the oauth_token is invalid or already spent.';
    case 'NeedsBrowser':
    case 'DeviceManagementRequiredOrSyncDisabled':
      return `${code} — Google wants an interactive challenge; complete it in the sign-in window and recapture.`;
    default: {
      let msg = code;
      if (fields.ErrorDetail) msg += ` (${fields.ErrorDetail})`;
      if (fields.Url) msg += ` see ${fields.Url}`;
      return msg;
    }
  }
}

function normaliseEmail(raw) {
  const trimmed = raw.trim();
  return trimmed.includes('@') ? trimmed : null;
}

// Step 1: oauth_token -> master token.
async function exchangeOAuthToken(oauthToken, androidId) {
  const fields = await postAuth(encodeForm(oauthExchangeBody(oauthToken, androidId)), 'master token');
  if (fields.Error) {
    throw new ExchangeFailure('master token', googleError(fields.Error, fields));
  }
  if (!fields.Token) {
    throw new ExchangeFailure('master token',
      'Google accepted the request but returned no master token. The oauth_token is likely stale — repeat the EmbeddedSetup sign-in.');
  }
  const email = normaliseEmail(fields.Email || '') || 'unknown';
  return { masterToken: fields.Token, email, encrypted: fields.TokenEncrypted === '1' };
}

// Step 2: master token -> Photos credential.
async function redeemCredential(body) {
  const fields = await postAuth(body, 'photos token');
  if (fields.Error) {
    throw new ExchangeFailure('photos token', googleError(fields.Error, fields));
  }
  if (fields.TokenEncrypted === '1') {
    throw new ExchangeFailure('photos token',
      'Google returned TokenEncrypted=1 (token binding). This build does not implement the bound-token key exchange.');
  }
  if (!fields.Auth) throw new ExchangeFailure('photos token', 'No Auth field in the response.');
  const expiry = fields.Expiry ? Number(fields.Expiry) : null;
  return { accessToken: fields.Auth, expiry: Number.isFinite(expiry) ? expiry : null };
}

// Run the whole exchange. `authData` is the `&`-joined form body the GPMC
// client consumes for the Photos API.
async function run(oauthToken, androidId = randomAndroidId()) {
  const step1 = await exchangeOAuthToken(oauthToken, androidId);
  const cred = encodeForm(googlePhotosCredentialPairs(androidId, step1.email, step1.masterToken));
  const step2 = await redeemCredential(cred);
  return {
    androidId,
    email: step1.email,
    masterToken: step1.masterToken,
    photosAccessToken: step2.accessToken,
    photosTokenExpiry: step2.expiry,
    authData: cred,
    encrypted: step1.encrypted,
  };
}

module.exports = { run, encodeForm, parseAuthResponse, randomAndroidId, ExchangeFailure };

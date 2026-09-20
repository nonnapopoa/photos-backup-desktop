'use strict';

// Google account connection. The desktop equivalent of
// App/Sources/AccountConnectWebView.swift: host Google's EmbeddedSetup flow in
// a window with a private, non-persistent session, then read the HttpOnly
// `oauth_token` cookie straight out of that session's cookie store. Electron's
// main-process cookies API (unlike a browser's document.cookie) returns
// HttpOnly cookies, which is the whole reason this works.
//
// Google's "This browser or app may not be secure" screen is the failure mode
// when the environment does not add up. The iOS app's proven configuration is
// a full mobile-Safari UA — Safari sends no client hints, so there is nothing
// for Chromium to contradict. Getting away with that from Electron needs three
// things at once:
//   1. the iPhone Safari UA (below), never a Chrome UA;
//   2. stripping Sec-CH-UA-* / X-Client-Data request headers Chromium adds
//      (a "Safari" request carrying client hints is an instant mismatch);
//   3. hiding the Chromium-only JS surface (navigator.userAgentData,
//      window.chrome, navigator.vendor) via a same-world preload;
//   4. a fully sandboxed renderer (the Electron default). Any weakening —
//      sandbox: false here, or --no-sandbox — gets rejected by Google even
//      with 1-3 in place (verified with test/signin-smoke.js), so leave the
//      sandbox alone when chasing sign-in failures.

const path = require('path');
const { BrowserWindow, session } = require('electron');

const SETUP_URL = 'https://accounts.google.com/EmbeddedSetup';
const COOKIE_NAME = 'oauth_token';
const POLL_INTERVAL = 600;
// One retry (two attempts total) when the window's first navigation fails
// with a generic ERR_FAILED — see connectAccount.
const INITIAL_LOAD_RETRIES = 1;

// Full mobile-Safari UA, the configuration proven against EmbeddedSetup by the
// upstream iOS app (AccountConnectWebView.swift, Coordinator.safariUserAgent).
const SAFARI_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

function stripChromiumFingerprints(authSession) {
  authSession.setUserAgent(SAFARI_USER_AGENT, 'en-US');
  authSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if (lower.startsWith('sec-ch-') || lower === 'x-client-data') {
        delete headers[name];
      }
    }
    callback({ requestHeaders: headers });
  });
}

// Electron's loadURL rejects with ERR_FAILED (-2) for failures that never
// produce a did-fail-load, and several Windows-only ones land there.
function isErrFailed(error) {
  return !!error && (error.errno === -2
    || error.code === 'ERR_FAILED'
    || /^ERR_FAILED/.test(error.message || ''));
}

function describeLoadError(error) {
  if (isErrFailed(error)) {
    return "Google's sign-in page failed to load (ERR_FAILED). "
      + 'If Photos Backup is running as administrator, close it and launch it normally; '
      + 'VPN, proxy, or antivirus web filtering can also block it. Then try again.';
  }
  return (error && error.message) || String(error);
}

// Resolves with the oauth_token value; rejects if the user closes the window
// or the flow errors out. The Google session never touches disk.
function connectAccount(parentWindow) {
  return new Promise((resolve, reject) => {
    let attemptsLeft = 1 + INITIAL_LOAD_RETRIES;

    const attempt = () => {
      const authSession = session.fromPartition('photosbackup-auth', { cache: false });
      stripChromiumFingerprints(authSession);

      const win = new BrowserWindow({
        parent: parentWindow || null,
        modal: !!parentWindow,
        width: 400,
        height: 780,
        title: 'Connect Google Account',
        autoHideMenuBar: true,
        show: false,
        backgroundColor: '#ffffff',
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        webPreferences: {
          session: authSession,
          // The preload patches page-visible globals, so it must share the
          // page's world. It uses no Node/Electron APIs, and the window only
          // ever loads Google's sign-in page. The renderer stays sandboxed
          // (the default): see the header comment — weakening the sandbox
          // makes Google reject the sign-in.
          preload: path.join(__dirname, 'authPreload.js'),
          contextIsolation: false,
          nodeIntegration: false,
        },
      });
      win.setMenuBarVisibility(false);
      // Show once painted; no blank frame while navigation starts.
      win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });

      let settled = false;
      const teardown = () => {
        clearInterval(poll);
        // The captured oauth_token is single-use; discard the whole session.
        authSession.clearStorageData();
        try { win.destroy(); } catch { /* ignore */ }
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        teardown();
        fn(value);
      };

      const poll = setInterval(() => {
        authSession.cookies
          .get({ url: 'https://accounts.google.com', name: COOKIE_NAME })
          .then((cookies) => {
            const cookie = cookies.find((c) => c.domain.includes('accounts.google.com') && c.value);
            if (cookie) finish(resolve, cookie.value);
          })
          .catch(() => { /* transient; keep polling */ });
      }, POLL_INTERVAL);

      win.on('closed', () => finish(reject, new Error('Sign-in was cancelled.')));
      win.loadURL(SETUP_URL).catch((error) => {
        if (settled) return;
        // ERR_FAILED on the *initial* navigation is a known Windows flake —
        // slow first navigation on busy machines, network service still
        // starting (see electron/electron#18857). Retry once with a fresh
        // window and session before surfacing an error.
        attemptsLeft -= 1;
        if (attemptsLeft > 0 && isErrFailed(error)) {
          settled = true;
          teardown();
          attempt();
          return;
        }
        finish(reject, new Error(describeLoadError(error)));
      });
    };

    attempt();
  });
}

module.exports = { connectAccount, SAFARI_USER_AGENT, stripChromiumFingerprints };

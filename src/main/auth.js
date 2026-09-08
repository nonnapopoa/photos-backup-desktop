'use strict';

// Google account connection. The desktop equivalent of
// App/Sources/AccountConnectWebView.swift: host Google's EmbeddedSetup flow in
// a window with a private, non-persistent session, then read the HttpOnly
// `oauth_token` cookie straight out of that session's cookie store. Electron's
// main-process cookies API (unlike a browser's document.cookie) returns
// HttpOnly cookies, which is the whole reason this works.

const { BrowserWindow, session } = require('electron');

const SETUP_URL = 'https://accounts.google.com/EmbeddedSetup';
const COOKIE_NAME = 'oauth_token';
const POLL_INTERVAL = 600;

function chromeUserAgent() {
  const chromiumVersion = process.versions.chrome || '130.0.0.0';
  let platform;
  switch (process.platform) {
    case 'darwin': platform = 'Macintosh; Intel Mac OS X 10_15_7'; break;
    case 'win32': platform = 'Windows NT 10.0; Win64; x64'; break;
    default: platform = 'X11; Linux x86_64'; break;
  }
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`;
}

// Resolves with the oauth_token value; rejects if the user closes the window
// or the flow errors out. The Google session never touches disk.
function connectAccount(parentWindow) {
  return new Promise((resolve, reject) => {
    const authSession = session.fromPartition('photosbackup-auth', { cache: false });
    authSession.setUserAgent(chromeUserAgent());

    const win = new BrowserWindow({
      parent: parentWindow || null,
      modal: !!parentWindow,
      width: 480,
      height: 700,
      title: 'Connect Google Account',
      autoHideMenuBar: true,
      webPreferences: {
        session: authSession,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      // The captured oauth_token is single-use; discard the whole session.
      authSession.clearStorageData();
      try { win.destroy(); } catch { /* ignore */ }
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
    win.loadURL(SETUP_URL).catch((error) => finish(reject, error));
  });
}

module.exports = { connectAccount };

'use strict';

// Loads Google's EmbeddedSetup page in the exact environment auth.js builds
// (spoofed iPhone Safari session + preload) and reports whether Google shows
// its sign-in form or the "This browser or app may not be secure" block.
// Run with: npx electron test/signin-smoke.js

const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const { SAFARI_USER_AGENT, stripChromiumFingerprints } = require('../src/main/auth');

const SETUP_URL = 'https://accounts.google.com/EmbeddedSetup';

app.whenReady().then(async () => {
  const authSession = session.fromPartition('photosbackup-auth-smoke', { cache: false });
  stripChromiumFingerprints(authSession);

  const win = new BrowserWindow({
    show: true,
    width: 400,
    height: 780,
    webPreferences: {
      session: authSession,
      preload: path.join(__dirname, '..', 'src', 'main', 'authPreload.js'),
      contextIsolation: false,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (event) => {
    const message = event?.message ?? '';
    if (/error|warn|failed|uncaught/i.test(message)) console.log(`  [console] ${String(message).slice(0, 220)}`);
  });
  if (process.env.SMOKE_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });

  const deadline = Date.now() + 25000;
  try {
    await win.loadURL(SETUP_URL);
  } catch (error) {
    console.log(`SMOKE: LOAD-ERROR ${error.message}`);
    app.exit(1);
    return;
  }

  const PROBE = `(() => {
    const text = document.body ? document.body.innerText : '';
    return JSON.stringify({
      href: location.href,
      readyState: document.readyState,
      blocked: text.includes('may not be secure') || text.includes("Couldn't sign you in"),
      hasEmailField: !!document.querySelector('input[type=email], input[type=tel], input[type=password]'),
      ua: navigator.userAgent,
      uaData: String(navigator.userAgentData),
      chrome: String(window.chrome),
      vendor: navigator.vendor,
      node: [typeof process, typeof Buffer, typeof require].join('/'),
      title: document.title,
      bodyLength: text.length,
      snippet: text.split('\\n').filter(Boolean).slice(0, 3).join(' | '),
    });
  })()`;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const state = await win.webContents.executeJavaScript(PROBE)
      .then((json) => JSON.parse(json)).catch((e) => { console.log(`  (eval failed: ${e.message})`); return null; });
    if (!state) continue;
    console.log(`  ${state.readyState} ${state.href.slice(0, 80)} body=${state.bodyLength} "${state.snippet.slice(0, 70)}"`);

    if (state.blocked) {
      console.log(`SMOKE: BLOCKED — ua=${state.ua} uaData=${state.uaData} chrome=${state.chrome} vendor=${state.vendor} node=${state.node}`);
      app.exit(2);
      return;
    }
    if (state.hasEmailField) {
      console.log(`SMOKE: SIGN-IN-FORM-REACHED (title: ${state.title})`);
      console.log(`SMOKE: fingerprint: uaData=${state.uaData} chrome=${state.chrome} vendor=${state.vendor} node=${state.node}`);
      app.exit(0);
      return;
    }
  }
  console.log('SMOKE: TIMEOUT — neither the form nor the block appeared.');
  const title = await win.webContents.executeJavaScript('document.title').catch(() => '?');
  console.log(`SMOKE: title=${title}`);
  app.exit(3);
});

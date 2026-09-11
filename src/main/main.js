'use strict';

// Main process: window lifecycle, account state machine, and the IPC surface
// the renderer talks to. Mirrors PhotosBackupApp.swift's composition root.

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const { connectAccount } = require('./auth');
const { CredentialStore } = require('./credentialStore');
const { Settings } = require('./settings');
const { scanFolders } = require('./mediaScanner');
const { UploadQueue, clampConcurrency } = require('./uploadQueue');
const TokenExchange = require('./tokenExchange');
const { GPMCClient, GPMCError } = require('./gpmc');

let mainWindow = null;
let queue = null;
const credentials = new CredentialStore();
const settings = new Settings();

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function accountState() {
  const stored = credentials.cached;
  if (!stored) return { status: 'disconnected', email: null };
  if (!queue) return { status: 'connected', email: stored.email, validated: false };
  return { status: 'connected', email: queue.email, validated: true };
}

function emitState() {
  send('account-state', accountState());
  send('settings', settings.data);
}

function pushSnapshot(snapshot) {
  send('queue-snapshot', snapshot);
}

async function validateCredential(credential) {
  const client = new GPMCClient(credential.authData);
  await client.validateReadAccess();
}

function startQueue(credential) {
  queue = new UploadQueue({ credential, settings, onSnapshot: pushSnapshot });
  emitState();
}

// Upstream 0.3.4: a manual "Back Up Now" queues the whole selection — the
// bounded batches remain an automatic-pass technique only. Quota pacing is
// handled at the request level by the queue's 429 cooldown and retry backoff.
async function runBackup({ recheck = false } = {}) {
  if (!queue) return { error: 'not-connected' };
  const folders = settings.get('folders') || [];
  if (!folders.length) return { error: 'no-folders' };
  const released = queue.releaseRetryableFailures();
  if (recheck) settings.clearCompleted(queue.email);
  send('scan-started', {});
  const found = await scanFolders(folders);
  send('scan-finished', { count: found.length });
  const { queued } = await queue.enqueueScan(found);
  return { found: found.length, queued, released, recheck };
}

function createWindow() {
  // Match the renderer's CSS background (styles.css) so the window never
  // flashes white before the first paint — including in dark mode.
  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#16181c' : '#f5f6f8';
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    // Sizes refer to the page content, not the window frame. Width is fixed:
    // minWidth === maxWidth pins it at 960 while the height stays resizable.
    // Fullscreen is disabled because it would bypass the width constraint.
    useContentSize: true,
    minWidth: 960,
    maxWidth: 960,
    minHeight: 560,
    fullscreenable: false,
    title: 'Photos Backup',
    autoHideMenuBar: true,
    show: false,
    backgroundColor,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  // Show only once the renderer has painted: no white flash on startup.
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  // Restore any saved account, then validate quietly in the background.
  const stored = credentials.load();
  if (stored) {
    startQueue(stored);
    validateCredential(stored)
      .then(() => emitState())
      .catch((error) => {
        // Do NOT clear the stored credential here: a transient 403 looks the
        // same as a revoked token at this layer, and destroying a good
        // credential forces an unnecessary re-login. Warn instead; the user
        // can disconnect explicitly.
        send('account-warning', error instanceof GPMCError
          ? `${error.message} The saved account is kept — if it keeps failing, disconnect and connect again.`
          : 'The saved credential could not be validated; uploads will retry automatically.');
      });
  } else if (credentials.lastLoadFailure) {
    send('account-warning', credentials.lastLoadFailure.message);
  }
  emitState();
}

function registerIpc() {
  ipcMain.handle('get-state', () => ({ account: accountState(), settings: settings.data }));

  ipcMain.handle('connect-account', async () => {
    let oauthToken;
    try {
      oauthToken = await connectAccount(mainWindow);
    } catch (error) {
      return { error: error.message };
    }
    let result;
    try {
      result = await TokenExchange.run(oauthToken);
    } catch (error) {
      return { error: `Token exchange failed — ${error.message}` };
    }
    if (result.encrypted) {
      return { error: 'Google issued a bound (encrypted) token. This build cannot use it; connect an account whose token is unbound.' };
    }
    const credential = {
      androidId: result.androidId,
      email: result.email,
      masterToken: result.masterToken,
      authData: result.authData,
      connectedAt: new Date().toISOString(),
    };
    let persisted = true;
    let persistError = null;
    try {
      credentials.save(credential);
    } catch (error) {
      // Usable now, just not across relaunches (same deal as the iOS app's
      // Unpersisted path when the Keychain refuses).
      persisted = false;
      persistError = error.message;
      credentials.adopt(credential);
    }
    startQueue(credential);
    try {
      await validateCredential(credential);
    } catch (error) {
      emitState();
      return { warning: `Connected as ${result.email}, but validation failed: ${error.message}` };
    }
    emitState();
    return persisted
      ? { email: result.email }
      : { email: result.email, warning: `Connected as ${result.email} for this session, but the credential could not be saved to disk (${persistError}). You may need to sign in again after restarting.` };
  });

  ipcMain.handle('disconnect-account', () => {
    queue?.cancelAll();
    queue = null;
    credentials.clear();
    emitState();
    return { ok: true };
  });

  ipcMain.handle('select-folders', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose folders to back up',
      properties: ['openDirectory', 'multiSelections', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths.length) return { folders: settings.get('folders') };
    const current = settings.get('folders') || [];
    const merged = [...new Set([...current, ...picked.filePaths])];
    settings.update({ folders: merged });
    emitState();
    return { folders: merged };
  });

  ipcMain.handle('remove-folder', (_event, folder) => {
    const folders = (settings.get('folders') || []).filter((f) => f !== folder);
    settings.update({ folders });
    emitState();
    return { folders };
  });

  ipcMain.handle('update-settings', (_event, patch) => {
    const allowed = {};
    for (const key of ['storageSaver', 'useQuota', 'autoStart']) {
      if (key in patch) allowed[key] = !!patch[key];
    }
    if ('concurrency' in patch) allowed.concurrency = clampConcurrency(patch.concurrency);
    settings.update(allowed);
    queue?.setMaxConcurrent(settings.get('concurrency'));
    emitState();
    return settings.data;
  });

  ipcMain.handle('run-backup', () => runBackup());
  ipcMain.handle('recheck-backup', () => runBackup({ recheck: true }));

  ipcMain.handle('queue-pause', () => { queue?.pause(); return { ok: true }; });
  ipcMain.handle('queue-resume', () => { queue?.resume(); return { ok: true }; });
  ipcMain.handle('queue-cancel', () => { queue?.cancelAll(); return { ok: true }; });
  ipcMain.handle('queue-retry-failed', () => { queue?.retryFailed(); return { ok: true }; });

  ipcMain.handle('open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
    return { ok: true };
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

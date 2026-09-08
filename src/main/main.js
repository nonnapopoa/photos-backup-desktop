'use strict';

// Main process: window lifecycle, account state machine, and the IPC surface
// the renderer talks to. Mirrors PhotosBackupApp.swift's composition root.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { connectAccount } = require('./auth');
const { CredentialStore } = require('./credentialStore');
const { Settings } = require('./settings');
const { scanFolders } = require('./mediaScanner');
const { UploadQueue } = require('./uploadQueue');
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

async function runBackup() {
  if (!queue) return { error: 'not-connected' };
  const folders = settings.get('folders') || [];
  if (!folders.length) return { error: 'no-folders' };
  send('scan-started', {});
  const found = await scanFolders(folders);
  send('scan-finished', { count: found.length });
  await queue.enqueueScan(found);
  return { queued: found.length };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: 'Photos Backup',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
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
    for (const key of ['quality', 'autoStart']) {
      if (key in patch) allowed[key] = patch[key];
    }
    settings.update(allowed);
    emitState();
    return settings.data;
  });

  ipcMain.handle('run-backup', () => runBackup());

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

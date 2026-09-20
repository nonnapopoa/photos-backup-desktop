'use strict';

// Renderer state + IPC glue. No framework — the whole UI is a few lists that
// re-render from the snapshots the main process pushes.

const els = {
  warningBanner: document.getElementById('warningBanner'),
  onboarding: document.getElementById('onboarding'),
  dashboard: document.getElementById('dashboard'),
  accountBadge: document.getElementById('accountBadge'),
  connectButton: document.getElementById('connectButton'),
  connectError: document.getElementById('connectError'),
  folderList: document.getElementById('folderList'),
  noFolders: document.getElementById('noFolders'),
  addFolderButton: document.getElementById('addFolderButton'),
  backupButton: document.getElementById('backupButton'),
  recheckButton: document.getElementById('recheckButton'),
  pauseButton: document.getElementById('pauseButton'),
  cancelButton: document.getElementById('cancelButton'),
  retryButton: document.getElementById('retryButton'),
  storageSaverToggle: document.getElementById('storageSaverToggle'),
  useQuotaToggle: document.getElementById('useQuotaToggle'),
  concurrencySelect: document.getElementById('concurrencySelect'),
  summary: document.getElementById('summary'),
  scanNote: document.getElementById('scanNote'),
  uploadList: document.getElementById('uploadList'),
  emptyQueue: document.getElementById('emptyQueue'),
  disconnectButton: document.getElementById('disconnectButton'),
  copyDiagnosticsButton: document.getElementById('copyDiagnosticsButton'),
  filters: [...document.querySelectorAll('.filter')],
};

const state = {
  account: { status: 'disconnected' },
  settings: { folders: [], storageSaver: false, useQuota: false, concurrency: 2 },
  snapshot: null,
  filter: 'all',
};

const STATUS_LABELS = {
  waiting: 'Waiting',
  exporting: 'Preparing',
  hashing: 'Hashing',
  checkingDuplicate: 'Checking duplicates',
  preparing: 'Preparing',
  sending: 'Uploading',
  finalizing: 'Finalizing',
  uploaded: 'Uploaded',
  alreadyBackedUp: 'Already in Google Photos',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const ACTIVE = new Set(['hashing', 'checkingDuplicate', 'preparing', 'sending', 'finalizing']);

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function render() {
  const connected = state.account.status === 'connected';
  els.onboarding.classList.toggle('hidden', connected);
  els.dashboard.classList.toggle('hidden', !connected);
  els.disconnectButton.classList.toggle('hidden', !connected);

  els.accountBadge.classList.toggle('hidden', !connected);
  if (connected) {
    els.accountBadge.innerHTML =
      `<span class="dot ${state.account.validated ? 'ok' : 'warn'}"></span>${state.account.email || 'Connected'}`;
  }

  // Folders
  const folders = state.settings.folders || [];
  els.noFolders.classList.toggle('hidden', folders.length > 0);
  els.folderList.innerHTML = '';
  for (const folder of folders) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = folder;
    name.title = folder;
    const remove = document.createElement('button');
    remove.className = 'secondary remove';
    remove.textContent = 'Remove';
    remove.onclick = async () => {
      state.settings = await window.photosBackup.removeFolder(folder);
      render();
    };
    li.append(name, remove);
    els.folderList.append(li);
  }

  els.storageSaverToggle.checked = !!state.settings.storageSaver;
  els.useQuotaToggle.checked = !!state.settings.useQuota;
  els.concurrencySelect.value = String(state.settings.concurrency || 2);

  // Queue controls
  const snapshot = state.snapshot;
  const counts = snapshot?.counts;
  const hasActive = !!counts && (counts.active > 0 || counts.waiting > 0);
  const hasFailed = !!counts && counts.failed > 0;
  const hasCancelled = !!counts && counts.cancelled > 0;
  const paused = !!snapshot?.paused;
  const halted = !!snapshot?.halted;
  const cooling = !!snapshot && snapshot.cooldownRemainingMs > 0;
  els.backupButton.disabled = hasActive;
  els.pauseButton.disabled = !hasActive || paused;
  els.cancelButton.disabled = !hasActive && !(counts && counts.waiting > 0);
  // Retry re-queues both failed and cancelled rows.
  els.retryButton.disabled = !hasFailed && !hasCancelled && !halted;
  els.pauseButton.textContent = paused ? 'Resume' : 'Pause';

  // Halt / cooldown notes
  const queueHasWork = !!counts && (counts.active > 0 || counts.waiting > 0);
  if (halted) {
    showNote(`Stopped: ${snapshot.halted} — free up space or reconnect the account, then press Retry failed.`);
  } else if (cooling && queueHasWork) {
    showNote(`${snapshot.cooldownReason} (resuming in ${Math.ceil(snapshot.cooldownRemainingMs / 1000)}s).`, true);
  }

  // Summary chips — cancelled included so the numbers always add up.
  els.summary.innerHTML = '';
  if (counts) {
    const defs = [
      ['Total', counts.total],
      ['In progress', counts.active],
      ['Uploaded', counts.uploaded],
      ['Already backed up', counts.alreadyBackedUp],
      ['Waiting', counts.waiting],
      ['Failed', counts.failed],
      ['Cancelled', counts.cancelled],
    ];
    for (const [label, value] of defs) {
      if (label === 'Cancelled' && value === 0) continue;
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${value} ${label.toLowerCase()}`;
      els.summary.append(chip);
    }
  }

  // Upload list
  const items = snapshot?.items || [];
  const filtered = state.filter === 'all' ? items
    : state.filter === 'active' ? items.filter((i) => ACTIVE.has(i.status) || i.status === 'waiting')
    : state.filter === 'uploaded' ? items.filter((i) => i.status === 'uploaded' || i.status === 'alreadyBackedUp')
    : items.filter((i) => i.status === 'failed' || i.status === 'cancelled');
  els.emptyQueue.classList.toggle('hidden', filtered.length > 0);
  els.uploadList.innerHTML = '';
  for (const item of filtered.slice(0, 400)) {
    els.uploadList.append(renderItem(item));
  }
}

function showNote(text, sticky = false) {
  els.scanNote.textContent = text;
  els.scanNote.classList.remove('hidden');
  if (sticky) {
    els.scanNote.dataset.sticky = '1';
    clearTimeout(showNote.timer);
  } else {
    delete els.scanNote.dataset.sticky;
    clearTimeout(showNote.timer);
    showNote.timer = setTimeout(() => {
      if (els.scanNote.dataset.sticky !== '1') els.scanNote.classList.add('hidden');
    }, 12000);
  }
}

function renderItem(item) {
  const li = document.createElement('li');

  const row1 = document.createElement('div');
  row1.className = 'row1';
  const name = document.createElement('span');
  name.className = 'filename';
  name.textContent = item.filename;
  name.title = item.path;
  const status = document.createElement('span');
  status.className = `status ${item.status}`;
  status.textContent = STATUS_LABELS[item.status] || item.status;
  row1.append(name, status);

  const dirname = document.createElement('div');
  dirname.className = 'dirname';
  dirname.textContent = `${item.path} · ${formatBytes(item.size)}`;

  li.append(row1, dirname);

  if (item.status === 'sending') {
    const match = /([\d.]+ [KMG]?B) \/ ([\d.]+ [KMG]?B)/.exec(item.detail || '');
    const sent = match ? match[1] : '';
    const track = document.createElement('div');
    track.className = 'progress';
    const bar = document.createElement('div');
    let fraction = 0;
    if (match) {
      const parse = (s) => { const [v, u] = s.split(' '); const m = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }; return parseFloat(v) * (m[u] || 1); };
      fraction = parse(match[1]) / Math.max(1, parse(match[2]));
    }
    bar.style.width = `${Math.round(fraction * 100)}%`;
    track.append(bar);
    li.append(track);
  } else if (item.status === 'hashing') {
    const track = document.createElement('div');
    track.className = 'progress';
    const bar = document.createElement('div');
    const pct = parseInt(item.detail || '0', 10) || 0;
    bar.style.width = `${pct}%`;
    track.append(bar);
    li.append(track);
  }

  if (item.detail && (item.status === 'hashing' || item.status === 'sending')) {
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = item.detail;
    li.append(detail);
  } else if (item.detail) {
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = item.detail;
    li.append(detail);
  }

  if (item.error) {
    const error = document.createElement('div');
    error.className = 'error-text';
    error.textContent = item.error;
    li.append(error);
  }

  return li;
}

// Wire IPC events
window.photosBackup.on('account-state', (account) => { state.account = account; render(); });
window.photosBackup.on('settings', (settings) => {
  state.settings = { ...state.settings, ...settings };
  render();
});
window.photosBackup.on('account-warning', (message) => {
  els.warningBanner.textContent = message;
  els.warningBanner.classList.remove('hidden');
});
window.photosBackup.on('queue-snapshot', (snapshot) => { state.snapshot = snapshot; render(); });
window.photosBackup.on('scan-started', () => showNote('Scanning folders…', true));
window.photosBackup.on('scan-finished', ({ count }) => showNote(`Found ${count} media file${count === 1 ? '' : 's'}.`));

// Wire controls
els.connectButton.onclick = async () => {
  els.connectError.classList.add('hidden');
  els.connectButton.disabled = true;
  els.connectButton.textContent = 'Connecting…';
  const result = await window.photosBackup.connectAccount();
  els.connectButton.disabled = false;
  els.connectButton.textContent = 'Connect Google Account';
  if (result.error) {
    els.connectError.textContent = result.error;
    els.connectError.classList.remove('hidden');
  } else if (result.warning) {
    els.connectError.textContent = result.warning;
    els.connectError.classList.remove('hidden');
  }
};

els.addFolderButton.onclick = async () => {
  const { folders } = await window.photosBackup.selectFolders();
  state.settings = { ...state.settings, folders };
  render();
};

async function runBackupFlow(recheck) {
  const result = await (recheck ? window.photosBackup.recheckBackup() : window.photosBackup.runBackup());
  if (result?.error) {
    showNote(`Could not start: ${result.error === 'no-folders' ? 'add a folder first.' : 'connect an account first.'}`, true);
    return;
  }
  if (!result) return;
  const bits = [];
  if (result.released > 0) bits.push(`${result.released} previously failed file${result.released === 1 ? '' : 's'} released for retry`);
  bits.push(result.queued > 0
    ? `queued ${result.queued} of ${result.found} file${result.found === 1 ? '' : 's'}`
    : 'everything in these folders is already backed up');
  if (result.recheck) bits.unshift('re-checking the cloud — files still present come back as "already backed up"');
  showNote(`${bits.join('; ')}.`, true);
  render();
}

els.backupButton.onclick = () => runBackupFlow(false);
els.recheckButton.onclick = () => runBackupFlow(true);
els.pauseButton.onclick = () => (state.snapshot?.paused ? window.photosBackup.resume() : window.photosBackup.pause());
els.cancelButton.onclick = () => window.photosBackup.cancelAll();
els.retryButton.onclick = () => window.photosBackup.retryFailed();
els.disconnectButton.onclick = async () => {
  await window.photosBackup.disconnectAccount();
  state.snapshot = null;
};

els.copyDiagnosticsButton.onclick = async () => {
  els.copyDiagnosticsButton.disabled = true;
  const result = await window.photosBackup.copyDiagnostics();
  els.copyDiagnosticsButton.disabled = false;
  if (result?.ok) {
    showNote(result.findings && result.findings.length && result.findings[0] !== 'Nothing unusual was detected.'
      ? `Diagnostic report copied. Worth checking: ${result.findings[0]}`
      : 'Diagnostic report copied to the clipboard.', true);
  }
};

els.storageSaverToggle.onchange = async () => {
  state.settings = await window.photosBackup.updateSettings({ storageSaver: els.storageSaverToggle.checked });
  render();
};
els.useQuotaToggle.onchange = async () => {
  state.settings = await window.photosBackup.updateSettings({ useQuota: els.useQuotaToggle.checked });
  render();
};
els.concurrencySelect.onchange = async () => {
  state.settings = await window.photosBackup.updateSettings({ concurrency: Number(els.concurrencySelect.value) });
  render();
};

for (const chip of els.filters) {
  chip.onclick = () => {
    els.filters.forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.filter = chip.dataset.filter;
    render();
  };
}

// Initial state
(async () => {
  const initial = await window.photosBackup.getState();
  state.account = initial.account;
  state.settings = { ...state.settings, ...initial.settings };
  render();
})();

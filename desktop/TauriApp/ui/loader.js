'use strict';

// The shell injects the Tauri API as window.__TAURI__ (withGlobalTauri), so this stays a
// plain static page with no bundler - the same philosophy as the bridge's own web/ panel.
const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
const listen = tauri?.event?.listen;

const PHASE_TEXT = {
  locating: 'Looking for a running bridge…',
  starting: 'Starting the bridge…',
  attached: 'Connected - opening the control panel…',
  failed: 'Could not reach the bridge',
  'setup-needed': 'One-time setup',
};

const el = (id) => document.getElementById(id);
const spinner = el('spinner');
const phaseEl = el('phase');
const detailEl = el('detail');
const ipcerror = el('ipcerror');
const setup = el('setup');
const setupError = el('setuperror');
const actions = el('actions');
const retryBtn = el('retry');
const openpanelBtn = el('openpanel');
const openlogsBtn = el('openlogs');
const logsdetails = el('logsdetails');
const logsEl = el('logs');

// If the runtime never injected, say so loudly instead of spinning forever.
if (!invoke) ipcerror.hidden = false;

function render(status) {
  const phase = String(status?.phase ?? 'locating');
  const detail = String(status?.detail ?? '');

  phaseEl.textContent = PHASE_TEXT[phase] ?? phase;
  detailEl.textContent = detail;
  spinner.classList.toggle('stopped', phase === 'failed' || phase === 'setup-needed');

  setup.hidden = phase !== 'setup-needed';
  actions.hidden = phase !== 'failed' && phase !== 'attached';
  retryBtn.hidden = phase !== 'failed';
  openlogsBtn.hidden = phase !== 'failed';
  // Manual entry only makes sense once attached but still looking at this page.
  openpanelBtn.hidden = phase !== 'attached';
  logsdetails.hidden = phase !== 'failed';
  if (phase === 'failed') void refreshLogs();
}

async function refreshLogs() {
  if (!invoke) return;
  try {
    logsEl.textContent = (await invoke('shell_logs')) || '(no bridge output captured)';
  } catch {
    logsEl.textContent = '(bridge output unavailable)';
  }
}

async function boot() {
  if (invoke) {
    // Tell the shell where the loader lives, so it can navigate back here later.
    try { await invoke('shell_hello', { url: window.location.href }); } catch { /* cosmetic */ }
    try { render(await invoke('shell_status')); } catch { /* first run races setup */ }
  }

  if (listen) {
    try { await listen('bridge-status', (event) => render(event.payload)); } catch { /* poll below */ }
  }

  // Always poll - events alone are not worth trusting the whole UI to.
  window.setInterval(async () => {
    if (!invoke) return;
    try { render(await invoke('shell_status')); } catch { /* ignore */ }
  }, 1000);
}

setup?.addEventListener('submit', async (event) => {
  event.preventDefault();
  setupError.hidden = true;
  const token = el('token').value.trim();
  const appId = el('appid').value.trim();
  if (!token) {
    setupError.textContent = 'Paste the bot token first.';
    setupError.hidden = false;
    return;
  }
  if (!invoke) {
    setupError.textContent = 'The app runtime is not available - restart the application.';
    setupError.hidden = false;
    return;
  }
  try {
    await invoke('shell_save_setup', { token, appId: appId || null });
    el('save').disabled = true;
    el('save').textContent = 'Starting the bridge…';
  } catch (e) {
    setupError.textContent = String(e ?? 'saving failed');
    setupError.hidden = false;
  }
});

retryBtn?.addEventListener('click', () => { if (invoke) void invoke('shell_retry'); });
openlogsBtn?.addEventListener('click', () => { if (invoke) void invoke('shell_open_logs').catch(() => undefined); });
openpanelBtn?.addEventListener('click', () => { if (invoke) void invoke('shell_open_panel').catch(() => undefined); });

boot();

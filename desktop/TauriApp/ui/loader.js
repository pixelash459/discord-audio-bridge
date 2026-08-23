'use strict';

// The shell injects the Tauri API as window.__TAURI__ (withGlobalTauri), so this stays a
// plain static page with no bundler - the same philosophy as the bridge's own web/ panel.
const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
const listen = tauri?.event?.listen;

const PHASE_TEXT = {
  locating: 'Looking for a running bridge…',
  starting: 'Starting the bridge…',
  attached: 'Connected',
  failed: 'Could not reach the bridge',
};

const spinner = document.getElementById('spinner');
const phaseEl = document.getElementById('phase');
const detailEl = document.getElementById('detail');
const errorbox = document.getElementById('errorbox');
const logsdetails = document.getElementById('logsdetails');
const logsEl = document.getElementById('logs');

function render(status) {
  const phase = String(status?.phase ?? 'locating');
  const detail = String(status?.detail ?? '');

  phaseEl.textContent = PHASE_TEXT[phase] ?? phase;
  detailEl.textContent = detail || 'the control panel will appear here';
  spinner.classList.toggle('stopped', phase === 'failed');

  const failed = phase === 'failed';
  errorbox.hidden = !failed;
  logsdetails.hidden = !failed;
  if (failed) void refreshLogs();
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
  // Tell the shell where the loader lives, so it can navigate back here later.
  if (invoke) {
    try { await invoke('shell_hello', { url: window.location.href }); } catch { /* cosmetic */ }
    try { render(await invoke('shell_status')); } catch { /* first run races setup */ }
  }

  if (listen) {
    try {
      await listen('bridge://status', (event) => render(event.payload));
    } catch { /* keep polling below as the fallback */ }
    window.setInterval(async () => {
      // Only poll while still on the loader; once the panel loads this page is gone.
      try { render(await invoke('shell_status')); } catch { /* ignore */ }
    }, 2000);
  }
}

document.getElementById('retry')?.addEventListener('click', () => {
  if (invoke) void invoke('shell_retry');
});

document.getElementById('openlogs')?.addEventListener('click', () => {
  if (invoke) void invoke('shell_open_logs').catch(() => undefined);
});

boot();

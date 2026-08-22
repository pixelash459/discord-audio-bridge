// Control panel for Discord Audio Bridge.
//
// Plain ES modules, no bundler: everything here runs as-is in WebView2 and any modern browser.
// State flows one way — the server pushes a full snapshot twice a second over the WebSocket and
// render() reconciles the DOM against it, so there is no client-side state to drift out of sync.

const $ = (id) => document.getElementById(id);

/* ── auth ─────────────────────────────────────────────────────────────────── */

// The token arrives in the URL. Stash it and strip it from the address bar so it does not linger
// in history or get copied out of a screenshot.
const token = (() => {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    sessionStorage.setItem('bridge-token', fromUrl);
    url.searchParams.delete('token');
    history.replaceState(null, '', url.pathname + url.hash);
    return fromUrl;
  }
  return sessionStorage.getItem('bridge-token') ?? '';
})();

async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `${response.status} ${response.statusText}`);
  return payload;
}

const post = (path, data) => api(path, { method: 'POST', body: JSON.stringify(data ?? {}) });

/* ── local UI state ───────────────────────────────────────────────────────── */

const ui = {
  sourceKind: 'process',
  selected: null, // { kind, ... , label }
  guildId: null,
  channelId: null,
  sources: { processes: [], devices: [], dshow: [], audioTapBuilt: false },
  guilds: [],
  state: null,
  logFilter: 'info',
  // Suppress snapshot-driven writes while a slider is being dragged.
  dragging: new Set(),
};

const RANK = { error: 0, warn: 1, info: 2, debug: 3 };

/* ── toast ────────────────────────────────────────────────────────────────── */

let toastTimer;
function toast(message, kind = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'error' ? 7000 : 3200);
}

const fail = (error) => toast(error instanceof Error ? error.message : String(error), 'error');

/* ── formatting ───────────────────────────────────────────────────────────── */

function duration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const kbps = (bits) => `${Math.round(bits / 1000)} kbps`;

/** Maps dBFS onto meter width. -60 dB is the floor; below that reads as nothing. */
function meterWidth(db) {
  if (!Number.isFinite(db) || db <= -60) return 0;
  return Math.min(100, ((db + 60) / 60) * 100);
}

const formatDb = (db) => (!Number.isFinite(db) || db <= -99 ? '−∞' : `${db.toFixed(1)}`);

/* ── tabs ─────────────────────────────────────────────────────────────────── */

function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('active', panel.dataset.panel === name);
  }
  if (name === 'setup') void loadConfig();
}

document.querySelector('.tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) showTab(tab.dataset.tab);
});

document.addEventListener('click', (event) => {
  const goto = event.target.closest('[data-goto]');
  if (goto) showTab(goto.dataset.goto);
});

/* ── sources ──────────────────────────────────────────────────────────────── */

const SOURCE_HINTS = {
  process:
    'Captures one application in isolation, at 48 kHz float. Nothing else on the PC leaks in and the app keeps playing to your speakers.',
  device: 'Captures everything playing through one output device.',
  dshow:
    'Captures a DirectShow input such as a virtual cable. Works without AudioTap, but whatever feeds the cable has already been through another app.',
};

document.querySelector('.seg').addEventListener('click', (event) => {
  const button = event.target.closest('.seg-btn');
  if (!button) return;

  ui.sourceKind = button.dataset.source;
  ui.selected = null;
  for (const b of document.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', b === button);
  }
  renderSources();
});

async function loadSources() {
  try {
    ui.sources = await api('sources');
    renderSources();
  } catch (error) {
    fail(error);
  }
}

function renderSources() {
  $('source-hint').textContent = SOURCE_HINTS[ui.sourceKind];
  $('tap-missing').hidden = ui.sources.audioTapBuilt || ui.sourceKind === 'dshow';
  if (ui.state?.capabilities?.platform === 'linux') {
    $('tap-missing-text').textContent =
      'The PipeWire capture tools are missing, so per-app capture is unavailable. Install them on the host (for example, "apt install pipewire-bin"), then restart the bridge.';
  }

  const list = $('source-list');
  list.replaceChildren();

  const items =
    ui.sourceKind === 'process'
      ? ui.sources.processes.map((p) => ({
          key: `process:${p.pid}`,
          label: p.name,
          meta: `pid ${p.pid}`,
          active: p.state === 'AudioSessionStateActive' || p.state === 'Active',
          source: { kind: 'process', pid: p.pid, exclude: false, label: p.name },
        }))
      : ui.sourceKind === 'device'
        ? ui.sources.devices.map((d) => ({
            key: `device:${d.id}`,
            label: `${d.isDefault ? '★ ' : ''}${d.name}`,
            meta: `${d.sampleRate / 1000} kHz`,
            active: false,
            source: { kind: 'device', id: d.id, label: d.name },
          }))
        : ui.sources.dshow.map((d) => ({
            key: `dshow:${d.name}`,
            label: d.name,
            meta: '',
            active: false,
            source: { kind: 'dshow', name: d.name, label: d.name },
          }));

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      ui.sourceKind === 'process'
        ? 'No app is playing audio right now. Start playback and hit Refresh.'
        : 'Nothing found.';
    list.append(empty);
    return;
  }

  for (const item of items) {
    const button = document.createElement('button');
    button.className = 'source';
    button.classList.toggle('selected', ui.selected?.key === item.key);

    if (item.active) {
      const dot = document.createElement('span');
      dot.className = 'playing-dot';
      button.append(dot);
    }

    const name = document.createElement('span');
    name.className = 'source-name';
    name.textContent = item.label;
    button.append(name);

    if (item.meta) {
      const meta = document.createElement('span');
      meta.className = 'source-meta';
      meta.textContent = item.meta;
      button.append(meta);
    }

    button.addEventListener('click', () => {
      ui.selected = item;
      renderSources();
      void startStream();
    });

    list.append(button);
  }
}

/* ── destination ──────────────────────────────────────────────────────────── */

let guildsLoading = false;

async function loadGuilds() {
  if (guildsLoading) return;
  guildsLoading = true;
  try {
    const { guilds } = await api('guilds');
    ui.guilds = guilds;
    renderGuilds();
  } catch (error) {
    fail(error);
  } finally {
    guildsLoading = false;
  }
}

function renderGuilds() {
  const guildSelect = $('guild-select');
  const previous = ui.guildId;

  guildSelect.replaceChildren();
  if (ui.guilds.length === 0) {
    guildSelect.append(new Option('The bot is not in any server yet', ''));
    $('channel-select').replaceChildren(new Option('—', ''));
    return;
  }

  for (const guild of ui.guilds) {
    guildSelect.append(new Option(guild.name, guild.id));
  }

  ui.guildId = ui.guilds.some((g) => g.id === previous) ? previous : ui.guilds[0].id;
  guildSelect.value = ui.guildId;
  renderChannels();
}

function renderChannels() {
  const guild = ui.guilds.find((g) => g.id === ui.guildId);
  const select = $('channel-select');
  const previous = ui.channelId;
  select.replaceChildren();

  const channels = guild?.channels ?? [];
  if (channels.length === 0) {
    select.append(new Option('No voice channels the bot can join', ''));
    ui.channelId = null;
  } else {
    for (const channel of channels) {
      const label =
        `${channel.name} · ${Math.round(channel.bitrate / 1000)} kbps` +
        (channel.members > 0 ? ` · ${channel.members} listening` : '') +
        (channel.joinable ? '' : ' (no permission)');
      const option = new Option(label, channel.id);
      option.disabled = !channel.joinable;
      select.append(option);
    }

    const stillThere = channels.find((c) => c.id === previous && c.joinable);
    ui.channelId = (stillThere ?? channels.find((c) => c.joinable))?.id ?? null;
    if (ui.channelId) select.value = ui.channelId;
  }

  renderChannelHint();
}

function renderChannelHint() {
  const guild = ui.guilds.find((g) => g.id === ui.guildId);
  const channel = guild?.channels.find((c) => c.id === ui.channelId);
  const hint = $('channel-hint');
  const maximize = $('maximize-btn');

  if (!guild || !channel) {
    hint.hidden = true;
    maximize.hidden = true;
    return;
  }

  const atMax = channel.bitrate >= guild.maximumBitrate;
  hint.hidden = false;
  hint.textContent = atMax
    ? `At this server's ceiling of ${Math.round(guild.maximumBitrate / 1000)} kbps (boost tier ${guild.premiumTier}). ` +
      'Raising it further needs more boosts.'
    : `This channel is at ${Math.round(channel.bitrate / 1000)} kbps but the server allows ` +
      `${Math.round(guild.maximumBitrate / 1000)} kbps. Channel bitrate is the single biggest ` +
      'lever on how this sounds.';
  maximize.hidden = atMax;
}

$('guild-select').addEventListener('change', (event) => {
  ui.guildId = event.target.value;
  renderChannels();
});

$('channel-select').addEventListener('change', (event) => {
  ui.channelId = event.target.value;
  renderChannelHint();
});

$('maximize-btn').addEventListener('click', async () => {
  try {
    const result = await post('channel-bitrate', {
      guildId: ui.guildId,
      channelId: ui.channelId,
      bitrate: 0, // 0 means "the server maximum"
    });
    toast(`Channel raised to ${kbps(result.bitrate)}.`, 'ok');
    await loadGuilds();
  } catch (error) {
    fail(error);
  }
});

/* ── streaming ────────────────────────────────────────────────────────────── */

async function startStream() {
  if (!ui.selected) return;
  if (!ui.guildId || !ui.channelId) {
    toast('Pick a server and a voice channel first.', 'error');
    return;
  }

  try {
    await post('stream', {
      guildId: ui.guildId,
      channelId: ui.channelId,
      source: ui.selected.source,
    });
    toast(`Streaming ${ui.selected.label}.`, 'ok');
  } catch (error) {
    fail(error);
  }
}

$('stop-btn').addEventListener('click', async () => {
  try {
    await post('stop', { guildId: ui.state?.sessions[0]?.guildId ?? ui.guildId });
    ui.selected = null;
    renderSources();
    toast('Stopped.');
  } catch (error) {
    fail(error);
  }
});

$('mute-btn').addEventListener('click', async () => {
  const live = session();
  if (!live) return;
  const button = $('mute-btn');
  button.disabled = true;
  try {
    await post('mute', { guildId: live.guildId, muted: !live.muted });
  } catch (error) {
    fail(error);
  } finally {
    button.disabled = false;
  }
});

$('refresh-btn').addEventListener('click', () => void loadSources());

// Sliders: track drag state so incoming snapshots do not yank the thumb, and only commit on release.
for (const [id, handler] of [
  ['gain', (value) => post('gain', { guildId: session()?.guildId, db: value })],
  ['bitrate', (value) => post('bitrate', { guildId: session()?.guildId, bitrate: value * 1000 })],
]) {
  const input = $(id);
  input.addEventListener('pointerdown', () => ui.dragging.add(id));
  input.addEventListener('input', () => {
    if (id === 'gain') $('gain-value').textContent = `${Number(input.value).toFixed(1)} dB`;
    else $('bitrate-value').textContent = `${input.value} kbps`;
  });
  const commit = async () => {
    ui.dragging.delete(id);
    if (!session()) return;
    try {
      await handler(Number(input.value));
    } catch (error) {
      fail(error);
    }
  };
  input.addEventListener('change', commit);
}

const session = () => ui.state?.sessions[0] ?? null;

/* ── render ───────────────────────────────────────────────────────────────── */

function render(state) {
  const becameReady = !ui.state?.bot.ready && state.bot.ready;
  ui.state = state;

  // The WebSocket commonly opens a fraction of a second before Discord's READY event. The first
  // guild request is therefore legitimately empty; refresh it as soon as the ready snapshot lands.
  if (becameReady) void loadGuilds();

  $('log-file-hint').textContent = state.capabilities.logFile
    ? `Live history is also written to ${state.capabilities.logFile}.`
    : 'Disk logging is disabled; this tab contains in-memory history only.';

  $('bot-dot').className = `dot ${state.bot.ready ? 'on' : 'warn'}`;
  $('bot-state').textContent = state.bot.ready ? 'online' : 'connecting';
  $('bot-identity').textContent = state.bot.tag ?? 'not signed in';

  const ping = $('bot-ping');
  ping.hidden = state.bot.wsPing === null;
  if (state.bot.wsPing !== null) ping.textContent = `${state.bot.wsPing} ms`;

  renderOnboarding(state.bot);

  const live = session();
  $('live-card').hidden = !live;
  if (!live) return;

  $('live-source').textContent = live.source.label;
  $('live-channel').textContent = live.channelName;
  $('live-format').textContent = live.captureFormat;
  $('live-uptime').textContent = duration(live.uptimeMs);

  $('stat-bitrate').textContent = kbps(live.bitrate);
  $('stat-muted').textContent = live.muted ? 'muted' : 'live';
  $('mute-btn').textContent = live.muted ? 'Unmute bot' : 'Mute bot';
  $('mute-btn').classList.toggle('danger', !live.muted);
  $('stat-ping').textContent = live.ping === null ? '—' : `${live.ping} ms`;
  $('stat-player').textContent = live.playerState;

  const warning = $('live-warning');
  warning.hidden = !live.qualityNote;
  if (live.qualityNote) warning.textContent = live.qualityNote;

  const tap = live.tap;
  if (tap) {
    $('stat-buffer').textContent = `${tap.bufferMs.toFixed(0)} / ${tap.targetMs.toFixed(0)} ms`;
    $('stat-padded').textContent = `${(tap.paddedMs / 1000).toFixed(1)} s`;
    $('stat-trim').textContent = `${tap.trimmedMs.toFixed(0)} ms`;

    for (const [index, channel] of ['l', 'r'].entries()) {
      const rms = tap.rmsDb?.[index] ?? -100;
      const peak = tap.peakDb?.[index] ?? -100;
      $(`meter-${channel}`).style.width = `${meterWidth(rms)}%`;
      $(`peak-${channel}`).style.left = `${meterWidth(peak)}%`;
      $(`db-${channel}`).textContent = formatDb(peak);
    }
  } else {
    for (const id of ['stat-buffer', 'stat-padded', 'stat-trim']) $(id).textContent = 'n/a';
    for (const channel of ['l', 'r']) {
      $(`meter-${channel}`).style.width = '0%';
      $(`db-${channel}`).textContent = '−∞';
    }
  }

  if (!ui.dragging.has('bitrate')) {
    $('bitrate').max = String(Math.round(live.bitrateCeiling / 1000));
    $('bitrate').value = String(Math.round(live.bitrate / 1000));
    $('bitrate-value').textContent = kbps(live.bitrate);
  }
  if (!ui.dragging.has('gain')) {
    $('gain').value = String(live.gainDb);
    $('gain-value').textContent = `${Number(live.gainDb).toFixed(1)} dB`;
  }
}

/**
 * Before the first successful sign-in the panel is still fully reachable - that is deliberate,
 * since the Setup tab is where the token gets entered. This banner explains what is missing.
 */
function renderOnboarding(bot) {
  const banner = $('onboarding');
  if (bot.ready) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  const action = $('onboarding-action');

  if (bot.signingIn) {
    banner.className = 'banner';
    $('onboarding-title').textContent = 'Signing in to Discord…';
    $('onboarding-detail').textContent = '';
    action.hidden = true;
    return;
  }

  action.hidden = false;

  if (!bot.hasToken) {
    banner.className = 'banner';
    $('onboarding-title').textContent = 'No bot token yet';
    $('onboarding-detail').textContent =
      'Add your bot token and application ID in Setup, then press Save. Nothing else works until then.';
    action.textContent = 'Open Setup';
    action.onclick = () => showTab('setup');
    return;
  }

  banner.className = 'banner error';
  $('onboarding-title').textContent = 'Not signed in to Discord';
  $('onboarding-detail').textContent = bot.signInError ?? 'Sign-in has not been attempted yet.';
  action.textContent = 'Try again';
  action.onclick = () => void attemptSignIn();
}

async function attemptSignIn() {
  try {
    const result = await post('signin');
    toast(result.ready ? `Signed in as ${result.tag}.` : 'Signed in.', 'ok');
    await loadGuilds();
    await loadSources();
  } catch (error) {
    fail(error);
  }
}

/* ── setup tab ────────────────────────────────────────────────────────────── */

let configLoaded = false;

async function loadConfig(force = false) {
  if (configLoaded && !force) return;
  try {
    const config = await api('config');
    for (const [key, value] of Object.entries(config.values)) {
      const input = $(`cfg-${key}`);
      if (input) input.value = value;
    }
    $('token-set').hidden = !config.secretsSet.DISCORD_TOKEN;
    await loadRemoteInfo();
    configLoaded = true;
  } catch (error) {
    fail(error);
  }
}

async function loadRemoteInfo() {
  const container = $('remote-urls');
  container.replaceChildren();
  const info = await api('remote');
  if (!info.enabled) {
    container.textContent = 'Remote control is disabled. Set a non-zero REMOTE_PORT and restart.';
    return;
  }
  for (const url of info.urls) {
    const origin = new URL(url).origin;
    const button = document.createElement('button');
    button.className = 'btn ghost';
    button.textContent = `Copy ${origin}`;
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(url);
      toast(`Copied remote URL for ${origin}.`, 'ok');
    });
    container.append(button);
  }
}

$('save-btn').addEventListener('click', async () => {
  const updates = {};
  for (const input of document.querySelectorAll('[id^="cfg-"]')) {
    const key = input.id.slice(4);
    // A blank token means "leave the saved one alone", not "erase it".
    if (key === 'DISCORD_TOKEN' && input.value.trim() === '') continue;
    updates[key] = input.value.trim();
  }

  try {
    const result = await post('config', updates);
    $('cfg-DISCORD_TOKEN').value = '';
    $('token-set').hidden = !result.secretsSet.DISCORD_TOKEN;

    const notice = $('save-notice');
    if (result.restartRequired?.length) {
      notice.hidden = false;
      notice.textContent =
        `Saved. ${result.restartRequired.join(', ')} ` +
        `${result.restartRequired.length === 1 ? 'takes' : 'take'} effect after restarting the bot. ` +
        'Use Quit app below, then reopen Discord Audio Bridge from Applications.';
    } else {
      notice.hidden = true;
    }
    toast('Settings saved to .env.', 'ok');

    // The common case on a fresh install: a token was just supplied and the bot is idle.
    // Sign in now rather than making the restart notice the user's problem.
    if (!ui.state?.bot.ready && result.secretsSet.DISCORD_TOKEN) {
      notice.hidden = false;
      notice.textContent = 'Saved. Signing in to Discord…';
      await attemptSignIn();
    }
  } catch (error) {
    fail(error);
  }
});

async function runAction(button, path, label) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = `${label}…`;
  try {
    const result = await post(path);
    toast(result.ok ? `${label} succeeded.` : `${label} failed — see the Logs tab.`, result.ok ? 'ok' : 'error');
    if (path.includes('build-native')) await loadSources();
  } catch (error) {
    fail(error);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

$('build-btn').addEventListener('click', (e) => runAction(e.target, 'setup/build-native', 'Build'));
$('register-btn').addEventListener('click', (e) => runAction(e.target, 'setup/register-commands', 'Register'));

$('diag-btn').addEventListener('click', async () => {
  try {
    const { report } = await api('diagnostics');
    const output = $('diag-output');
    output.hidden = false;
    output.textContent = report;
  } catch (error) {
    fail(error);
  }
});

$('quit-btn').addEventListener('click', async () => {
  if (!window.confirm('Quit Discord Audio Bridge? Active streams will stop.')) return;
  try {
    await post('app/quit');
    toast('Discord Audio Bridge is shutting down.', 'ok');
  } catch (error) {
    fail(error);
  }
});

/* ── logs ─────────────────────────────────────────────────────────────────── */

$('log-filter').addEventListener('change', (event) => {
  ui.logFilter = event.target.value;
  for (const line of document.querySelectorAll('.log-line')) {
    line.hidden = RANK[line.dataset.level] > RANK[ui.logFilter];
  }
});

$('log-clear').addEventListener('click', () => $('log').replaceChildren());

function appendLog(entry) {
  const log = $('log');
  // Only autoscroll when already pinned to the bottom, so reading history is not interrupted.
  const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 40;

  const line = document.createElement('div');
  line.className = `log-line ${entry.level}`;
  line.dataset.level = entry.level;
  line.hidden = RANK[entry.level] > RANK[ui.logFilter];

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date(entry.at).toTimeString().slice(0, 8);

  const scope = document.createElement('span');
  scope.className = 'log-scope';
  scope.textContent = entry.scope;

  const message = document.createElement('span');
  message.className = 'log-msg';
  message.textContent = entry.extra ? `${entry.message} ${entry.extra}` : entry.message;

  line.append(time, scope, message);
  log.append(line);

  while (log.childElementCount > 1000) log.firstElementChild.remove();
  if (pinned) log.scrollTop = log.scrollHeight;
}

/* ── websocket ────────────────────────────────────────────────────────────── */

let socket;
let retryDelay = 500;

function connect() {
  socket = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);

  socket.addEventListener('open', () => {
    retryDelay = 500;
    $('disconnected').hidden = true;
    void loadGuilds();
    void loadSources();
  });

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'state') render(payload.state);
    else if (payload.type === 'log') appendLog(payload.entry);
    else if (payload.type === 'history') {
      $('log').replaceChildren();
      for (const entry of payload.entries) appendLog(entry);
    }
  });

  socket.addEventListener('close', () => {
    $('disconnected').hidden = false;
    $('disconnected-detail').textContent = token
      ? 'Reconnecting to the control server…'
      : 'No control token. Open the URL printed in the terminal.';
    // Back off to 5s so a stopped bot does not spin the connection forever.
    retryDelay = Math.min(retryDelay * 1.6, 5000);
    setTimeout(connect, retryDelay);
  });

  socket.addEventListener('error', () => socket.close());
}

connect();

// The process list goes stale as apps come and go; a slow poll keeps it honest without hammering
// AudioTap, which spawns a process on every enumeration.
setInterval(() => {
  if (document.visibilityState === 'visible' && socket?.readyState === WebSocket.OPEN) {
    void loadSources();
  }
}, 10_000);

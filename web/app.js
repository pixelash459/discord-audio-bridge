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
  const fragment = new URLSearchParams(url.hash.slice(1));
  const fromUrl = fragment.get('token') ?? url.searchParams.get('token');
  if (fromUrl) {
    sessionStorage.setItem('bridge-token', fromUrl);
    url.searchParams.delete('token');
    url.hash = '';
    history.replaceState(null, '', url.pathname + url.search);
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
  /** Selected source keys, in the order they were picked: that order is the mixer's lane order. */
  selected: [],
  mixing: false,
  filter: '',
  guildId: null,
  channelId: null,
  sources: { processes: [], devices: [], dshow: [], audioTapBuilt: false, sourceError: null },
  guilds: [],
  presets: [],
  state: null,
  logFilter: 'info',
  logSearch: '',
  // Suppress snapshot-driven writes while a control is being dragged or edited.
  dragging: new Set(),
};

const RANK = { error: 0, warn: 1, info: 2, debug: 3 };

let artworkTrackKey = '';
let artwork = null;
let artworkRequest = 0;

const trackKey = (track) =>
  track ? [track.appId, track.title, track.artist, track.album].map((part) => part ?? '').join('\u001f') : '';

function setArtwork(element, track) {
  const value = trackKey(track) === artworkTrackKey ? artwork : null;
  if (value) {
    element.src = `data:image/png;base64,${value}`;
    element.hidden = false;
  } else {
    element.hidden = true;
    element.removeAttribute('src');
  }
}

function refreshArtworkViews() {
  if (!ui.state) return;
  setArtwork($('host-art'), ui.state.nowPlaying);
  for (const session of ui.state.sessions) {
    const card = cards.get(session.guildId);
    if (card) setArtwork(card.querySelector('.session-art'), session.nowPlaying);
  }
}

function ensureArtwork(track) {
  const key = trackKey(track);
  if (key === artworkTrackKey) return;
  artworkTrackKey = key;
  artwork = null;
  const request = ++artworkRequest;
  refreshArtworkViews();
  if (!key) return;

  void api('now-playing')
    .then(({ nowPlaying: current }) => {
      if (request !== artworkRequest || trackKey(current) !== artworkTrackKey) return;
      artwork = current?.artwork ?? null;
      refreshArtworkViews();
    })
    .catch(() => {
      /* Artwork is optional; the metadata and controls remain useful without it. */
    });
}

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

/**
 * Clipboard access can be unavailable in WebView runtimes or blocked by Firefox permissions.
 * Keep a selection-based fallback so every packaged build still has a working Copy button.
 */
async function copyText(text) {
  if (!text) throw new Error('There is nothing to copy yet.');
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection-based path below.
    }
  }

  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.inset = '-10000px auto auto -10000px';
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Copy was blocked. Use Download report instead.');
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Firefox may not have consumed the object URL by the time click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const reportTimestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/* ── formatting ───────────────────────────────────────────────────────────── */

function duration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const kbps = (bits) => `${Math.round(bits / 1000)} kbps`;

/**
 * Maps dBFS onto meter width.
 *
 * Not linear in dB: the range that matters for music is roughly -24..0, and a straight -60..0 map
 * squashes all of it into the last third of the bar. Weighting the top end gives the part people
 * actually read most of the width, which is what a hardware meter does too.
 */
function meterWidth(db) {
  if (!Number.isFinite(db) || db <= -60) return 0;
  const normalised = Math.min(1, Math.max(0, (db + 60) / 60));
  return Math.min(100, Math.pow(normalised, 1.7) * 100);
}

const formatDb = (db) => (!Number.isFinite(db) || db <= -99 ? '−∞' : `${db.toFixed(1)}`);

function trackTitle(track) {
  if (!track?.title) return null;
  return track.artist ? `${track.artist} — ${track.title}` : track.title;
}

/* ── tabs ─────────────────────────────────────────────────────────────────── */

function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
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

document.querySelector('.tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('.tab')];
  const current = tabs.indexOf(document.activeElement);
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  showTab(tabs[next].dataset.tab);
});

document.addEventListener('click', (event) => {
  const goto = event.target.closest('[data-goto]');
  if (goto) showTab(goto.dataset.goto);
});

/* ── keyboard shortcuts ───────────────────────────────────────────────────── */

// A background audio tool should not need the mouse for the two things you do most.
document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === '/' && !typing) {
    event.preventDefault();
    showTab('stream');
    $('source-filter').focus();
    return;
  }
  if (typing) return;

  if (['1', '2', '3'].includes(event.key)) {
    showTab({ 1: 'stream', 2: 'setup', 3: 'logs' }[event.key]);
    return;
  }

  const live = primarySession();
  if (!live) return;
  if (event.key.toLowerCase() === 'm') {
    event.preventDefault();
    void post('mute', { guildId: live.guildId, muted: !live.muted }).catch(fail);
  }
  if (event.key.toLowerCase() === 's') {
    event.preventDefault();
    void post('stop', { guildId: live.guildId }).then(() => toast('Stopped.')).catch(fail);
  }
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
  ui.selected = [];
  for (const b of document.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', b === button);
    b.setAttribute('aria-pressed', String(b === button));
  }
  renderSources();
});

$('source-filter').addEventListener('input', (event) => {
  ui.filter = event.target.value.trim().toLowerCase();
  renderSources();
});

$('mix-toggle').addEventListener('change', (event) => {
  ui.mixing = event.target.checked;
  // Cable inputs go straight into ffmpeg and never reach the summing stage, so they cannot mix.
  if (ui.mixing && ui.sourceKind === 'dshow') ui.selected = ui.selected.slice(0, 1);
  if (!ui.mixing) ui.selected = ui.selected.slice(0, 1);
  renderSources();
});

async function loadSources() {
  const refresh = $('refresh-btn');
  refresh.disabled = true;
  refresh.textContent = 'Refreshing…';
  try {
    // Nudge the resident monitor first so the list we then read is genuinely current.
    await post('sources/refresh').catch(() => undefined);
    ui.sources = await api('sources');
    renderSources();
  } catch (error) {
    fail(error);
  } finally {
    refresh.disabled = false;
    refresh.textContent = 'Refresh sources';
  }
}

function availableItems() {
  if (ui.sourceKind === 'process') {
    return ui.sources.processes.map((p) => ({
      key: `process:${p.pid}`,
      label: p.displayName || p.name,
      meta: `pid ${p.pid}`,
      icon: p.icon ?? null,
      active: p.state === 'AudioSessionStateActive' || p.state === 'Active',
      source: { kind: 'process', pid: p.pid, processName: p.name, exclude: false, label: p.displayName || p.name },
    }));
  }
  if (ui.sourceKind === 'device') {
    return ui.sources.devices.map((d) => ({
      key: `device:${d.id}`,
      label: `${d.isDefault ? '★ ' : ''}${d.name}`,
      meta: `${d.sampleRate / 1000} kHz`,
      icon: null,
      active: false,
      source: { kind: 'device', id: d.id, label: d.name },
    }));
  }
  return ui.sources.dshow.map((d) => ({
    key: `dshow:${d.name}`,
    label: d.name,
    meta: '',
    icon: null,
    active: false,
    source: { kind: 'dshow', name: d.name, label: d.name },
  }));
}

function renderSources() {
  $('source-hint').textContent = SOURCE_HINTS[ui.sourceKind];
  $('tap-missing').hidden = ui.sources.audioTapBuilt || ui.sourceKind === 'dshow';

  const mixable = ui.sourceKind !== 'dshow';
  $('mix-toggle').disabled = !mixable;
  $('mix-hint').hidden = !(ui.mixing && mixable);

  const list = $('source-list');
  list.replaceChildren();

  const all = availableItems();
  const items = ui.filter
    ? all.filter((item) => item.label.toLowerCase().includes(ui.filter) || item.meta.toLowerCase().includes(ui.filter))
    : all;

  // Drop selections whose source has gone away, but keep the order of the ones that remain.
  const keys = new Set(all.map((item) => item.key));
  ui.selected = ui.selected.filter((key) => keys.has(key));

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = ui.sources.sourceError
      ? ui.sources.sourceError
      : ui.filter
      ? `Nothing matches “${ui.filter}”.`
      : ui.sourceKind === 'process'
        ? 'No app is playing audio right now. Start playback and hit Refresh.'
        : 'Nothing found.';
    list.append(empty);
    updateStartButton();
    return;
  }

  for (const item of items) {
    const position = ui.selected.indexOf(item.key);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'source';
    button.classList.toggle('selected', position >= 0);
    button.setAttribute('aria-pressed', String(position >= 0));

    if (item.icon) {
      const icon = document.createElement('img');
      icon.className = 'source-icon';
      icon.alt = '';
      icon.src = `data:image/png;base64,${item.icon}`;
      button.append(icon);
    } else if (item.active) {
      const dot = document.createElement('span');
      dot.className = 'playing-dot';
      button.append(dot);
    }

    const name = document.createElement('span');
    name.className = 'source-name';
    name.textContent = item.label;
    button.append(name);

    if (item.active && item.icon) {
      const playing = document.createElement('span');
      playing.className = 'playing-dot inline';
      button.append(playing);
    }

    if (item.meta) {
      const meta = document.createElement('span');
      meta.className = 'source-meta';
      meta.textContent = item.meta;
      button.append(meta);
    }

    // In mix mode the badge is the lane number, which is also the order the mixer will use.
    if (ui.mixing && position >= 0) {
      const badge = document.createElement('span');
      badge.className = 'source-badge';
      badge.textContent = String(position + 1);
      button.append(badge);
    }

    button.addEventListener('click', () => {
      if (!ui.mixing) {
        ui.selected = position >= 0 ? [] : [item.key];
      } else if (position >= 0) {
        ui.selected.splice(position, 1);
      } else if (ui.selected.length >= 4) {
        toast('Four sources is the limit for one mix.', 'error');
        return;
      } else {
        ui.selected.push(item.key);
      }
      renderSources();
    });

    list.append(button);
  }
  updateStartButton();
}

function selectedSources() {
  const byKey = new Map(availableItems().map((item) => [item.key, item]));
  return ui.selected.map((key) => byKey.get(key)).filter(Boolean);
}

function updateStartButton() {
  const button = $('start-btn');
  const chosen = selectedSources();
  const ready = chosen.length > 0 && ui.guildId && ui.channelId;
  button.disabled = !ready;
  button.textContent =
    chosen.length === 0
      ? 'Choose a source'
      : primarySession()
        ? 'Apply route'
        : chosen.length > 1
          ? `Start mix of ${chosen.length}`
          : 'Start stream';
  $('save-route-btn').disabled = !primarySession();
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
  $('no-guilds').hidden = ui.guilds.length > 0;

  if (ui.guilds.length === 0) {
    guildSelect.append(new Option('The bot is not in any server yet', ''));
    $('channel-select').replaceChildren(new Option('—', ''));
    guildSelect.disabled = true;
    $('channel-select').disabled = true;
    ui.guildId = null;
    ui.channelId = null;
    updateStartButton();
    return;
  }

  guildSelect.disabled = false;

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
    select.disabled = true;
  } else {
    for (const channel of channels) {
      const label =
        `${channel.name} · ${Math.round(channel.bitrate / 1000)} kbps` +
        (channel.members > 0 ? ` · ${channel.members} listening` : '') +
        (channel.joinable ? '' : ` (${channel.unavailableReason ?? 'unavailable'})`);
      const option = new Option(label, channel.id);
      option.disabled = !channel.joinable;
      select.append(option);
    }

    const stillThere = channels.find((c) => c.id === previous && c.joinable);
    ui.channelId = (stillThere ?? channels.find((c) => c.joinable))?.id ?? null;
    if (ui.channelId) select.value = ui.channelId;
    select.disabled = !ui.channelId;
  }

  renderChannelHint();
  updateStartButton();
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
  updateStartButton();
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
  const chosen = selectedSources();
  if (chosen.length === 0) return;
  if (!ui.guildId || !ui.channelId) {
    toast('Pick a server and a voice channel first.', 'error');
    return;
  }

  try {
    await post('stream', {
      guildId: ui.guildId,
      channelId: ui.channelId,
      sources: chosen.map((item) => item.source),
    });
    toast(`Streaming ${chosen.map((item) => item.label).join(' + ')}.`, 'ok');
  } catch (error) {
    fail(error);
  }
}

$('start-btn').addEventListener('click', () => void startStream());
$('refresh-btn').addEventListener('click', () => void loadSources());

const primarySession = () => {
  const sessions = ui.state?.sessions ?? [];
  return (ui.guildId ? sessions.find((item) => item.guildId === ui.guildId) : null) ?? sessions[0] ?? null;
};

/* ── saved routes ─────────────────────────────────────────────────────────── */

async function loadPresets() {
  try {
    ui.presets = (await api('presets')).presets ?? [];
    renderPresets();
  } catch (error) {
    fail(error);
  }
}

function renderPresets() {
  const list = $('preset-list');
  list.replaceChildren();

  if (ui.presets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = 'No saved routes yet. Start a stream, then press “Save current route”.';
    list.append(empty);
    return;
  }

  for (const preset of ui.presets) {
    const chip = document.createElement('div');
    chip.className = 'preset';

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'preset-apply';
    apply.textContent = preset.name;

    const detail = document.createElement('span');
    detail.className = 'preset-detail';
    detail.textContent = `${preset.sources.map((source) => source.label).join(' + ')} · ${
      preset.bitrate ? kbps(preset.bitrate) : 'channel bitrate'
    }`;
    apply.append(detail);

    apply.addEventListener('click', async () => {
      apply.disabled = true;
      try {
        const result = await post('presets/apply', { id: preset.id });
        ui.presets = result.presets ?? ui.presets;
        renderPresets();
        toast(`Applied “${preset.name}”.`, 'ok');
      } catch (error) {
        fail(error);
      } finally {
        apply.disabled = false;
      }
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'preset-delete';
    remove.title = `Delete ${preset.name}`;
    remove.setAttribute('aria-label', `Delete ${preset.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', async () => {
      try {
        const result = await post('presets/delete', { id: preset.id });
        ui.presets = result.presets ?? [];
        renderPresets();
      } catch (error) {
        fail(error);
      }
    });

    chip.append(apply, remove);
    list.append(chip);
  }
}

$('save-route-btn').addEventListener('click', async () => {
  const live = primarySession();
  if (!live) return;
  const suggestion = `${live.source.label} → ${live.channelName}`;
  const name = prompt('Name this route', suggestion.slice(0, 60));
  if (!name) return;
  try {
    await post('presets', { name, guildId: live.guildId });
    await loadPresets();
    toast(`Saved “${name}”.`, 'ok');
  } catch (error) {
    fail(error);
  }
});

/* ── live session cards ───────────────────────────────────────────────────── */

const cards = new Map();
/** 60 seconds of buffer-fill and ping per guild, for the trend strip. */
// Do not call this `history`: that shadows window.history across the entire module and makes token
// scrubbing throw before any controls have registered their event handlers.
const sessionHistory = new Map();

function trendFor(guildId) {
  let series = sessionHistory.get(guildId);
  if (!series) {
    series = { buffer: [], ping: [] };
    sessionHistory.set(guildId, series);
  }
  return series;
}

function drawTrend(canvas, series) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);

  const styles = getComputedStyle(document.body);
  const line = (values, colour, max) => {
    if (values.length < 2) return;
    context.strokeStyle = colour;
    context.lineWidth = 1.5;
    context.beginPath();
    values.forEach((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - Math.min(1, value / max) * (height - 4) - 2;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  };

  line(series.buffer, styles.getPropertyValue('--accent').trim() || '#6874f7', 400);
  line(series.ping, styles.getPropertyValue('--warn').trim() || '#faa61a', 200);
}

function buildCard(guildId) {
  const node = $('session-template').content.firstElementChild.cloneNode(true);
  const pick = (selector) => node.querySelector(selector);

  pick('.stop-btn').addEventListener('click', async () => {
    try {
      await post('stop', { guildId });
      toast('Stopped.');
    } catch (error) {
      fail(error);
    }
  });

  pick('.mute-btn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const live = (ui.state?.sessions ?? []).find((item) => item.guildId === guildId);
      await post('mute', { guildId, muted: !live?.muted });
    } catch (error) {
      fail(error);
    } finally {
      button.disabled = false;
    }
  });

  pick('.preview-btn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const live = (ui.state?.sessions ?? []).find((item) => item.guildId === guildId);
    button.disabled = true;
    try {
      await post('preview', { guildId, enabled: !live?.previewing });
      toast(live?.previewing ? 'Monitoring stopped.' : 'Monitoring on this PC.', 'ok');
    } catch (error) {
      fail(error);
    } finally {
      button.disabled = false;
    }
  });

  pick('.loudness').addEventListener('change', async (event) => {
    try {
      await post('loudness', { guildId, mode: event.target.value });
      toast(`Loudness set to ${event.target.value}.`, 'ok');
    } catch (error) {
      fail(error);
    }
  });

  // Sliders: track drag state so incoming snapshots do not yank the thumb, and commit on release.
  for (const [selector, handler, format] of [
    ['.gain', (value) => post('gain', { guildId, db: value }), (input, card) => {
      card.querySelector('.gain-value').textContent = `${Number(input.value).toFixed(1)} dB`;
    }],
    ['.bitrate', (value) => post('bitrate', { guildId, bitrate: value * 1000 }), (input, card) => {
      card.querySelector('.bitrate-value').textContent = `${input.value} kbps`;
    }],
  ]) {
    const input = pick(selector);
    const key = `${guildId}${selector}`;
    input.addEventListener('pointerdown', () => ui.dragging.add(key));
    input.addEventListener('input', () => format(input, node));
    input.addEventListener('change', async () => {
      ui.dragging.delete(key);
      try {
        await handler(Number(input.value));
      } catch (error) {
        fail(error);
      }
    });
  }

  $('sessions').append(node);
  cards.set(guildId, node);
  return node;
}

function renderMixInputs(card, session) {
  const container = card.querySelector('.mix-inputs');
  const mix = session.mix;
  if (!mix || mix.length < 2) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }

  container.hidden = false;
  // Rebuild only when the shape changes; otherwise just refresh the numbers, so a slider being
  // dragged is not replaced underneath the pointer.
  if (container.childElementCount !== mix.length) {
    container.replaceChildren();
    mix.forEach((input, index) => {
      const row = document.createElement('label');
      row.className = 'control mix-input';

      const label = document.createElement('span');
      label.className = 'label';
      label.append(document.createTextNode(`${input.label} `));
      const value = document.createElement('span');
      value.className = 'mix-value';
      label.append(value);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '-60';
      slider.max = '20';
      slider.step = '0.5';
      slider.className = 'mix-gain';

      const key = `${session.guildId}:mix:${index}`;
      slider.addEventListener('pointerdown', () => ui.dragging.add(key));
      slider.addEventListener('input', () => (value.textContent = `${Number(slider.value).toFixed(1)} dB`));
      slider.addEventListener('change', async () => {
        ui.dragging.delete(key);
        try {
          await post('input-gain', { guildId: session.guildId, index, db: Number(slider.value) });
        } catch (error) {
          fail(error);
        }
      });

      row.append(label, slider);
      container.append(row);
    });
  }

  mix.forEach((input, index) => {
    const row = container.children[index];
    if (!row) return;
    row.classList.toggle('stopped', !input.live);
    if (ui.dragging.has(`${session.guildId}:mix:${index}`)) return;
    row.querySelector('.mix-gain').value = String(input.gainDb);
    row.querySelector('.mix-value').textContent = `${input.gainDb.toFixed(1)} dB${input.live ? '' : ' · stopped'}`;
  });
}

function renderSession(session) {
  const card = cards.get(session.guildId) ?? buildCard(session.guildId);
  const pick = (selector) => card.querySelector(selector);
  const track = trackTitle(session.nowPlaying);

  pick('.session-source').textContent = track ?? session.sources.map((s) => s.label).join(' + ');
  pick('.session-sub').textContent = track
    ? `${session.sources.map((s) => s.label).join(' + ')} → ${session.channelName}`
    : `into ${session.channelName}`;

  setArtwork(pick('.session-art'), session.nowPlaying);

  const listeners = pick('.listeners');
  listeners.hidden = session.listeners <= 0;
  listeners.textContent = `${session.listeners} listening`;

  pick('.live-channel').textContent = session.channelName;
  pick('.live-format').textContent = session.captureFormat;
  pick('.live-uptime').textContent = duration(session.uptimeMs);
  pick('.stat-player').textContent = session.playerState;

  pick('.stat-bitrate').textContent = kbps(session.bitrate);
  pick('.stat-muted').textContent = session.muted ? 'muted' : 'live';
  const preview = pick('.preview-btn');
  preview.classList.toggle('primary', session.previewing);
  preview.setAttribute('aria-pressed', String(session.previewing));
  preview.textContent = session.previewing ? 'Monitoring' : 'Monitor';

  pick('.mute-btn').textContent = session.muted ? 'Unmute bot' : 'Mute bot';
  pick('.mute-btn').classList.toggle('danger', !session.muted);
  pick('.stat-ping').textContent = session.ping === null ? '—' : `${session.ping} ms`;
  pick('.stat-restarts').textContent = session.restarts === 0 ? 'none' : String(session.restarts);

  const quality = pick('.quality-note');
  quality.hidden = !session.qualityNote;
  if (session.qualityNote) quality.textContent = session.qualityNote;

  const tap = session.tap;
  // These three were computed by the capture helper all along and never shown: a clipping signal
  // and a silent source are the two failures people actually hit, and both were invisible.
  pick('.clip-note').hidden = !tap?.clipping;
  pick('.silent-note').hidden = !(tap?.silent && session.uptimeMs > 5_000);

  if (tap) {
    pick('.stat-buffer').textContent =
      `${tap.bufferMs.toFixed(0)} / ${tap.targetMs.toFixed(0)} ms${tap.primed ? '' : ' · buffering'}`;
    pick('.stat-padded').textContent = `${(tap.paddedMs / 1000).toFixed(1)} s`;
    pick('.stat-trim').textContent = `${tap.trimmedMs.toFixed(0)} ms`;
    pick('.stat-dropped').textContent = tap.droppedMs > 0 ? `${tap.droppedMs.toFixed(0)} ms` : 'none';

    for (const [index, channel] of ['l', 'r'].entries()) {
      const rms = tap.rmsDb?.[index] ?? -100;
      const peak = tap.peakDb?.[index] ?? -100;
      const meter = pick(`.meter-${channel}`);
      meter.style.width = `${meterWidth(rms)}%`;
      meter.classList.toggle('hot', peak > -3);
      pick(`.peak-${channel}`).style.left = `${meterWidth(peak)}%`;
      pick(`.db-${channel}`).textContent = formatDb(peak);
      pick(`.db-${channel}`).classList.toggle('clipping', peak >= -0.1);
      meter.closest('.meter').setAttribute('aria-valuenow', String(Math.round(Math.max(peak, -60))));
    }
  } else {
    for (const id of ['.stat-buffer', '.stat-padded', '.stat-trim', '.stat-dropped']) {
      pick(id).textContent = 'n/a';
    }
    for (const channel of ['l', 'r']) {
      pick(`.meter-${channel}`).style.width = '0%';
      pick(`.db-${channel}`).textContent = '−∞';
    }
  }

  const series = trendFor(session.guildId);
  series.buffer.push(tap?.bufferMs ?? 0);
  series.ping.push(session.ping ?? 0);
  // Snapshots arrive twice a second, so 120 samples is the advertised minute.
  if (series.buffer.length > 120) series.buffer.shift();
  if (series.ping.length > 120) series.ping.shift();
  drawTrend(pick('.trend-canvas'), series);

  renderMixInputs(card, session);

  const bitrate = pick('.bitrate');
  if (!ui.dragging.has(`${session.guildId}.bitrate`)) {
    bitrate.max = String(Math.round(session.bitrateCeiling / 1000));
    bitrate.value = String(Math.round(session.bitrate / 1000));
    pick('.bitrate-value').textContent = kbps(session.bitrate);
  }
  if (!ui.dragging.has(`${session.guildId}.gain`)) {
    pick('.gain').value = String(session.gainDb);
    pick('.gain-value').textContent = `${Number(session.gainDb).toFixed(1)} dB`;
  }
  if (document.activeElement !== pick('.loudness')) pick('.loudness').value = session.loudness;
}

function renderSessions(sessions) {
  const live = new Set(sessions.map((session) => session.guildId));
  for (const [guildId, card] of cards) {
    if (!live.has(guildId)) {
      card.remove();
      cards.delete(guildId);
      sessionHistory.delete(guildId);
    }
  }
  for (const session of sessions) renderSession(session);
}

/* ── render ───────────────────────────────────────────────────────────────── */

function syncPresenceToggles(presence) {
  if (!presence) return;
  const activity = $('presence-activity');
  const channel = $('presence-channel');
  // Avoid fighting the user while they click; only push when values differ.
  if (activity && !activity.matches(':focus') && activity.checked !== presence.activity) {
    activity.checked = presence.activity;
  }
  if (channel && !channel.matches(':focus') && channel.checked !== presence.channelStatus) {
    channel.checked = presence.channelStatus;
  }
  const cfgActivity = $('cfg-PRESENCE_ACTIVITY');
  const cfgChannel = $('cfg-PRESENCE_CHANNEL_STATUS');
  if (cfgActivity && document.activeElement !== cfgActivity) {
    cfgActivity.value = presence.activity ? 'true' : 'false';
  }
  if (cfgChannel && document.activeElement !== cfgChannel) {
    cfgChannel.value = presence.channelStatus ? 'true' : 'false';
  }
}

async function setPresenceFlag(key, enabled) {
  try {
    await post('config', { [key]: enabled ? 'true' : 'false' });
    if (ui.state?.presence) {
      if (key === 'PRESENCE_ACTIVITY') ui.state.presence.activity = enabled;
      if (key === 'PRESENCE_CHANNEL_STATUS') ui.state.presence.channelStatus = enabled;
    }
    toast(
      key === 'PRESENCE_ACTIVITY'
        ? enabled
          ? 'Showing under the bot.'
          : 'Hidden under the bot.'
        : enabled
          ? 'Showing on the voice channel.'
          : 'Hidden on the voice channel.',
      'ok',
    );
  } catch (error) {
    fail(error);
    syncPresenceToggles(ui.state?.presence);
  }
}

$('presence-activity').addEventListener('change', (event) => {
  void setPresenceFlag('PRESENCE_ACTIVITY', event.target.checked);
});
$('presence-channel').addEventListener('change', (event) => {
  void setPresenceFlag('PRESENCE_CHANNEL_STATUS', event.target.checked);
});

function render(state) {
  const becameReady = !ui.state?.bot.ready && state.bot.ready;
  ui.state = state;
  ensureArtwork(state.nowPlaying);

  // The WebSocket commonly opens a fraction of a second before Discord's READY event. The first
  // guild request is therefore legitimately empty; refresh it as soon as the ready snapshot lands.
  if (becameReady) {
    void loadGuilds();
    void loadPresets();
  }

  $('log-file-hint').textContent = state.capabilities.logFile
    ? `Live history is also written to ${state.capabilities.logFile}.`
    : 'Disk logging is disabled; this tab contains in-memory history only.';

  $('bot-dot').className = `dot ${state.bot.ready ? 'on' : 'warn'}`;
  $('bot-state').textContent = state.bot.ready ? 'online' : 'connecting';
  $('bot-identity').textContent = state.bot.tag ?? 'not signed in';

  syncPresenceToggles(state.presence);

  const ping = $('bot-ping');
  ping.hidden = state.bot.wsPing === null;
  if (state.bot.wsPing !== null) ping.textContent = `${state.bot.wsPing} ms`;

  // What the PC is playing, whether or not it is the thing being captured.
  const hostTrack = trackTitle(state.nowPlaying);
  $('host-track').hidden = !hostTrack;
  if (hostTrack) {
    $('host-track-title').textContent = hostTrack;
    setArtwork($('host-art'), state.nowPlaying);
  }

  for (const element of [$('invite-btn'), $('invite-link')]) {
    element.hidden = !state.inviteUrl;
    if (state.inviteUrl) element.href = state.inviteUrl;
  }

  const stale = renderStaleBuild(state.version);
  renderWizard(state, stale);
  renderOnboarding(state.bot);
  renderSessions(state.sessions);
  updateStartButton();
}

/* ── build mismatch ───────────────────────────────────────────────────────── */

/**
 * Detects an old server process serving new files.
 *
 * The panel is static HTML read from disk on every request; the endpoints it calls are compiled
 * into the running executable. Upgrading in place therefore replaces this file while leaving the
 * old server running until it is restarted, and the only symptom is newer JavaScript calling
 * routes the old build has never heard of - which arrives as a stream of unexplained 404 toasts
 * rather than as "restart me". Saying so directly is the entire fix.
 */
function renderStaleBuild(version) {
  const banner = $('stale-build');
  if (!version || !version.stale) {
    banner.hidden = true;
    return false;
  }

  banner.hidden = false;
  $('stale-detail').textContent =
    `This panel comes from version ${version.assets}, but the bridge that is running is ` +
    `version ${version.running}. The upgrade replaced the files on disk without restarting the ` +
    'process, so newer controls are calling endpoints the running build does not have. Quit ' +
    'Discord Audio Bridge and start it again.';
  return true;
}

/* ── first-run wizard ─────────────────────────────────────────────────────── */

/**
 * The guided path for a fresh clone.
 *
 * A one-line banner is the right shape for a problem that appears later, and the wrong shape for
 * someone who has four unrelated things left to do and no idea what order they go in. The step is
 * derived from server state rather than remembered locally, so it cannot claim a step is done when
 * it is not - and dismissing it is sticky, because being told how to set up software you already
 * set up is worse than no help at all.
 */
const WIZARD_DISMISSED = 'bridge-wizard-dismissed';

let wizardDismissed = (() => {
  try {
    return localStorage.getItem(WIZARD_DISMISSED) === '1';
  } catch {
    return false;
  }
})();

function dismissWizard() {
  wizardDismissed = true;
  try {
    localStorage.setItem(WIZARD_DISMISSED, '1');
  } catch {
    /* private mode; it simply reappears next launch */
  }
  $('wizard').hidden = true;
}

/** Which step still needs doing, or 0 when there is nothing left. */
function wizardStep(state) {
  if (!state.bot.hasToken) return 1;
  if (!state.bot.ready) return 1;
  if ((state.sessions.length === 0 && ui.guilds.length === 0) || state.bot.guildCount === 0) return 2;
  if (state.capabilities.platform === 'win32' && !state.capabilities.audioTapBuilt) return 3;
  return 0;
}

function renderWizard(state, stale = false) {
  const wizard = $('wizard');
  const step = wizardStep(state);

  // Never reopen once dismissed, never open for an install that is already working, and never
  // walk someone through setup against a server that is about to be restarted anyway.
  if (stale || wizardDismissed || (step === 0 && wizard.hidden)) {
    wizard.hidden = true;
    return;
  }

  wizard.hidden = false;
  const pane = step === 0 ? 4 : step;

  for (const section of wizard.querySelectorAll('.wizard-pane')) {
    section.hidden = Number(section.dataset.pane) !== pane;
  }
  for (const item of wizard.querySelectorAll('.wizard-steps li')) {
    const index = Number(item.dataset.step);
    item.classList.toggle('done', step === 0 || index < step);
    item.classList.toggle('current', index === step);
  }

  if (pane === 2) {
    $('wizard-tag').textContent = state.bot.tag ?? 'the bot';
    if (state.inviteUrl) $('wizard-invite').href = state.inviteUrl;
  }
  if (pane === 3 && state.capabilities.platform !== 'win32') {
    $('wizard-capture-text').textContent =
      'This build is Windows-only. Per-application capture needs AudioTap on a Windows host.';
    $('wizard-build').hidden = true;
  }
}

$('wizard-save').addEventListener('click', async () => {
  const button = $('wizard-save');
  const error = $('wizard-error');
  const token = $('wizard-token').value.trim();

  error.hidden = true;
  if (!token) {
    error.hidden = false;
    error.textContent = 'Paste the bot token to continue.';
    return;
  }

  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    await post('config', { DISCORD_TOKEN: token });
    $('wizard-token').value = '';
    await post('signin');
    configLoaded = false;
    await Promise.all([refreshState(), loadGuilds(), loadSources()]);
    toast('Signed in.', 'ok');
  } catch (failure) {
    error.hidden = false;
    error.textContent = failure instanceof Error ? failure.message : String(failure);
  } finally {
    button.disabled = false;
    button.textContent = 'Save and sign in';
  }
});

$('wizard-build').addEventListener('click', async (event) => {
  await runAction(event.target, 'setup/build-native', 'Build');
  await refreshState().catch(() => undefined);
});

$('wizard-done').addEventListener('click', () => {
  dismissWizard();
  showTab('stream');
});

for (const id of ['wizard-skip', 'wizard-skip-2', 'wizard-skip-3']) {
  $(id).addEventListener('click', dismissWizard);
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
    await Promise.all([loadGuilds(), loadSources(), loadPresets()]);
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
    button.type = 'button';
    button.textContent = `Copy ${origin}`;
    button.addEventListener('click', async () => {
      try {
        await copyText(url);
        toast(`Copied remote URL for ${origin}.`, 'ok');
      } catch (error) {
        fail(error);
      }
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

/* ── diagnostics ──────────────────────────────────────────────────────────── */

let lastReportText = '';

/**
 * A checklist, not a text dump.
 *
 * The report used to be a block of monospace that could only be read and re-typed into a search
 * engine. Each check now knows what would fix it, and where the fix is a thing this panel can do,
 * it renders as a button instead of an instruction.
 */
function renderDiagnostics(report) {
  const list = $('diag-list');
  list.replaceChildren();
  list.hidden = false;
  $('diag-copy').hidden = false;
  lastReportText = report.report ?? '';

  for (const check of report.checks) {
    const row = document.createElement('div');
    row.className = `check ${check.status}`;

    const icon = document.createElement('span');
    icon.className = 'check-icon';
    icon.textContent = check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '×';
    icon.setAttribute('aria-label', check.status);

    const body = document.createElement('div');
    body.className = 'check-body';

    const title = document.createElement('strong');
    title.textContent = check.label;
    const detail = document.createElement('span');
    detail.className = 'check-detail';
    detail.textContent = check.detail;
    body.append(title, detail);

    if (check.remedy) {
      const remedy = document.createElement('p');
      remedy.className = 'muted small';
      remedy.textContent = check.remedy;
      body.append(remedy);
    }

    row.append(icon, body);

    if (check.action?.startsWith('open:')) {
      const link = document.createElement('a');
      link.className = 'btn ghost small';
      link.href = check.action.slice(5);
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = 'Open';
      row.append(link);
    } else if (check.action) {
      const fix = document.createElement('button');
      fix.className = 'btn small';
      fix.type = 'button';
      fix.textContent = 'Fix';
      fix.addEventListener('click', () => runAction(fix, check.action.replace(/^\/api\//, ''), 'Fix'));
      row.append(fix);
    }

    list.append(row);
  }
}

$('diag-btn').addEventListener('click', async (event) => {
  const button = event.target;
  button.disabled = true;
  try {
    renderDiagnostics(await api('diagnostics'));
  } catch (error) {
    fail(error);
  } finally {
    button.disabled = false;
  }
});

$('diag-copy').addEventListener('click', async () => {
  try {
    await copyText(lastReportText);
    toast('Diagnostics copied.', 'ok');
  } catch (error) {
    fail(error);
  }
});

$('quit-btn').addEventListener('click', async () => {
  try {
    await post('app/quit');
    toast('Shutting down…');
  } catch (error) {
    fail(error);
  }
});

/* ── logs ─────────────────────────────────────────────────────────────────── */

function logVisible(line) {
  if (RANK[line.dataset.level] > RANK[ui.logFilter]) return false;
  if (!ui.logSearch) return true;
  return line.textContent.toLowerCase().includes(ui.logSearch);
}

function applyLogFilters() {
  for (const line of document.querySelectorAll('.log-line')) line.hidden = !logVisible(line);
}

$('log-filter').addEventListener('change', (event) => {
  ui.logFilter = event.target.value;
  applyLogFilters();
});

$('log-search').addEventListener('input', (event) => {
  ui.logSearch = event.target.value.trim().toLowerCase();
  applyLogFilters();
});

$('log-clear').addEventListener('click', () => $('log').replaceChildren());

$('log-jump').addEventListener('click', () => {
  const problems = [...document.querySelectorAll('.log-line.error, .log-line.warn')].filter((line) => !line.hidden);
  const last = problems.at(-1);
  if (!last) {
    toast('No warnings or errors in view.');
    return;
  }
  last.scrollIntoView({ block: 'center' });
  last.classList.add('flash');
  setTimeout(() => last.classList.remove('flash'), 1200);
});

function logText() {
  return [...document.querySelectorAll('.log-line')]
    .filter((line) => !line.hidden)
    .map((line) => line.dataset.copyText ?? line.textContent)
    .join('\n');
}

function allLogText() {
  return [...document.querySelectorAll('.log-line')]
    .map((line) => line.dataset.copyText ?? line.textContent)
    .join('\n');
}

async function buildSupportReport() {
  let diagnostics;
  try {
    diagnostics = (await api('diagnostics')).report ?? 'Diagnostics returned no text.';
  } catch (error) {
    diagnostics = `Diagnostics failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const logs = allLogText();
  return [
    'Discord Audio Bridge support report',
    `Generated: ${new Date().toISOString()}`,
    `Control UI: ${navigator.userAgent}`,
    '',
    '=== Diagnostics ===',
    diagnostics,
    '',
    '=== Recent logs (all levels) ===',
    logs || 'No log entries are available in this UI session.',
    '',
  ].join('\n');
}

$('log-copy').addEventListener('click', async () => {
  try {
    await copyText(logText());
    toast('Visible log copied.', 'ok');
  } catch (error) {
    fail(error);
  }
});

$('log-download').addEventListener('click', () => {
  downloadText(`bridge-log-${reportTimestamp()}.txt`, logText());
});

$('support-copy').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await copyText(await buildSupportReport());
    toast('Support report copied. You can paste it into the chat.', 'ok');
  } catch (error) {
    fail(error);
  } finally {
    button.disabled = false;
  }
});

$('support-download').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    downloadText(`discord-audio-bridge-support-${reportTimestamp()}.txt`, await buildSupportReport());
    toast('Support report downloaded.', 'ok');
  } catch (error) {
    fail(error);
  } finally {
    button.disabled = false;
  }
});

function appendLog(entry) {
  const log = $('log');
  // Only autoscroll when already pinned to the bottom, so reading history is not interrupted.
  const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 40;

  const line = document.createElement('div');
  line.className = `log-line ${entry.level}`;
  line.dataset.level = entry.level;
  line.dataset.copyText = [new Date(entry.at).toISOString(), entry.level, entry.scope, entry.message, entry.extra]
    .filter(Boolean)
    .join(' ');

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
  line.hidden = !logVisible(line);
  log.append(line);

  while (log.childElementCount > 1000) log.firstElementChild.remove();
  if (pinned) log.scrollTop = log.scrollHeight;
}

/* ── websocket ────────────────────────────────────────────────────────────── */

let socket;
let retryDelay = 500;
let reconnectTimer;
let pollTimer;

function showConnectionFailure(error) {
  $('disconnected').hidden = false;
  $('disconnected-detail').textContent = token
    ? `The local control server is unavailable. ${error instanceof Error ? error.message : String(error)}`
    : 'No control token. Reopen Discord Audio Bridge from the Applications menu.';
}

async function refreshState() {
  const state = await api('state');
  render(state);
  $('disconnected').hidden = true;
}

function startPolling() {
  if (pollTimer) return;
  const poll = async () => {
    try {
      await refreshState();
    } catch (error) {
      showConnectionFailure(error);
    }
  };
  void poll();
  pollTimer = setInterval(() => void poll(), 1000);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = undefined;
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  retryDelay = Math.min(retryDelay * 1.6, 5000);
  reconnectTimer = setTimeout(() => void connect(), retryDelay);
}

async function connect() {
  if (!token) {
    showConnectionFailure(new Error('No control token.'));
    return;
  }

  let ticket;
  try {
    // Exchange the durable bearer token for a one-use ticket. A cookie would leak to unrelated
    // localhost services because browser cookies do not distinguish ports.
    ({ ticket } = await post('session'));
    if (!ticket) throw new Error('The control server did not issue a WebSocket ticket.');
  } catch {
    startPolling();
    scheduleReconnect();
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    socket = new WebSocket(`${protocol}//${location.host}/ws`, ['bridge-v1', `auth.${ticket}`]);
  } catch {
    startPolling();
    scheduleReconnect();
    return;
  }
  const activeSocket = socket;

  activeSocket.addEventListener('open', () => {
    retryDelay = 500;
    stopPolling();
    $('disconnected').hidden = true;
  });

  activeSocket.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'state') render(payload.state);
      else if (payload.type === 'log') appendLog(payload.entry);
      else if (payload.type === 'history') {
        $('log').replaceChildren();
        for (const entry of payload.entries) appendLog(entry);
      }
    } catch (error) {
      fail(error);
    }
  });

  activeSocket.addEventListener('close', () => {
    if (socket === activeSocket) socket = undefined;
    // Keep the interface usable over authenticated HTTP while live updates reconnect.
    startPolling();
    scheduleReconnect();
  });

  activeSocket.addEventListener('error', () => activeSocket.close());
}

async function bootstrap() {
  if (!token) {
    showConnectionFailure(new Error('No control token.'));
    return;
  }
  try {
    // Prove normal HTTP access first. A WebSocket problem must never cover a healthy application
    // with a permanent waiting screen.
    await refreshState();
    await Promise.all([loadGuilds(), loadSources(), loadPresets()]);
  } catch (error) {
    showConnectionFailure(error);
    setTimeout(() => void bootstrap(), 1000);
    return;
  }
  void connect();
}

void bootstrap();

// The source list is pushed by the bridge's resident monitor, so this is only a slow backstop for
// the case where that helper is unavailable and the list would otherwise never change.
setInterval(() => {
  if (document.visibilityState === 'visible' && ui.state && !ui.state.capabilities.audioTapBuilt) {
    void loadSources();
  }
}, 30_000);

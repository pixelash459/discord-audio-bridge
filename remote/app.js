const $ = (id) => document.getElementById(id);

/**
 * The token is stored in localStorage rather than sessionStorage.
 *
 * An installed home-screen app launches in a fresh session every time, so a session-scoped token
 * would mean pasting the URL again on every launch - which defeats the point of installing it.
 * The tradeoff is deliberate and narrow: this origin is one host on one network, the value is a
 * capability for a runtime-only dashboard, and forgetting it is one button away.
 */
const TOKEN_KEY = 'bridge-remote-token';

const token = (() => {
  const url = new URL(location.href);
  const supplied = new URLSearchParams(url.hash.slice(1)).get('token') ?? url.searchParams.get('token');
  if (supplied) {
    try {
      localStorage.setItem(TOKEN_KEY, supplied);
    } catch {
      /* private mode; the in-memory copy still works for this visit */
    }
    url.searchParams.delete('token');
    url.hash = '';
    history.replaceState(null, '', url.pathname + url.search);
    return supplied;
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
})();

let state = null;
let editing = false;
let requestRunning = false;
let toastTimer;
let routeInitialized = false;
let consecutiveFailures = 0;
let routeOptions = {
  platform: '',
  guilds: [],
  sources: { processes: [], devices: [], dshow: [], audioTapBuilt: false },
};
let selectedSource = null;
let renderedSources = new Map();
let sourceFilter = '';
let artworkTrackKey = '';
let artwork = null;
let artworkRequest = 0;

async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `${response.status} ${response.statusText}`);
  return value;
}

const post = (path, value) => api(path, { method: 'POST', body: JSON.stringify(value) });
const kbps = (value) => `${Math.round(value / 1000)} kbps`;

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
  if (!state) return;
  setArtwork($('host-art'), state.nowPlaying);
  for (const session of state.sessions) {
    const card = cards.get(session.guildId);
    if (card) setArtwork(card.querySelector('.session-art'), session.nowPlaying);
  }
  updateMediaSession();
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
      /* Artwork is optional; the controls and track metadata remain available. */
    });
}

function toast(message, error = false) {
  const element = $('toast');
  element.textContent = message;
  element.className = `toast${error ? ' error' : ''}`;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.hidden = true), 3500);
  // A short buzz on failure is the phone-native way to say "that did not work".
  if (error && navigator.vibrate) navigator.vibrate(40);
}

function meterWidth(db) {
  if (!Number.isFinite(db) || db <= -60) return 0;
  const normalised = Math.min(1, Math.max(0, (db + 60) / 60));
  return Math.min(100, Math.pow(normalised, 1.7) * 100);
}

const trackTitle = (track) =>
  !track?.title ? null : track.artist ? `${track.artist} — ${track.title}` : track.title;

const sourceKey = (source) =>
  source?.kind === 'process'
    ? `process:${source.pid}`
    : source?.kind === 'device'
      ? `device:${source.id}`
      : source?.kind === 'dshow'
        ? `dshow:${source.name}`
        : '';

function sourceItems(kind = $('source-kind').value) {
  const sources = routeOptions.sources;
  if (kind === 'process') {
    return sources.processes.map((item) => ({
      key: `process:${item.pid}`,
      label: item.displayName || item.name,
      detail: `PID ${item.pid}${item.state === 'Active' || item.state === 'AudioSessionStateActive' ? ' · playing' : ''}`,
      icon: item.icon ?? null,
      source: {
        kind: 'process',
        pid: item.pid,
        processName: item.name,
        exclude: false,
        label: item.displayName || item.name,
      },
    }));
  }
  if (kind === 'device') {
    return sources.devices.map((item) => ({
      key: `device:${item.id}`,
      label: `${item.isDefault ? 'Default · ' : ''}${item.name}`,
      detail: `${Math.round(item.sampleRate / 100) / 10} kHz`,
      icon: null,
      source: { kind: 'device', id: item.id, label: item.name },
    }));
  }
  return sources.dshow.map((item) => ({
    key: `dshow:${item.name}`,
    label: item.name,
    detail: 'DirectShow input',
    icon: null,
    source: { kind: 'dshow', name: item.name, label: item.name },
  }));
}

/* ── route builder ────────────────────────────────────────────────────────── */

function renderGuilds() {
  const select = $('guild');
  const previous = select.value;
  select.replaceChildren();
  for (const guild of routeOptions.guilds) select.append(new Option(guild.name, guild.id));
  if (routeOptions.guilds.some((guild) => guild.id === previous)) select.value = previous;
  renderChannels();
}

function renderChannels() {
  const guild = routeOptions.guilds.find((candidate) => candidate.id === $('guild').value);
  const select = $('channel');
  const previous = select.value;
  select.replaceChildren();

  for (const channel of guild?.channels ?? []) {
    const option = new Option(
      `${channel.name}${channel.members > 0 ? ` · ${channel.members} listening` : ''}${
        channel.joinable ? '' : ` (${channel.unavailableReason})`
      }`,
      channel.id,
    );
    option.disabled = !channel.joinable;
    select.append(option);
  }
  if ((guild?.channels ?? []).some((channel) => channel.id === previous && channel.joinable)) {
    select.value = previous;
  }
  renderRouteHint();
}

function renderSources() {
  const container = $('source');
  container.replaceChildren();
  renderedSources = new Map();

  const all = sourceItems();
  for (const item of all) renderedSources.set(item.key, item.source);

  const items = sourceFilter
    ? all.filter(
        (item) =>
          item.label.toLowerCase().includes(sourceFilter) || item.detail.toLowerCase().includes(sourceFilter),
      )
    : all;

  if (selectedSource && !renderedSources.has(sourceKey(selectedSource))) selectedSource = null;

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'route-hint';
    empty.textContent = sourceFilter
      ? `Nothing matches “${sourceFilter}”.`
      : 'Nothing to capture. Start playback on the host, then refresh.';
    container.append(empty);
    renderRouteHint();
    return;
  }

  for (const item of items) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'source-tile';
    const chosen = sourceKey(selectedSource) === item.key;
    tile.classList.toggle('selected', chosen);
    tile.setAttribute('aria-pressed', String(chosen));

    if (item.icon) {
      const icon = document.createElement('img');
      icon.className = 'tile-icon';
      icon.alt = '';
      icon.src = `data:image/png;base64,${item.icon}`;
      tile.append(icon);
    }

    const text = document.createElement('span');
    text.className = 'tile-text';
    const name = document.createElement('strong');
    name.textContent = item.label;
    const detail = document.createElement('span');
    detail.textContent = item.detail;
    text.append(name, detail);
    tile.append(text);

    tile.addEventListener('click', () => {
      selectedSource = chosen ? null : item.source;
      if (navigator.vibrate) navigator.vibrate(8);
      renderSources();
    });

    container.append(tile);
  }

  renderRouteHint();
}

function renderRouteHint() {
  const guild = routeOptions.guilds.find((candidate) => candidate.id === $('guild').value);
  const channel = guild?.channels.find((candidate) => candidate.id === $('channel').value);
  const hint = $('route-hint');
  const button = $('apply-route');

  button.textContent = state?.sessions.length ? 'Apply source & destination' : 'Start stream';
  button.disabled = !guild || !channel || !selectedSource || requestRunning;

  if (!routeOptions.sources.audioTapBuilt && $('source-kind').value !== 'dshow') {
    hint.textContent =
      routeOptions.platform === 'linux'
        ? 'The host is missing the PipeWire capture tools, so per-app capture is unavailable.'
        : 'AudioTap is not built on the host, so per-app capture is unavailable.';
  } else if (!guild || !channel) {
    hint.textContent = 'Choose a Discord server and a voice channel.';
  } else if (!selectedSource) {
    hint.textContent = 'Choose what the host should send.';
  } else {
    hint.textContent = `${selectedSource.label} → ${guild.name} / ${channel.name}`;
  }
}

/* ── media session ────────────────────────────────────────────────────────── */

// A real one-second silent WAV, looped, purely to obtain audio focus. The previous zero-frame WAV
// ended immediately in several mobile browsers, so lock-screen actions disappeared again.
function silentWaveUrl() {
  const sampleRate = 8000;
  const samples = sampleRate;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

let focusStarted = false;

function ensureAudioFocus() {
  if (focusStarted || !('mediaSession' in navigator)) return;
  const element = $('focus-loop');
  element.src = silentWaveUrl();
  element.volume = 0;
  // Autoplay is blocked until the page has been interacted with, which is why this is called from
  // the first real gesture rather than at load.
  element
    .play()
    .then(() => {
      focusStarted = true;
      navigator.mediaSession.setActionHandler('play', () => void toggleMute(false));
      navigator.mediaSession.setActionHandler('pause', () => void toggleMute(true));
      navigator.mediaSession.setActionHandler('stop', () => void stopFirstSession());
    })
    .catch(() => {
      /* no audio focus available; the page works exactly as before */
    });
}

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !focusStarted) return;
  const session = state?.sessions[0];
  const title = trackTitle(state?.nowPlaying) ?? session?.source?.label ?? 'Discord Audio Bridge';

  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist: session ? `→ ${session.channelName}` : 'Not streaming',
    album: 'Discord Audio Bridge',
    ...(artwork
      ? { artwork: [{ src: `data:image/png;base64,${artwork}`, sizes: '256x256', type: 'image/png' }] }
      : {}),
  });
  navigator.mediaSession.playbackState = session && !session.muted ? 'playing' : 'paused';
}

async function toggleMute(muted) {
  const session = state?.sessions[0];
  if (!session) return;
  try {
    await post('mute', { guildId: session.guildId, muted });
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
}

async function stopFirstSession() {
  const session = state?.sessions[0];
  if (!session) return;
  try {
    await post('stop', { guildId: session.guildId });
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
}

document.addEventListener('pointerdown', ensureAudioFocus, { once: true });

/* ── session cards ────────────────────────────────────────────────────────── */

const cards = new Map();

function buildCard(guildId) {
  const node = $('session-template').content.firstElementChild.cloneNode(true);
  const pick = (selector) => node.querySelector(selector);

  pick('.stop').addEventListener('click', async () => {
    try {
      requestRunning = true;
      await post('stop', { guildId });
      await refresh();
    } catch (error) {
      toast(error.message, true);
    } finally {
      requestRunning = false;
    }
  });

  pick('.mute').addEventListener('click', async () => {
    const session = state?.sessions.find((item) => item.guildId === guildId);
    if (!session) return;
    try {
      requestRunning = true;
      await post('mute', { guildId, muted: !session.muted });
      await refresh();
    } catch (error) {
      toast(error.message, true);
    } finally {
      requestRunning = false;
    }
  });

  for (const [selector, send, label] of [
    ['.gain', (value) => post('gain', { guildId, db: value }), '.gain-value'],
    ['.bitrate', (value) => post('bitrate', { guildId, bitrate: value * 1000 }), '.bitrate-value'],
  ]) {
    const input = pick(selector);
    input.addEventListener('pointerdown', () => (editing = true));
    input.addEventListener('input', () => {
      node.querySelector(label).textContent =
        selector === '.gain' ? `${Number(input.value).toFixed(1)} dB` : `${input.value} kbps`;
    });
    input.addEventListener('change', async () => {
      editing = false;
      try {
        await send(Number(input.value));
      } catch (error) {
        toast(error.message, true);
      }
    });
  }

  $('sessions').append(node);
  cards.set(guildId, node);
  return node;
}

function renderMix(card, session) {
  const container = card.querySelector('.mix-inputs');
  const mix = session.mix;
  if (!mix || mix.length < 2) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }

  container.hidden = false;
  if (container.childElementCount !== mix.length) {
    container.replaceChildren();
    mix.forEach((input, index) => {
      const row = document.createElement('div');
      row.className = 'control';
      const label = document.createElement('label');
      label.className = 'slider-label';
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
      slider.setAttribute('aria-label', `${input.label} gain`);

      slider.addEventListener('pointerdown', () => (editing = true));
      slider.addEventListener('input', () => (value.textContent = `${Number(slider.value).toFixed(1)} dB`));
      slider.addEventListener('change', async () => {
        editing = false;
        try {
          await post('input-gain', { guildId: session.guildId, index, db: Number(slider.value) });
        } catch (error) {
          toast(error.message, true);
        }
      });

      row.append(label, slider);
      container.append(row);
    });
  }

  mix.forEach((input, index) => {
    const row = container.children[index];
    if (!row) return;
    row.querySelector('.mix-gain').value = String(input.gainDb);
    row.querySelector('.mix-value').textContent = `${input.gainDb.toFixed(1)} dB${input.live ? '' : ' · stopped'}`;
  });
}

function renderSession(session) {
  const card = cards.get(session.guildId) ?? buildCard(session.guildId);
  const pick = (selector) => card.querySelector(selector);
  const track = trackTitle(session.nowPlaying);

  pick('h2').textContent = track ?? session.sources.map((source) => source.label).join(' + ');
  pick('.subtitle').textContent = track
    ? `${session.sources.map((source) => source.label).join(' + ')} → ${session.channelName}`
    : `to ${session.channelName}`;

  setArtwork(pick('.session-art'), session.nowPlaying);

  const badge = pick('.badge');
  badge.textContent = session.muted ? 'Muted in Discord' : 'Live';
  badge.classList.toggle('muted', session.muted);

  pick('.player').textContent = session.playerState;
  pick('.bitrate-stat').textContent = kbps(session.bitrate);
  pick('.capture').textContent = session.captureFormat;
  pick('.listeners').textContent = session.listeners > 0 ? String(session.listeners) : 'nobody';

  const tap = session.tap;
  pick('.clip-note').hidden = !tap?.clipping;
  pick('.silent-note').hidden = !(tap?.silent && session.uptimeMs > 5_000);
  for (const [index, channel] of ['l', 'r'].entries()) {
    pick(`.meter-${channel}`).style.width = `${meterWidth(tap?.rmsDb?.[index] ?? -100)}%`;
  }

  if (!editing) {
    const gain = pick('.gain');
    gain.value = String(session.gainDb);
    pick('.gain-value').textContent = `${session.gainDb.toFixed(1)} dB`;
    const bitrate = pick('.bitrate');
    bitrate.max = String(Math.round(session.bitrateCeiling / 1000));
    bitrate.value = String(Math.round(session.bitrate / 1000));
    pick('.bitrate-value').textContent = kbps(session.bitrate);
  }

  renderMix(card, session);
  pick('.mute').textContent = session.muted ? 'Unmute bot' : 'Mute bot';
}

function render() {
  if (!state || editing || requestRunning) return;
  ensureArtwork(state.nowPlaying);
  $('dot').classList.toggle('on', state.bot.ready);
  $('status').textContent = state.bot.ready ? state.bot.tag ?? 'Online' : 'Bot offline';
  $('empty').hidden = state.sessions.length > 0;
  renderRouteHint();

  const hostTrack = trackTitle(state.nowPlaying);
  $('host-track').hidden = !hostTrack;
  if (hostTrack) {
    $('host-title').textContent = hostTrack;
    setArtwork($('host-art'), state.nowPlaying);
  }

  const live = new Set(state.sessions.map((session) => session.guildId));
  for (const [guildId, card] of cards) {
    if (!live.has(guildId)) {
      card.remove();
      cards.delete(guildId);
    }
  }
  for (const session of state.sessions) renderSession(session);

  updateMediaSession();
}

/* ── wiring ───────────────────────────────────────────────────────────────── */

$('guild').addEventListener('change', () => {
  renderChannels();
  renderSources();
});
$('channel').addEventListener('change', renderRouteHint);
$('source-kind').addEventListener('change', () => {
  selectedSource = null;
  renderSources();
});
$('source-filter').addEventListener('input', (event) => {
  sourceFilter = event.target.value.trim().toLowerCase();
  renderSources();
});
$('refresh-options').addEventListener('click', () => void loadRouteOptions());
$('forget-device').addEventListener('click', () => {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable; navigating still discards the in-memory credential */
  }
  location.replace('/');
});

$('apply-route').addEventListener('click', async () => {
  if (!$('guild').value || !$('channel').value || !selectedSource) return;
  try {
    requestRunning = true;
    renderRouteHint();
    await post('stream', {
      guildId: $('guild').value,
      channelId: $('channel').value,
      source: selectedSource,
    });
    toast(`Streaming ${selectedSource.label}.`);
    if (navigator.vibrate) navigator.vibrate(20);
  } catch (error) {
    toast(error.message, true);
  } finally {
    requestRunning = false;
    await refresh();
  }
});

async function loadRouteOptions() {
  const button = $('refresh-options');
  button.disabled = true;
  try {
    routeOptions = await api('options');
    renderGuilds();
    renderSources();
    routeInitialized = true;
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function refresh() {
  try {
    state = await api('state');
    consecutiveFailures = 0;
    $('offline').hidden = true;
    if (!routeInitialized) await loadRouteOptions();
    render();
  } catch (error) {
    consecutiveFailures += 1;
    // One dropped poll on a phone is normal (the radio slept); three in a row is a real problem.
    if (consecutiveFailures >= 3) {
      $('offline').hidden = false;
      $('dot').classList.remove('on');
      $('status').textContent = 'Disconnected';
    }
    if (consecutiveFailures === 1) toast(error.message, true);
  }
}

void refresh();
setInterval(() => {
  if (document.visibilityState === 'visible') void refresh();
}, 1500);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refresh();
});

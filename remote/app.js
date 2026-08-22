const $ = (id) => document.getElementById(id);

const token = (() => {
  const url = new URL(location.href);
  const supplied = url.searchParams.get('token');
  if (supplied) {
    sessionStorage.setItem('bridge-remote-token', supplied);
    history.replaceState(null, '', url.pathname);
    return supplied;
  }
  return sessionStorage.getItem('bridge-remote-token') ?? '';
})();

let state = null;
let editing = false;
let requestRunning = false;
let toastTimer;
let routeInitialized = false;
let routeOptions = {
  guilds: [],
  sources: { processes: [], devices: [], dshow: [], audioTapBuilt: false },
};
let selectedSource = null;
let renderedSources = new Map();

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

function toast(message, error = false) {
  const element = $('toast');
  element.textContent = message;
  element.className = `toast${error ? ' error' : ''}`;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.hidden = true), 3500);
}

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
      source: { kind: 'process', pid: item.pid, exclude: false, label: item.displayName || item.name },
    }));
  }
  if (kind === 'device') {
    return sources.devices.map((item) => ({
      key: `device:${item.id}`,
      label: `${item.isDefault ? 'Default · ' : ''}${item.name}`,
      detail: `${Math.round(item.sampleRate / 100) / 10} kHz`,
      source: { kind: 'device', id: item.id, label: item.name },
    }));
  }
  return sources.dshow.map((item) => ({
    key: `dshow:${item.name}`,
    label: item.name,
    detail: 'DirectShow input',
    source: { kind: 'dshow', name: item.name, label: item.name },
  }));
}

function renderChannels(preferred) {
  const guild = routeOptions.guilds.find((item) => item.id === $('guild').value);
  const select = $('channel');
  const previous = preferred ?? select.value;
  select.replaceChildren();
  const channels = guild?.channels ?? [];
  if (channels.length === 0) {
    select.append(new Option('No voice channels found', ''));
    select.disabled = true;
  } else {
    for (const channel of channels) {
      const label = `${channel.name} · ${Math.round(channel.bitrate / 1000)} kbps${channel.members ? ` · ${channel.members} connected` : ''}${channel.joinable ? '' : ' · unavailable'}`;
      const option = new Option(label, channel.id);
      option.disabled = !channel.joinable;
      select.append(option);
    }
    const selected = channels.find((item) => item.id === previous && item.joinable) ?? channels.find((item) => item.joinable);
    select.value = selected?.id ?? '';
    select.disabled = !selected;
  }
  renderRouteHint();
}

function renderSources(preferred) {
  const select = $('source');
  const items = sourceItems();
  const wanted = preferred ?? sourceKey(selectedSource);
  select.replaceChildren();

  // Keep a running source selectable even when an idle app disappears from fresh enumeration.
  const liveSource = state?.sessions.find((item) => item.guildId === $('guild').value)?.source;
  if (liveSource?.kind === $('source-kind').value && !items.some((item) => item.key === sourceKey(liveSource))) {
    items.unshift({ key: sourceKey(liveSource), label: `${liveSource.label} (current)`, detail: 'Current stream', source: liveSource });
  }
  renderedSources = new Map(items.map((item) => [item.key, item.source]));

  if (items.length === 0) {
    select.append(new Option($('source-kind').value === 'process' ? 'No applications playing audio' : 'No sources found', ''));
    select.disabled = true;
    selectedSource = null;
  } else {
    for (const item of items) select.append(new Option(`${item.label} · ${item.detail}`, item.key));
    const selected = items.find((item) => item.key === wanted) ?? items[0];
    select.value = selected.key;
    select.disabled = false;
    selectedSource = selected.source;
  }
  renderRouteHint();
}

function renderRouteHint() {
  const guild = routeOptions.guilds.find((item) => item.id === $('guild').value);
  const channel = guild?.channels.find((item) => item.id === $('channel').value);
  const hint = $('route-hint');
  const button = $('apply-route');
  const ready = Boolean(guild && channel?.joinable && selectedSource);
  button.disabled = !ready || requestRunning;
  button.textContent = state?.sessions.length ? 'Apply source & destination' : 'Start stream';
  if (!routeOptions.sources.audioTapBuilt && $('source-kind').value !== 'dshow') {
    hint.textContent = routeOptions.platform === 'linux'
      ? 'The PipeWire capture tools are missing on the host. Install them (for example, "apt install pipewire-bin"), then restart the bridge.'
      : 'AudioTap is not built. Choose Cable / DirectShow or build AudioTap on the host PC.';
  } else if (!channel) {
    hint.textContent = 'Choose a Discord server and a voice channel.';
  } else if (!selectedSource) {
    hint.textContent = 'No source is available. Start audio on the host PC, then refresh.';
  } else {
    hint.textContent = `${selectedSource.label} → ${guild.name} / ${channel.name}`;
  }
}

function renderRouteOptions() {
  const live = state?.sessions[0];
  const guild = $('guild');
  const previousGuild = routeInitialized ? guild.value : live?.guildId;
  guild.replaceChildren();
  if (routeOptions.guilds.length === 0) {
    guild.append(new Option('Bot is not in a server', ''));
    guild.disabled = true;
  } else {
    for (const item of routeOptions.guilds) guild.append(new Option(item.name, item.id));
    guild.value = routeOptions.guilds.some((item) => item.id === previousGuild) ? previousGuild : routeOptions.guilds[0].id;
    guild.disabled = false;
  }
  if (!routeInitialized && live) {
    $('source-kind').value = live.source.kind;
    selectedSource = live.source;
  }
  renderChannels(!routeInitialized ? live?.channelId : undefined);
  renderSources(!routeInitialized ? sourceKey(live?.source) : undefined);
  routeInitialized = true;
}

async function loadRouteOptions() {
  const refresh = $('refresh-options');
  refresh.disabled = true;
  try {
    routeOptions = await api('options');
    renderRouteOptions();
  } catch (error) {
    toast(error.message, true);
  } finally {
    refresh.disabled = false;
  }
}

function render() {
  if (!state || editing || requestRunning) return;
  $('dot').classList.toggle('on', state.bot.ready);
  $('status').textContent = state.bot.ready ? state.bot.tag ?? 'Online' : 'Bot offline';
  $('empty').hidden = state.sessions.length > 0;
  renderRouteHint();

  const container = $('sessions');
  container.replaceChildren();
  for (const session of state.sessions) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.guild = session.guildId;
    card.innerHTML = `
      <div class="card-head">
        <div><h2></h2><p class="subtitle"></p></div>
        <span class="badge"></span>
      </div>
      <div class="stats">
        <div class="stat"><span>Player</span><strong class="player"></strong></div>
        <div class="stat"><span>Bitrate</span><strong class="bitrate-stat"></strong></div>
        <div class="stat"><span>Capture</span><strong class="capture"></strong></div>
      </div>
      <div class="controls">
        <div class="control"><label>Gain <output class="gain-value"></output></label><input class="gain" type="range" min="-30" max="12" step="0.5" /></div>
        <div class="control"><label>Opus bitrate <output class="bitrate-value"></output></label><input class="bitrate" type="range" min="32" step="8" /></div>
      </div>
      <div class="actions"><button class="mute secondary"></button><button class="stop danger">Stop</button></div>`;

    card.querySelector('h2').textContent = session.source.label;
    card.querySelector('.subtitle').textContent = `to ${session.channelName}`;
    const badge = card.querySelector('.badge');
    badge.textContent = session.muted ? 'Muted in Discord' : 'Live';
    badge.classList.toggle('muted', session.muted);
    card.querySelector('.player').textContent = session.playerState;
    card.querySelector('.bitrate-stat').textContent = kbps(session.bitrate);
    card.querySelector('.capture').textContent = session.captureFormat;
    const gain = card.querySelector('.gain');
    gain.value = String(session.gainDb);
    card.querySelector('.gain-value').textContent = `${session.gainDb.toFixed(1)} dB`;
    const bitrate = card.querySelector('.bitrate');
    bitrate.max = String(Math.round(session.bitrateCeiling / 1000));
    bitrate.value = String(Math.round(session.bitrate / 1000));
    card.querySelector('.bitrate-value').textContent = kbps(session.bitrate);
    card.querySelector('.mute').textContent = session.muted ? 'Unmute bot' : 'Mute bot';
    container.append(card);
  }
}

$('guild').addEventListener('change', () => {
  renderChannels();
  renderSources();
});
$('channel').addEventListener('change', renderRouteHint);
$('source-kind').addEventListener('change', () => {
  selectedSource = null;
  renderSources();
});
$('source').addEventListener('change', () => {
  selectedSource = renderedSources.get($('source').value) ?? null;
  renderRouteHint();
});
$('refresh-options').addEventListener('click', () => void loadRouteOptions());
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
  } catch (error) {
    toast(error.message, true);
  } finally {
    requestRunning = false;
    await refresh();
    renderRouteHint();
  }
});

document.addEventListener('pointerdown', (event) => {
  if (event.target.matches('input[type="range"]')) editing = true;
});
document.addEventListener('input', (event) => {
  if (event.target.matches('.gain')) event.target.closest('.control').querySelector('output').textContent = `${Number(event.target.value).toFixed(1)} dB`;
  if (event.target.matches('.bitrate')) event.target.closest('.control').querySelector('output').textContent = `${event.target.value} kbps`;
});
document.addEventListener('change', async (event) => {
  if (!event.target.matches('input[type="range"]')) return;
  editing = false;
  const guildId = event.target.closest('.card').dataset.guild;
  try {
    requestRunning = true;
    if (event.target.matches('.gain')) await post('gain', { guildId, db: Number(event.target.value) });
    else await post('bitrate', { guildId, bitrate: Number(event.target.value) * 1000 });
  } catch (error) {
    toast(error.message, true);
  } finally {
    requestRunning = false;
    await refresh();
  }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  const card = button?.closest('.card');
  if (!card) return;
  const session = state.sessions.find((item) => item.guildId === card.dataset.guild);
  if (!session) return;
  try {
    requestRunning = true;
    button.disabled = true;
    if (button.matches('.mute')) await post('mute', { guildId: session.guildId, muted: !session.muted });
    if (button.matches('.stop')) await post('stop', { guildId: session.guildId });
  } catch (error) {
    toast(error.message, true);
  } finally {
    requestRunning = false;
    await refresh();
  }
});

async function refresh() {
  try {
    state = await api('state');
    render();
  } catch (error) {
    $('dot').classList.remove('on');
    $('status').textContent = token ? 'Disconnected' : 'Access token missing';
    if (!token) toast('Open the full tokenized URL printed by the bot.', true);
  }
}

await refresh();
await loadRouteOptions();
setInterval(() => void refresh(), 1000);

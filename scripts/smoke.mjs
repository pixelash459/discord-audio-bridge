// Import every module the bot loads at startup.
//
// `tsc --noEmit` is not enough on its own: Node strips types at runtime, so a construct tsc
// accepts but the stripper rejects would still break `npm start`. Actually importing each module
// proves they parse, link, and have no top-level side effect that throws.
//
// Run directly (`node scripts/smoke.mjs`) or via CI.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { runInNewContext } from 'node:vm';

process.env.DISCORD_TOKEN ||= 'smoke-test-placeholder';
process.env.DISCORD_APP_ID ||= '0';
// Keep the control panel from binding a port during the check.
process.env.CONTROL_PORT ||= '0';
// Importing the logger should not create runtime artifacts during a smoke test.
process.env.LOG_FILE ||= 'off';

const modules = [
  '../src/config.ts',
  '../src/logger.ts',
  '../src/httpSecurity.ts',
  '../src/tailscale.ts',
  '../src/validation.ts',
  '../src/platform.ts',
  '../src/commands.ts',
  '../src/audio/tap.ts',
  '../src/audio/monitor.ts',
  '../src/audio/mixer.ts',
  '../src/audio/encoder.ts',
  '../src/voice/session.ts',
  '../src/control/server.ts',
  '../src/control/launcher.ts',
  '../src/control/api.ts',
  '../src/control/envFile.ts',
  '../src/remote/server.ts',
  '../src/registration.ts',
  '../src/doctor.ts',
  '../src/diagnostics.ts',
  '../src/presence.ts',
  '../src/presets.ts',
];

let failed = 0;

for (const specifier of modules) {
  try {
    await import(new URL(specifier, import.meta.url).href);
    process.stdout.write(`  ok    ${specifier.replace('../', '')}\n`);
  } catch (error) {
    failed++;
    process.stdout.write(`  FAIL  ${specifier.replace('../', '')}\n`);
    process.stdout.write(`        ${error instanceof Error ? error.stack : String(error)}\n`);
  }
}

// With no --project-root flag, indexOf() returns -1. The packaged-build regression used
// argv[-1 + 1] and therefore mistook argv[0] for the flag value, ignoring BRIDGE_PROJECT_ROOT.
{
  const { findProjectRoot } = await import(new URL('../src/config.ts', import.meta.url).href);
  const expected = join(tmpdir(), 'discord-audio-bridge-packaged-assets');
  const actual = findProjectRoot(
    ['/usr/lib/discord-audio-bridge/discord-audio-bridge'],
    { BRIDGE_PROJECT_ROOT: expected },
    '/unrelated-launch-directory',
    true,
  );
  if (actual !== expected) {
    failed++;
    process.stdout.write(`  FAIL  packaged asset-root override (got ${actual})\n`);
  } else {
    process.stdout.write('  ok    packaged asset-root override\n');
  }
}

// A second application-menu click should open the authenticated panel from the running process,
// not start another Discord client. Exercise token parsing and the authenticated state probe
// without binding a real port.
{
  const temp = await mkdtemp(join(tmpdir(), 'discord-audio-bridge-launcher-'));
  const tokenPath = join(temp, '.control-token');
  const token = 'desktop-launcher-smoke-token-123456';
  await writeFile(tokenPath, JSON.stringify({ port: 8787, token }), 'utf8');

  const requested = [];
  let authorization = '';
  const { findRunningControlPanel } = await import(
    new URL('../src/control/launcher.ts', import.meta.url).href
  );
  const panel = await findRunningControlPanel(tokenPath, async (input, init) => {
    requested.push(String(input));
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(JSON.stringify({ bot: { ready: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  await rm(temp, { recursive: true, force: true });

  if (
    panel !== `http://127.0.0.1:8787/#token=${token}` ||
    requested.length !== 1 ||
    !requested[0].endsWith('/api/state') ||
    authorization !== `Bearer ${token}`
  ) {
    failed++;
    process.stdout.write('  FAIL  desktop launcher attaches to running panel\n');
  } else {
    process.stdout.write('  ok    desktop launcher attaches to running panel\n');
  }
}

// Capture inputs cross a process boundary. Reject unknown discriminants and non-finite controls
// instead of letting them fall through to a default device or poison float samples with NaN.
// pw-dump / PipeWire capture paths were removed; this build is Windows-only.

{
  const { finiteNumber, validateSource } = await import(
    new URL('../src/validation.ts', import.meta.url).href
  );
  let rejectedSource = false;
  let rejectedGain = false;
  try { validateSource({ kind: 'unexpected', label: 'bad' }); } catch { rejectedSource = true; }
  try { finiteNumber(Number.NaN, 'Gain', -60, 20); } catch { rejectedGain = true; }
  if (!rejectedSource || !rejectedGain) {
    failed++;
    process.stdout.write('  FAIL  untrusted audio controls are rejected\n');
  } else {
    process.stdout.write('  ok    untrusted audio controls are rejected\n');
  }
}

const tapSource = await readFile(new URL('../src/audio/tap.ts', import.meta.url), 'utf8');
const configSource = await readFile(new URL('../src/config.ts', import.meta.url), 'utf8');
const envSource = await readFile(new URL('../src/control/envFile.ts', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../src/control/api.ts', import.meta.url), 'utf8');
const controlServerSource = await readFile(new URL('../src/control/server.ts', import.meta.url), 'utf8');
const packageSource = await readFile(new URL('./package.mjs', import.meta.url), 'utf8');
const workflowSource = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const controlUiSource = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const controlUiHtml = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');

if (
  !controlUiHtml.includes('id="support-copy"') ||
  !controlUiHtml.includes('id="support-download"') ||
  !controlUiSource.includes('async function copyText(text)') ||
  !controlUiSource.includes("document.execCommand('copy')") ||
  !controlUiSource.includes('async function buildSupportReport()') ||
  !controlUiSource.includes('line.dataset.copyText') ||
  !controlUiSource.includes("'=== Diagnostics ==='") ||
  !controlUiSource.includes("'=== Recent logs (all levels) ==='")
) {
  failed++;
  process.stdout.write('  FAIL  portable copyable support report contract\n');
} else {
  process.stdout.write('  ok    portable copyable support report contract\n');
}
const envExample = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
if (
  !configSource.includes('argIndex >= 0 ?') ||
  configSource.includes("'/usr/share/discord-audio-bridge'") ||
  !envSource.includes("join(runtimeRoot, '.env')") ||
  apiSource.includes("runScript('register')") ||
  !packageSource.includes('readdirSync(packagedAudioTapDir') ||
  packageSource.includes('packageLinux') ||
  packageSource.includes('nfpm') ||
  packageSource.includes('AppImage') ||
  workflowSource.includes('linux-x64') ||
  workflowSource.includes('ubuntu-24.04-arm') ||
  !controlServerSource.includes('mode: 0o600') ||
  !controlServerSource.includes('control panel assets are missing') ||
  envExample.includes('PWRECORD_PATH') ||
  tapSource.includes('pipewire') ||
  tapSource.includes('PipedTap')
) {
  failed++;
  process.stdout.write('  FAIL  Windows-only packaged runtime regression contracts\n');
} else {
  process.stdout.write('  ok    Windows-only packaged runtime regression contracts\n');
}

const markdown = await Promise.all(
  [
    '../README.md',
    '../CONTRIBUTING.md',
    '../CODE_OF_CONDUCT.md',
    '../SECURITY.md',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
);
const documentation = markdown.join('\n');
if (
  /github\.com\/(?:OWNER|<owner>)/i.test(documentation) ||
  /pipewire-bin|pw-record|AppImage|\.deb\b|cross-platform\.md/i.test(documentation) ||
  documentation.includes('docs.discord.food') ||
  documentation.includes('npm run dist') ||
  /Microsoft\.DotNet\.SDK\.9|\.NET SDK 9|non-Stage voice/.test(documentation) ||
  !envExample.includes('relative to the writable runtime root') ||
  !documentation.includes('Windows')
) {
  failed++;
  process.stdout.write('  FAIL  documentation matches current platform contracts\n');
} else {
  process.stdout.write('  ok    documentation matches current platform contracts\n');
}

// A cheap guard against the encoder losing a setting that is easy to drop and painful to debug.
const { buildArgs } = await import(new URL('../src/audio/encoder.ts', import.meta.url).href);
const args = buildArgs({
  input: {
    kind: 'pipe',
    format: {
      sampleRate: 48_000,
      channels: 2,
      sampleFormat: 'f32le',
      bitsPerSample: 32,
      encoding: 'IeeeFloat',
      latencyMs: 0,
      source: 'smoke',
      gainAppliedInTap: true,
    },
  },
  bitrate: 384_000,
});

const required = [
  // One Ogg page per Opus packet. The muxer default is one second, which starves the player.
  ['-page_duration', '20000'],
  ['-frame_duration', '20'],
  ['-application', 'audio'],
  ['-c:a', 'libopus'],
  ['-ar', '48000'],
];

for (const [flag, value] of required) {
  const index = args.indexOf(flag);
  if (index === -1 || args[index + 1] !== value) {
    failed++;
    process.stdout.write(`  FAIL  encoder args: expected ${flag} ${value}, got ${args[index + 1] ?? '(absent)'}\n`);
  } else {
    process.stdout.write(`  ok    encoder args: ${flag} ${value}\n`);
  }
}

// Credentials must be scrubbed before entries reach history, listeners, console, or disk.
const { logger, recentLogs } = await import(new URL('../src/logger.ts', import.meta.url).href);
logger('smoke').info(`redaction check token=${process.env.DISCORD_TOKEN}`, {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
});
const redacted = recentLogs().at(-1);
if (
  !redacted ||
  redacted.message.includes(process.env.DISCORD_TOKEN) ||
  redacted.extra?.includes(process.env.DISCORD_TOKEN) ||
  !redacted.message.includes('[REDACTED]')
) {
  failed++;
  process.stdout.write('  FAIL  logger credential redaction\n');
} else {
  process.stdout.write('  ok    logger credential redaction\n');
}

// Components such as the reconnect overlay define their own display mode. Without an explicit
// author-level rule, that display declaration overrides the browser's built-in [hidden] styling
// and leaves the blocking overlay visible even after the WebSocket connects.
const stylesheet = await readFile(new URL('../web/style.css', import.meta.url), 'utf8');
if (!/\[hidden\]\s*\{[^}]*display:\s*none\s*!important\s*;/s.test(stylesheet)) {
  failed++;
  process.stdout.write('  FAIL  web hidden-state CSS contract\n');
} else {
  process.stdout.write('  ok    web hidden-state CSS contract\n');
}

// The control socket can open before Discord is ready. Keep a guard against regressing to a UI
// that permanently caches the empty pre-ready guild list.
const webApp = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const webPage = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const webBootGuard = await readFile(new URL('../web/boot-guard.js', import.meta.url), 'utf8');

// Application launches always contain a token fragment. A module-scoped `history` binding is in
// its temporal dead zone when startup calls history.replaceState(), aborting the script before
// tabs and buttons receive handlers even though the static page looks healthy.
if (webApp.includes('const history =')) {
  failed++;
  process.stdout.write('  FAIL  control UI does not shadow window.history during token startup\n');
} else {
  process.stdout.write('  ok    control UI does not shadow window.history during token startup\n');
}

// Execute the actual browser module's synchronous startup with a tokenized launch URL. Network
// access intentionally never resolves: this test is about proving evaluation reaches the point
// where all static controls have installed their handlers.
{
  let replaced = false;
  let handlers = 0;
  const element = { addEventListener: () => (handlers += 1) };
  const never = new Promise(() => undefined);
  try {
    runInNewContext(webApp, {
      URL,
      URLSearchParams,
      location: { href: 'http://127.0.0.1:8787/#token=smoke-control-token-1234567890' },
      sessionStorage: { setItem: () => undefined, getItem: () => '' },
      history: { replaceState: () => (replaced = true) },
      document: {
        getElementById: () => element,
        querySelector: () => element,
        addEventListener: () => (handlers += 1),
      },
      fetch: () => never,
      setInterval: () => 1,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      console,
    });
  } catch (error) {
    failed++;
    process.stdout.write(`  FAIL  tokenized control UI startup (${error instanceof Error ? error.message : error})\n`);
  }
  if (!replaced || handlers < 10) {
    failed++;
    process.stdout.write(`  FAIL  tokenized control UI installs handlers (${handlers} found)\n`);
  } else {
    process.stdout.write(`  ok    tokenized control UI installs handlers (${handlers} found)\n`);
  }
}

if (
  !webPage.includes('src="/boot-guard.js"') ||
  !webPage.includes('id="disconnected-reload"') ||
  !webBootGuard.includes("window.addEventListener('error'")
) {
  failed++;
  process.stdout.write('  FAIL  control UI surfaces module startup failures\n');
} else {
  process.stdout.write('  ok    control UI surfaces module startup failures\n');
}

if (webApp.includes("platform === 'linux'") || webApp.includes('PipeWire') || webApp.includes('pipewire-bin')) {
  failed++;
  process.stdout.write('  FAIL  control UI has no Linux/PipeWire paths\n');
} else {
  process.stdout.write('  ok    control UI has no Linux/PipeWire paths\n');
}

// Check the behaviour, not its formatting: the guard may load more than the guild list.
if (!/if \(becameReady\)[\s\S]{0,160}loadGuilds\(\)/.test(webApp)) {
  failed++;
  process.stdout.write('  FAIL  web guild refresh on bot readiness\n');
} else {
  process.stdout.write('  ok    web guild refresh on bot readiness\n');
}

// Several guilds can stream at once. The panel used to render only the first, silently hiding
// every other session; the card template plus a per-guild map is what keeps that honest.
if (
  !webPage.includes('id="session-template"') ||
  !webApp.includes('function renderSessions(') ||
  !/cards\.set\(guildId/.test(webApp)
) {
  failed++;
  process.stdout.write('  FAIL  panel renders every live session\n');
} else {
  process.stdout.write('  ok    panel renders every live session\n');
}

// clipping/silent/droppedMs were computed by the capture helper and thrown away by the UI.
for (const field of ['clipping', 'silent', 'droppedMs']) {
  if (!webApp.includes(field)) {
    failed++;
    process.stdout.write(`  FAIL  panel surfaces tap.${field}\n`);
  } else {
    process.stdout.write(`  ok    panel surfaces tap.${field}\n`);
  }
}

// Local monitoring must observe the encoder, never consume from it, and never be able to block the
// outbound stream: the tee drops when the player falls behind rather than applying backpressure.
const previewSource = await readFile(new URL('../src/audio/preview.ts', import.meta.url), 'utf8');
if (
  !previewSource.includes("stream.on('data', listener)") ||
  !previewSource.includes('MAX_PENDING_BYTES') ||
  !/child\.stdin\.write\(chunk, \(\) =>/.test(previewSource)
) {
  failed++;
  process.stdout.write('  FAIL  local preview tees without backpressure\n');
} else {
  process.stdout.write('  ok    local preview tees without backpressure\n');
}

// Following a user may only ever move an existing stream. Joining a voice channel is not a request
// to start broadcasting somebody's desktop.
const indexSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
if (
  !indexSource.includes('startFollowingOwner') ||
  !/const session = getSession\(after\.guild\.id\);\s*\n\s*if \(!session/.test(indexSource)
) {
  failed++;
  process.stdout.write('  FAIL  follow-user only retargets a live session\n');
} else {
  process.stdout.write('  ok    follow-user only retargets a live session\n');
}

// The wizard derives its step from server state, so it cannot claim a step is done when it is not.
if (!webApp.includes('function wizardStep(') || !webPage.includes('id="wizard"')) {
  failed++;
  process.stdout.write('  FAIL  first-run wizard is state-derived\n');
} else {
  process.stdout.write('  ok    first-run wizard is state-derived\n');
}

const signinSource = await readFile(new URL('../src/signin.ts', import.meta.url), 'utf8');
const diagnosticsSource = await readFile(new URL('../src/diagnostics.ts', import.meta.url), 'utf8');
const registrationSource = await readFile(new URL('../src/registration.ts', import.meta.url), 'utf8');

// client.login() resolves when the gateway accepts the token, well before READY. Returning there
// made the panel announce "signed in" and then immediately render "not signed in to Discord".
if (
  !signinSource.includes('waitForReady') ||
  !/Events\.ClientReady/.test(signinSource) ||
  !/await waitForReady\(client\)/.test(signinSource)
) {
  failed++;
  process.stdout.write('  FAIL  sign-in waits for READY, not just login\n');
} else {
  process.stdout.write('  ok    sign-in waits for READY, not just login\n');
}

// A second login() on a client that is mid-handshake fails, and the failure path resets the
// client - so "Try again" used to destroy the connection it was waiting for.
if (
  !/if \(pending\)[\s\S]{0,120}return pending/.test(signinSource) ||
  !/pending = attempt\(client\)/.test(signinSource)
) {
  failed++;
  process.stdout.write('  FAIL  concurrent sign-in joins the attempt in flight\n');
} else {
  process.stdout.write('  ok    concurrent sign-in joins the attempt in flight\n');
}

// An in-place upgrade leaves an old server serving new assets; without a version handshake the
// only symptom is unexplained 404s from routes the running build has never heard of.
if (
  !webApp.includes('renderStaleBuild') ||
  !webPage.includes('id="stale-build"') ||
  !apiSource.includes('version: versionInfo()')
) {
  failed++;
  process.stdout.write('  FAIL  panel reports a stale server build\n');
} else {
  process.stdout.write('  ok    panel reports a stale server build\n');
}

// AudioTap is the only per-app capture helper; diagnostics must not mention PipeWire.
if (diagnosticsSource.includes('pipewire') || diagnosticsSource.includes('pw-record')) {
  failed++;
  process.stdout.write('  FAIL  diagnostics are Windows-only (no PipeWire)\n');
} else {
  process.stdout.write('  ok    diagnostics are Windows-only (no PipeWire)\n');
}

// A bot token already identifies its application; requiring the id separately only adds a way to
// get it wrong.
if (
  !registrationSource.includes('Routes.currentApplication()') ||
  !/appId \?\? \(await resolveAppId\(rest\)\)/.test(registrationSource) ||
  webPage.includes('id="wizard-appid"')
) {
  failed++;
  process.stdout.write('  FAIL  application id is derived from the bot token\n');
} else {
  process.stdout.write('  ok    application id is derived from the bot token\n');
}

// Source discovery should be push-driven; a spawn-per-tick poll is the thing being replaced.
if (/setInterval\([\s\S]{0,200}loadSources\(\)[\s\S]{0,40}\}, 10_000\)/.test(webApp)) {
  failed++;
  process.stdout.write('  FAIL  source list is no longer polled every 10s\n');
} else {
  process.stdout.write('  ok    source list is no longer polled every 10s\n');
}

if (
  !controlServerSource.includes('POST /api/session') ||
  controlServerSource.includes('bridge_control_session') ||
  !controlServerSource.includes('WS_TICKET_TTL_MS') ||
  !webApp.includes("await post('session')") ||
  !webApp.includes('`auth.${ticket}`') ||
  !webApp.includes('startPolling()') ||
  !webApp.includes("new WebSocket(`${protocol}//${location.host}/ws`, ['bridge-v1', `auth.${ticket}`])")
) {
  failed++;
  process.stdout.write('  FAIL  browser-compatible control connection fallback\n');
} else {
  process.stdout.write('  ok    browser-compatible control connection fallback\n');
}

// .env persistence must round-trip Windows paths through node:util parseEnv. JSON string escaping
// turns a path segment such as \nice into a newline on the next launch.
{
  const { serializeEnvValue } = await import(new URL('../src/control/envFile.ts', import.meta.url).href);
  const samples = ['C:\\ffmpeg\\nice\\bin\\ffmpeg.exe', 'x"y', 'plain value'];
  const roundTrips = samples.every((value) => parseEnv(`X=${serializeEnvValue(value)}`).X === value);
  if (!roundTrips) {
    failed++;
    process.stdout.write('  FAIL  .env values round-trip through parseEnv\n');
  } else {
    process.stdout.write('  ok    .env values round-trip through parseEnv\n');
  }
}

if (webApp.includes("addEventListener('pointerup', commit)")) {
  failed++;
  process.stdout.write('  FAIL  sliders submit only once\n');
} else {
  process.stdout.write('  ok    sliders submit only once\n');
}

if (
  !controlServerSource.includes('POST /api/app/quit') ||
  !webPage.includes('id="quit-btn"') ||
  !webApp.includes("post('app/quit')")
) {
  failed++;
  process.stdout.write('  FAIL  terminal-free app shutdown\n');
} else {
  process.stdout.write('  ok    terminal-free app shutdown\n');
}

for (const asset of ['index.html', 'style.css', 'app.js']) {
  const contents = await readFile(new URL(`../remote/${asset}`, import.meta.url), 'utf8');
  if (!contents.trim()) {
    failed++;
    process.stdout.write(`  FAIL  remote/${asset}\n`);
  } else {
    process.stdout.write(`  ok    remote/${asset}\n`);
  }
}

const remoteServer = await readFile(new URL('../src/remote/server.ts', import.meta.url), 'utf8');
const remoteApp = await readFile(new URL('../remote/app.js', import.meta.url), 'utf8');
const remotePage = await readFile(new URL('../remote/index.html', import.meta.url), 'utf8');
if (
  !remoteServer.includes("GET /api/options") ||
  !remoteServer.includes("POST /api/stream") ||
  !remoteApp.includes("post('stream'") ||
  !remotePage.includes('id="guild"') ||
  !remotePage.includes('id="source"')
) {
  failed++;
  process.stdout.write('  FAIL  remote source/destination controls\n');
} else {
  process.stdout.write('  ok    remote source/destination controls\n');
}

// Album art can be hundreds of kilobytes. Snapshots arrive twice a second and contain one object
// per guild, so they must carry metadata only and fetch the image once when the track changes.
if (
  !apiSource.includes('nowPlaying: nowPlayingSummary()') ||
  !remoteServer.includes('nowPlaying: nowPlayingSummary()') ||
  !remoteServer.includes("GET /api/now-playing") ||
  !webApp.includes("api('now-playing')") ||
  !remoteApp.includes("api('now-playing')")
) {
  failed++;
  process.stdout.write('  FAIL  artwork is loaded once per track outside status snapshots\n');
} else {
  process.stdout.write('  ok    artwork is loaded once per track outside status snapshots\n');
}

if (remoteApp.includes("querySelector('output')")) {
  failed++;
  process.stdout.write('  FAIL  remote sliders target their current value labels\n');
} else {
  process.stdout.write('  ok    remote sliders target their current value labels\n');
}

const integerPipeArgs = buildArgs({
  input: {
    kind: 'pipe',
    format: {
      sampleRate: 48_000,
      channels: 2,
      sampleFormat: 's16le',
      bitsPerSample: 16,
      encoding: 'Pcm',
      latencyMs: 0,
      source: 'smoke',
      gainAppliedInTap: false,
    },
  },
  bitrate: 96_000,
  gainDb: 6,
});
const filterIndex = integerPipeArgs.indexOf('-af');
if (filterIndex === -1 || !integerPipeArgs[filterIndex + 1]?.includes('volume=6dB')) {
  failed++;
  process.stdout.write('  FAIL  integer PCM gain fallback\n');
} else {
  process.stdout.write('  ok    integer PCM gain fallback\n');
}

process.stdout.write(failed === 0 ? '\nsmoke test passed\n' : `\n${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);

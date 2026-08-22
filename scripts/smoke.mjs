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

process.env.DISCORD_TOKEN ||= 'smoke-test-placeholder';
process.env.DISCORD_APP_ID ||= '0';
// Keep the control panel from binding a port during the check.
process.env.CONTROL_PORT ||= '0';
// Importing the logger should not create runtime artifacts during a smoke test.
process.env.LOG_FILE ||= 'off';

const modules = [
  '../src/config.ts',
  '../src/logger.ts',
  '../src/platform.ts',
  '../src/commands.ts',
  '../src/audio/tap.ts',
  '../src/audio/pacer.ts',
  '../src/audio/pipewire.ts',
  '../src/audio/encoder.ts',
  '../src/voice/session.ts',
  '../src/control/server.ts',
  '../src/control/launcher.ts',
  '../src/control/api.ts',
  '../src/control/envFile.ts',
  '../src/remote/server.ts',
  '../src/registration.ts',
  '../src/doctor.ts',
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

// A second application-menu click should open the authenticated panel from the running process,
// not start another Discord client. Exercise token parsing and the authenticated state probe
// without binding a real port.
{
  const temp = await mkdtemp(join(tmpdir(), 'discord-audio-bridge-launcher-'));
  const tokenPath = join(temp, '.control-token');
  const token = 'desktop-launcher-smoke-token-123456';
  await writeFile(tokenPath, JSON.stringify({ port: 8787, token }), 'utf8');

  const requested = [];
  const { findRunningControlPanel } = await import(
    new URL('../src/control/launcher.ts', import.meta.url).href
  );
  const panel = await findRunningControlPanel(tokenPath, async (input) => {
    requested.push(String(input));
    return new Response(JSON.stringify({ bot: { ready: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  await rm(temp, { recursive: true, force: true });

  if (
    panel !== `http://127.0.0.1:8787/?token=${token}` ||
    requested.length !== 1 ||
    !requested[0].includes(`/api/state?token=${token}`)
  ) {
    failed++;
    process.stdout.write('  FAIL  desktop launcher attaches to running panel\n');
  } else {
    process.stdout.write('  ok    desktop launcher attaches to running panel\n');
  }
}

// A real-time producer must be allowed to build the configured jitter reserve. The old Linux
// pacer consumed each 20 ms frame as soon as it arrived, so it never actually primed outside the
// synthetic all-at-once burst used by the pacing test later in this file.
{
  const { PassThrough } = await import('node:stream');
  const { Pacer } = await import(new URL('../src/audio/pacer.ts', import.meta.url).href);
  const source = new PassThrough();
  const pacer = new Pacer(source, { sampleRate: 48_000, channels: 2, targetMs: 100 });
  const frame = new Float32Array(48_000 * 2 * 0.02).fill(0.25);
  let outputBytes = 0;
  let firstAudibleMs = Infinity;
  pacer.stream.on('data', (chunk) => {
    if (firstAudibleMs === Infinity) {
      const samples = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.length / 4);
      if (samples.some((sample) => sample !== 0)) {
        firstAudibleMs = (outputBytes / (48_000 * 2 * 4)) * 1000;
      }
    }
    outputBytes += chunk.length;
  });
  const feeder = setInterval(() => source.write(Buffer.from(frame.buffer)), 20);
  await new Promise((resolve) => setTimeout(resolve, 620));
  clearInterval(feeder);
  await pacer.close();

  if (firstAudibleMs < 80) {
    failed++;
    process.stdout.write(
      `  FAIL  pacer jitter priming (first audio ${firstAudibleMs.toFixed(0)}ms)\n`,
    );
  } else {
    process.stdout.write(`  ok    pacer jitter priming (${firstAudibleMs.toFixed(0)}ms reserve)\n`);
  }
}

const tapSource = await readFile(new URL('../src/audio/tap.ts', import.meta.url), 'utf8');
const envSource = await readFile(new URL('../src/control/envFile.ts', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../src/control/api.ts', import.meta.url), 'utf8');
const controlServerSource = await readFile(new URL('../src/control/server.ts', import.meta.url), 'utf8');
const packageSource = await readFile(new URL('./package.mjs', import.meta.url), 'utf8');
const desktopSource = await readFile(
  new URL('../packaging/discord-audio-bridge.desktop', import.meta.url),
  'utf8',
);
const envExample = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
if (
  /if \(children\.length === 0\) return;[\s\S]{0,800}closeAllPipedTaps/.test(tapSource) ||
  !envSource.includes("join(runtimeRoot, '.env')") ||
  apiSource.includes("runScript('register')") ||
  !packageSource.includes('readdirSync(audioTapDir') ||
  !packageSource.includes('`overrides:`') ||
  !packageSource.includes("join(appDir, 'discord-audio-bridge.png')") ||
  !packageSource.includes('BRIDGE_RUNTIME_ROOT=') ||
  !packageSource.includes('/usr/share/applications/discord-audio-bridge.desktop') ||
  !packageSource.includes('/usr/share/metainfo/discord-audio-bridge.metainfo.xml') ||
  !controlServerSource.includes('mode: 0o600') ||
  !desktopSource.includes('Exec=discord-audio-bridge --open') ||
  !desktopSource.includes('Terminal=false')
) {
  failed++;
  process.stdout.write('  FAIL  packaged runtime regression contracts\n');
} else {
  process.stdout.write('  ok    packaged runtime regression contracts\n');
}

const markdown = await Promise.all(
  [
    '../README.md',
    '../CHANGELOG.md',
    '../CONTRIBUTING.md',
    '../CODE_OF_CONDUCT.md',
    '../SECURITY.md',
    '../docs/cross-platform.md',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
);
const documentation = markdown.join('\n');
if (
  /github\.com\/(?:OWNER|<owner>)/i.test(documentation) ||
  /apt install pipewire-utils/i.test(documentation) ||
  documentation.includes('docs.discord.food') ||
  documentation.includes('npm run dist') ||
  !documentation.includes('pipewire-bin') ||
  !packageSource.includes('pipewire-bin | pipewire') ||
  !envExample.includes('relative to the writable runtime root')
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
if (webApp.includes("if (state.capabilities?.platform === 'linux')")) {
  failed++;
  process.stdout.write('  FAIL  source renderer uses snapshot state safely\n');
} else if (!webApp.includes("ui.state?.capabilities?.platform === 'linux'")) {
  failed++;
  process.stdout.write('  FAIL  source renderer uses snapshot state safely\n');
} else {
  process.stdout.write('  ok    source renderer uses snapshot state safely\n');
}

if (!/becameReady[\s\S]*if \(becameReady\) void loadGuilds\(\)/.test(webApp)) {
  failed++;
  process.stdout.write('  FAIL  web guild refresh on bot readiness\n');
} else {
  process.stdout.write('  ok    web guild refresh on bot readiness\n');
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

// The Linux capture helper is pw-record paced by the Pacer. Pacing is the property the whole
// stream's survival rests on, so exercise it for real: feed one burst of sine, let the pacer run
// dry, and check it kept emitting real-time audio (silence fill) with honest metering.
{
  const { PassThrough } = await import('node:stream');
  const { Pacer } = await import(new URL('../src/audio/pacer.ts', import.meta.url).href);

  const sampleRate = 48_000;
  const source = new PassThrough();
  const pacer = new Pacer(source, { sampleRate, channels: 2, targetMs: 60 });

  let bytes = 0;
  pacer.stream.on('data', (chunk) => (bytes += chunk.length));

  // Stats describe the most recent interval, so the sine's window must be observed live rather
  // than read from the final snapshot (which correctly reports the silence that followed).
  let peakSeen = -Infinity;
  const peakSampler = setInterval(() => {
    const peak = pacer.stats.peakDb[0];
    if (peak !== undefined && peak > peakSeen) peakSeen = peak;
  }, 50);

  // 300 ms of a 440 Hz sine at half-scale: peak must land at -6 dBFS in the stats.
  const samples = new Float32Array((sampleRate * 2 * 300) / 1000);
  for (let i = 0; i < samples.length; i += 2) {
    const value = 0.5 * Math.sin((2 * Math.PI * 440 * i / 2) / sampleRate);
    samples[i] = value;
    samples[i + 1] = value;
  }
  source.write(Buffer.from(samples.buffer));

  const started = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const elapsedMs = performance.now() - started;

  const stats = pacer.stats;
  const outputMs = (bytes / (sampleRate * 2 * 4)) * 1000;
  clearInterval(peakSampler);
  await pacer.close();

  const pacingError = Math.abs(outputMs - elapsedMs);
  if (pacingError > 150) {
    failed++;
    process.stdout.write(`  FAIL  pacer real-time pacing (emitted ${outputMs.toFixed(0)}ms in ${elapsedMs.toFixed(0)}ms)\n`);
  } else {
    process.stdout.write(`  ok    pacer real-time pacing (${pacingError.toFixed(0)}ms error over ~1.1s)\n`);
  }

  if (stats.paddedMs < 500) {
    failed++;
    process.stdout.write(`  FAIL  pacer silence fill (padded ${stats.paddedMs.toFixed(0)}ms after the burst)\n`);
  } else {
    process.stdout.write(`  ok    pacer silence fill (${stats.paddedMs.toFixed(0)}ms)\n`);
  }

  if (peakSeen < -8 || peakSeen > -4) {
    failed++;
    process.stdout.write(`  FAIL  pacer metering (peak ${peakSeen.toFixed(1)} dBFS, expected ~-6 for a half-scale sine)\n`);
  } else {
    process.stdout.write(`  ok    pacer metering (peak ${peakSeen.toFixed(1)} dBFS)\n`);
  }
}

process.stdout.write(failed === 0 ? '\nsmoke test passed\n' : `\n${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);

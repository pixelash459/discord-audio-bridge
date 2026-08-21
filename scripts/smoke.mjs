// Import every module the bot loads at startup.
//
// `tsc --noEmit` is not enough on its own: Node strips types at runtime, so a construct tsc
// accepts but the stripper rejects would still break `npm start`. Actually importing each module
// proves they parse, link, and have no top-level side effect that throws.
//
// Run directly (`node scripts/smoke.mjs`) or via CI.

import { readFile } from 'node:fs/promises';

process.env.DISCORD_TOKEN ||= 'smoke-test-placeholder';
process.env.DISCORD_APP_ID ||= '0';
// Keep the control panel from binding a port during the check.
process.env.CONTROL_PORT ||= '0';
// Importing the logger should not create runtime artifacts during a smoke test.
process.env.LOG_FILE ||= 'off';

const modules = [
  '../src/config.ts',
  '../src/logger.ts',
  '../src/commands.ts',
  '../src/audio/tap.ts',
  '../src/audio/encoder.ts',
  '../src/voice/session.ts',
  '../src/control/server.ts',
  '../src/control/api.ts',
  '../src/control/envFile.ts',
  '../src/remote/server.ts',
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

process.stdout.write(failed === 0 ? '\nsmoke test passed\n' : `\n${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);

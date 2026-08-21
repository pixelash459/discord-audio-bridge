// Import every module the bot loads at startup.
//
// `tsc --noEmit` is not enough on its own: Node strips types at runtime, so a construct tsc
// accepts but the stripper rejects would still break `npm start`. Actually importing each module
// proves they parse, link, and have no top-level side effect that throws.
//
// Run directly (`node scripts/smoke.mjs`) or via CI.

process.env.DISCORD_TOKEN ||= 'smoke-test-placeholder';
process.env.DISCORD_APP_ID ||= '0';
// Keep the control panel from binding a port during the check.
process.env.CONTROL_PORT ||= '0';

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

process.stdout.write(failed === 0 ? '\nsmoke test passed\n' : `\n${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);

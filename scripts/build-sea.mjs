// Turns dist/bridge.cjs into a single-file executable using Node's built-in `--build-sea`.
//
// useCodeCache stays off: it speeds startup slightly but disables dynamic import(), which the
// bot uses. useSnapshot is off too; it requires a dedicated snapshot entry point for no
// meaningful win in a long-running server process.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const main = fileURLToPath(new URL('../dist/bridge.cjs', import.meta.url));
const output = `${dist}${process.platform === 'win32' ? 'discord-audio-bridge.exe' : 'discord-audio-bridge'}`;

const help = execFileSync(process.execPath, ['--help'], { encoding: 'utf8' });
if (!help.includes('--build-sea')) {
  console.error(
    'This Node cannot build single executables natively (no --build-sea). ' +
      'Install Node 26 or newer — only the BUILD needs it; the bot itself runs on 22.18+.',
  );
  process.exit(1);
}

mkdirSync(dist, { recursive: true });
const config = `${dist}sea-config.json`;
writeFileSync(
  config,
  JSON.stringify(
    {
      main,
      output,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
console.log(`built ${output}`);

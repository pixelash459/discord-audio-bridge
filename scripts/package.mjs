// Packages the bot for Windows: bundle -> single executable -> staged ZIP.
//
//   dist/stage/discord-audio-bridge/   portable layout (binary + assets side by side)
//   dist/release/*.zip                release archive
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const release = join(dist, 'release');

if (process.platform !== 'win32') {
  throw new Error('Packaging is Windows-only. Run npm run package on a Windows host.');
}

const ARCH = process.arch === 'x64' ? 'amd64' : process.arch;
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `discord-audio-bridge-${version}-windows-${ARCH}`;

function run(command, args, opts = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', cwd: root, ...opts });
}

/* ── build the executable ─────────────────────────────────────────────────── */

run(process.execPath, [fileURLToPath(new URL('./build-bundle.mjs', import.meta.url))]);
run(process.execPath, [fileURLToPath(new URL('./build-sea.mjs', import.meta.url))]);

const binaryName = 'discord-audio-bridge.exe';
const binary = join(dist, binaryName);
if (!existsSync(binary)) throw new Error(`expected ${binary} to exist after the SEA build`);

// Release ZIPs must work on a clean Windows installation. The development helper stays small
// and framework-dependent, while the packaged copy embeds the .NET runtime into one executable.
const packagedAudioTapDir = join(dist, 'audio-tap');
rmSync(packagedAudioTapDir, { recursive: true, force: true });
run('dotnet', [
  'publish',
  join(root, 'native', 'AudioTap', 'AudioTap.csproj'),
  '--configuration', 'Release',
  '--runtime', 'win-x64',
  '--self-contained', 'true',
  '--output', packagedAudioTapDir,
  '--nologo',
  '-p:PublishSingleFile=true',
  '-p:EnableCompressionInSingleFile=true',
  '-p:DebugType=none',
  '-p:GenerateDocumentationFile=false',
]);

/* ── external node_modules tree (davey and friends) ───────────────────────── */

// Walk davey's dependency closure over what is actually installed on this machine, so each
// platform ships exactly the native/WASM bindings npm picked for it.
function externalPackages() {
  const nodeModules = join(root, 'node_modules');
  const wanted = new Set();
  const queue = ['@snazzah/davey'];
  while (queue.length > 0) {
    const pkgName = queue.pop();
    if (wanted.has(pkgName)) continue;
    const manifest = join(nodeModules, ...pkgName.split('/'), 'package.json');
    if (!existsSync(manifest)) continue; // optional platform binding not installed here
    wanted.add(pkgName);
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    queue.push(...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}));
  }
  return [...wanted];
}

/* ── stage the portable layout ────────────────────────────────────────────── */

const stage = join(dist, 'stage', 'discord-audio-bridge');
rmSync(join(dist, 'stage'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

cpSync(binary, join(stage, binaryName));
for (const asset of ['web', 'remote', 'LICENSE', 'README.md', 'package.json', '.env.example']) {
  cpSync(join(root, asset), join(stage, asset), { recursive: true });
}
const nodeModulesStage = join(stage, 'node_modules');
for (const pkgName of externalPackages()) {
  cpSync(
    join(root, 'node_modules', ...pkgName.split('/')),
    join(nodeModulesStage, ...pkgName.split('/')),
    { recursive: true },
  );
  const pkgBin = join(nodeModulesStage, ...pkgName.split('/'), 'bin');
  if (existsSync(pkgBin)) rmSync(pkgBin, { recursive: true }); // .node packages ship CLI shims we never call
}

const audioTap = join(packagedAudioTapDir, 'AudioTap.exe');
if (!existsSync(audioTap)) {
  throw new Error('The self-contained AudioTap publish did not produce AudioTap.exe.');
}
// PublishSingleFile normally leaves only the executable, but copy any additional runtime files
// the .NET SDK considers necessary rather than assuming the output shape forever.
for (const entry of readdirSync(packagedAudioTapDir, { withFileTypes: true })) {
  if (entry.isFile()) cpSync(join(packagedAudioTapDir, entry.name), join(stage, entry.name));
}

/* ── produce the Windows archive ──────────────────────────────────────────── */

mkdirSync(release, { recursive: true });
run('powershell', [
  '-NoProfile', '-Command',
  `Compress-Archive -Force -Path "${join(dist, 'stage', '*')}" -DestinationPath "${join(release, `${name}.zip`)}"`,
]);

console.log(`\npackaged into ${release}`);

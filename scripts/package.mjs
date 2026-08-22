// Packages the bot for the CURRENT platform: bundle -> single executable -> staged layouts.
//
//   dist/stage/discord-audio-bridge/   portable layout (binary + assets side by side)
//                                      -> windows zip, linux tar.gz, AppImage AppDir base
//   dist/fhs/usr/...                   filesystem-hierarchy layout for deb and rpm
//
// Linux artifacts beyond the tarball (deb, rpm, AppImage) need nfpm / appimagetool on PATH; CI
// installs them, and locally a missing tool is skipped with a warning rather than a failure so
// `npm run dist` remains useful for a quick local build.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const release = join(dist, 'release');
const IS_WINDOWS = process.platform === 'win32';
const ARCH_DEB = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
const ARCH_APPIMAGE = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;

const { version, description } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `discord-audio-bridge-${version}-${IS_WINDOWS ? 'windows' : 'linux'}-${ARCH_DEB}`;

function run(command, args, opts = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', cwd: root, ...opts });
}

/* ── build the executable ─────────────────────────────────────────────────── */

run(process.execPath, [fileURLToPath(new URL('./build-bundle.mjs', import.meta.url))]);
run(process.execPath, [fileURLToPath(new URL('./build-sea.mjs', import.meta.url))]);

const binaryName = IS_WINDOWS ? 'discord-audio-bridge.exe' : 'discord-audio-bridge';
const binary = join(dist, binaryName);
if (!existsSync(binary)) throw new Error(`expected ${binary} to exist after the SEA build`);

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
if (!IS_WINDOWS) chmodSync(join(stage, binaryName), 0o755);

if (IS_WINDOWS) {
  const audioTap = join(root, 'native', 'AudioTap', 'bin', 'AudioTap.exe');
  if (!existsSync(audioTap)) {
    throw new Error('AudioTap.exe is missing — run "npm run build:native" before packaging.');
  }
  // Framework-dependent by design: self-contained .NET would add ~70 MB for a helper that only
  // runs on machines whose user is doing Windows audio work anyway.
  cpSync(audioTap, join(stage, 'AudioTap.exe'));
}

/* ── produce the platform archives ────────────────────────────────────────── */

mkdirSync(release, { recursive: true });

if (IS_WINDOWS) {
  run('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Force -Path "${join(dist, 'stage', '*')}" -DestinationPath "${join(release, `${name}.zip`)}"`,
  ]);
} else {
  const tar = join(release, `${name}.tar.gz`);
  run('tar', ['-czf', tar, '-C', join(dist, 'stage'), 'discord-audio-bridge']);
  await packageLinux();
}

console.log(`\npackaged into ${release}`);

/* ── Linux: deb, rpm, AppImage ────────────────────────────────────────────── */

async function packageLinux() {
  const fhs = join(dist, 'fhs');
  rmSync(fhs, { recursive: true, force: true });
  const lib = join(fhs, 'usr', 'lib', 'discord-audio-bridge');
  const share = join(fhs, 'usr', 'share', 'discord-audio-bridge');
  const bin = join(fhs, 'usr', 'bin');
  mkdirSync(lib, { recursive: true });
  mkdirSync(share, { recursive: true });
  mkdirSync(bin, { recursive: true });

  cpSync(join(stage, binaryName), join(lib, binaryName));
  chmodSync(join(lib, binaryName), 0o755);
  cpSync(nodeModulesStage, join(lib, 'node_modules'), { recursive: true });
  for (const asset of ['web', 'remote', 'package.json', 'LICENSE', 'README.md']) {
    cpSync(join(stage, asset), join(share, asset), { recursive: true });
  }
  const iconDir = join(fhs, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps');
  mkdirSync(iconDir, { recursive: true });
  cpSync(join(root, 'packaging', 'discord-audio-bridge.svg'), join(iconDir, 'discord-audio-bridge.svg'));

  // The wrapper points the binary at its assets; everything user-writable (tokens, logs, the
  // editable .env) lands in ~/.local/state/discord-audio-bridge via the runtime root logic.
  writeFileSync(
    join(bin, 'discord-audio-bridge'),
    [
      '#!/bin/sh',
      'exec env BRIDGE_PROJECT_ROOT=/usr/share/discord-audio-bridge \\',
      '  /usr/lib/discord-audio-bridge/discord-audio-bridge "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const nfpm = process.env['NFPM_PATH'] ?? 'nfpm';
  const hasNfpm = spawnSync(nfpm, ['--version'], { encoding: 'utf8' }).status === 0;
  if (hasNfpm) {
    const config = join(dist, 'nfpm.yaml');
    writeFileSync(
      config,
      [
        `name: discord-audio-bridge`,
        `arch: ${ARCH_DEB}`,
        `platform: linux`,
        `version: ${version}`,
        `section: sound`,
        `priority: optional`,
        `maintainer: discord-audio-bridge contributors <https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge>`,
        `description: "${description.replaceAll('"', '\\"')}"`,
        `vendor: discord-audio-bridge`,
        `license: MIT`,
        `homepage: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge`,
        `deb:`,
        `  depends:`,
        `    - pipewire-utils | pipewire`,
        `  recommends:`,
        `    - ffmpeg`,
        `rpm:`,
        `  group: Applications/Sound`,
        `  depends:`,
        `    - pipewire-utils`,
        `contents:`,
        `  - src: ${join(lib, binaryName).replaceAll('\\', '/')}`,
        `    dst: /usr/lib/discord-audio-bridge/${binaryName}`,
        `  - src: ${join(lib, 'node_modules')}`,
        `    dst: /usr/lib/discord-audio-bridge/node_modules`,
        `  - src: ${join(share, 'web')}`,
        `    dst: /usr/share/discord-audio-bridge/web`,
        `  - src: ${join(share, 'remote')}`,
        `    dst: /usr/share/discord-audio-bridge/remote`,
        `  - src: ${join(share, 'package.json')}`,
        `    dst: /usr/share/discord-audio-bridge/package.json`,
        `  - src: ${join(share, 'LICENSE')}`,
        `    dst: /usr/share/licenses/discord-audio-bridge/LICENSE`,
        `  - src: ${join(share, 'README.md')}`,
        `    dst: /usr/share/doc/discord-audio-bridge/README.md`,
        `  - src: ${join(iconDir, 'discord-audio-bridge.svg')}`,
        `    dst: /usr/share/icons/hicolor/scalable/apps/discord-audio-bridge.svg`,
        `  - src: ${join(bin, 'discord-audio-bridge')}`,
        `    dst: /usr/bin/discord-audio-bridge`,
        ``,
      ].join('\n'),
    );
    run(nfpm, ['package', '-f', config, '-p', 'deb', '-t', join(release, `${name}.deb`)]);
    run(nfpm, ['package', '-f', config, '-p', 'rpm', '-t', join(release, `${name}.rpm`)]);
  } else {
    console.warn('nfpm not found — skipping .deb/.rpm (install: go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest)');
  }

  const appimagetool = process.env['APPIMAGETOOL_PATH'] ?? 'appimagetool';
  const hasAppimagetool = spawnSync(appimagetool, ['--version'], { encoding: 'utf8' }).status === 0;
  if (hasAppimagetool) {
    const appDir = join(dist, 'DiscordAudioBridge.AppDir');
    rmSync(appDir, { recursive: true, force: true });
    cpSync(fhs, appDir, { recursive: true });
    cpSync(join(root, 'packaging', 'icon-256.png'), join(appDir, 'icon-256.png'));
    cpSync(join(root, 'packaging', 'icon-256.png'), join(appDir, '.DirIcon'));
    cpSync(join(root, 'packaging', 'discord-audio-bridge.desktop'), join(appDir, 'discord-audio-bridge.desktop'));
    writeFileSync(
      join(appDir, 'AppRun'),
      [
        '#!/bin/sh',
        'HERE="$(dirname "$(readlink -f "$0")")"',
        'exec env BRIDGE_PROJECT_ROOT="$HERE/usr/share/discord-audio-bridge" \\',
        '  "$HERE/usr/lib/discord-audio-bridge/discord-audio-bridge" "$@"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    run(appimagetool, ['--appimage-extract-and-run', appDir, join(release, `${name}.AppImage`)], {
      env: { ...process.env, ARCH: ARCH_APPIMAGE },
    });
  } else {
    console.warn('appimagetool not found — skipping AppImage');
  }
}

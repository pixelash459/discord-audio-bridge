# Cross-platform: the decisions, and why

How the project maps the same capture/encode/Discord pipeline onto Windows and Linux. The Windows
audio path and packaged ZIP have been exercised on a live host. Linux source imports and the pacer
are covered by automated tests; the checklist below is the remaining real-PipeWire and package
validation to perform on a Linux VM with an active desktop audio session.

## Capture: the best each OS has to offer

Per-app capture is a native-API problem, so each platform uses its native answer:

| | Windows | Linux |
| --- | --- | --- |
| API | WASAPI process loopback (`AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`) | PipeWire stream nodes |
| Helper | `AudioTap.exe` (C#) | `pw-record --raw --target <node> -` (stock PipeWire tool) |
| Capture format | 48 kHz f32le, exactly as requested | 48 kHz f32le, exactly as requested |
| Pacing, silence fill, drift trim | `PacedWriter.cs` inside AudioTap | `src/audio/pacer.ts` in the bot |
| Metering | reported by AudioTap 5×/s | computed in the pacer (every sample passes through) |
| "Everything but this app" | yes (`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET`) | not offered by PipeWire; rejected with a clear error |
| Enumeration | one resident `AudioTap --monitor --with-icons` event feed | coalesced `pw-dump` queries (stream nodes and sinks) |

PipeWire exposes every application's playback stream as its own node, which is why Linux needs
no custom capture binary at all: `pw-record --raw --rate 48000 --channels 2 --format f32 --target
<node> -` writes exactly the float PCM we want to stdout. What it does *not* do is pace: PipeWire
delivers bursts while the target renders and nothing at all while it is idle — the same stall
that kills unpaced streams on Windows. The pacer closes that gap, and because every sample passes
through it, metering rides along for free.

One safety property worth writing down: device capture must never fall back to a bare
`pw-record`. Without `--target`, pw-record records the default **source** — the microphone. The
PipeWire layer resolves every device capture to the sink's monitor node (`<sink>.monitor`, or the
sink itself when no monitor node exists) before spawning anything.

## Voice stack: why the core did not get rewritten

Discord requires DAVE end-to-end encryption for voice calls and disconnects unsupported
clients with close code 4017. `@discordjs/voice` 0.19.2+ implements DAVE through
`@snazzah/davey`, so the working TypeScript voice stack remains in place and distribution is solved
at the packaging layer instead of by rewriting the voice implementation.

## Distribution: one executable per platform

The bot itself becomes one executable per OS/architecture, accompanied by its web assets and the
davey runtime tree. `scripts/package.mjs` produces these layouts:

| Artifact | Contents |
| --- | --- |
| `discord-audio-bridge-<version>-windows-amd64.zip` | `discord-audio-bridge.exe`, self-contained `AudioTap.exe`, both panels, and the davey runtime tree |
| `discord-audio-bridge-<version>-linux-{amd64,arm64}.tar.gz` | Portable Linux layout with the bot executable, panels, and davey runtime tree |
| `.deb` / `.rpm` with the same base name | FHS layout: wrapper in `/usr/bin`, binary/runtime under `/usr/lib`, assets, desktop entry, and AppStream metadata under `/usr/share`; Debian uses `pipewire-bin`, Fedora uses `pipewire-utils`, and the package pulls in `xdg-utils` |
| `discord-audio-bridge-<version>-linux-{amd64,arm64}.AppImage` | The FHS layout wrapped with `AppRun`, including the same click-to-open desktop metadata |

The pipeline is esbuild → Node `--build-sea`:

1. **esbuild** bundles `src/index.ts` to one CommonJS file (SEA executes CommonJS; the sources
   were adjusted to have no top-level await anywhere).
2. **davey cannot be bundled**: it resolves its WASM/native binding with
   `createRequire(__filename)` + `readFileSync` at runtime. Every `@snazzah/davey` import is
   aliased to `scripts/davey-shim.cjs`, which loads the real package from a `node_modules` tree
   shipped next to the executable. SEA's built-in `require` only loads Node built-ins, so the
   shim anchors a fresh `createRequire` at the executable's directory.
3. **`import.meta.url` cannot survive CJS bundling**: `@discordjs/voice` anchors its own davey
   require at `import.meta.url`, which esbuild replaces with `{}`. A build plugin rewrites those
   references to an absolute path (the executable itself when running as SEA), which
   `createRequire` accepts and which resolves against the shipped `node_modules`.
4. **`node --build-sea`** (Node 26+) injects the bundle into a copy of the Node binary — no
   postject step. `useCodeCache` stays off because it disables dynamic `import()`.

Runtime details that make packaged installs behave:

- **Project root discovery** walks up from the executable (or `BRIDGE_PROJECT_ROOT`, set by the
  distro wrappers) to find `web/index.html`.
- **Writable state** lives at `$XDG_STATE_HOME/discord-audio-bridge` when set, otherwise
  `~/.local/state/discord-audio-bridge` for installed Linux packages. Development checkouts use
  their project root; read-only Windows packages use `%APPDATA%\discord-audio-bridge`. That is where
  `.control-token`, `.remote-token`, `logs/`, and the editable `.env` live.
- **System configuration**: Linux packages also read `/etc/discord-audio-bridge/env`; the
  user-level file wins for keys present in both, and real environment variables beat everything.
- **Desktop launch** uses `--open`: the first click starts the bridge and opens its authenticated
  loopback panel, while later clicks probe the saved control endpoint and attach to that process.
  This prevents duplicate Discord clients and capture helpers. **Setup → Quit app** cleanly stops
  the background process, so normal use requires no terminal.
- `--doctor` and `--version` work on the packaged binary, so a broken install can be diagnosed
  without Node on the machine.

## CI

`check` (typecheck, semantic web validation, dependency audit, source/pacer smoke, and authenticated
HTTP/WebSocket integration on Node 22.18 and 26), `native` (.NET 10 Windows AudioTap/desktop builds), and
`package` (Windows x64, Linux x64, and Linux arm64) run for pull requests, pushes to `main`, version
tags, and manual dispatches. Linux arm64 uses GitHub's `ubuntu-24.04-arm` hosted runner. A `v*` tag
also collects every package artifact into a GitHub Release.

## Linux VM validation checklist

Use a VM with a desktop session, an emulated or passed-through output device, PipeWire, and
WirePlumber. A headless server VM cannot validate application or sink capture meaningfully.

### 1. Verify the host tools

Debian/Ubuntu:

```bash
sudo apt update
sudo apt install ffmpeg pipewire-bin
```

Fedora:

```bash
sudo dnf install ffmpeg-free pipewire-utils
```

Then, as the logged-in desktop user (not through `sudo`):

```bash
node --version                 # 22.18+ to run from source; 26+ to build packages
ffmpeg -hide_banner -h encoder=libopus
pw-record --version
pw-dump --help >/dev/null
systemctl --user --no-pager status pipewire wireplumber
```

### 2. Validate the checkout

```bash
git clone https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge
cd discord-audio-bridge
npm ci
cp .env.example .env
npm run typecheck
npm run smoke
npm run doctor
```

Start audio in a normal desktop application before running `doctor`. Its output should list at
least one application stream and one render endpoint. If it does not, verify that `pw-dump`
contains `Stream/Output/Audio` and `Audio/Sink` nodes in the same terminal session.

### 3. Validate Discord and both panels

For a checkout, fill in `.env`, run `npm start`, and open the printed loopback URL. Verify that application and
device sources render, a stream joins the chosen voice channel, meters move, gain and Opus bitrate
changes take effect, and **Mute bot** changes the bot's Discord voice state. From another LAN or
Tailscale device, first opt in with `REMOTE_PORT=8788` and an intentional `REMOTE_HOST`, then open
one of the printed remote URLs and verify source/destination selection,
retargeting, mute, gain, bitrate, and stop.

With `REMOTE_TRUST_TAILSCALE=true`, also confirm `tailscale whois --json <client-ip>` succeeds on the
host. A tailnet-addressed peer is not trusted solely because it falls inside Tailscale's IP ranges.

Pause and resume the source to exercise silence fill. Stop the stream and exit the bot, then check
that no helper was orphaned:

```bash
pgrep -af pw-record || true
```

### 4. Validate the Linux package layout

Package generation requires Node 26+ because it uses `node --build-sea`:

```bash
npm run package
./dist/stage/discord-audio-bridge/discord-audio-bridge --version
./dist/stage/discord-audio-bridge/discord-audio-bridge --doctor
tar -tzf dist/release/discord-audio-bridge-*-linux-*.tar.gz | head
```

The tarball is always produced. `.deb`, `.rpm`, and AppImage outputs are produced only when `nfpm`
and/or `appimagetool` are on `PATH`; CI installs both. For a `.deb` test, install the generated file
with `sudo apt install ./dist/release/*.deb`, then open **Discord Audio Bridge** from the desktop
Applications menu. Confirm the browser opens automatically, a second menu click returns to the
same running panel, and **Setup → Quit app** stops it. Also run `discord-audio-bridge --doctor` as
the desktop user and confirm editable state appears under `$XDG_STATE_HOME/discord-audio-bridge`
(when set) or `~/.local/state/discord-audio-bridge`, rather than under `/usr/share`.

## Current external references

- [Discord voice connections and DAVE](https://docs.discord.com/developers/topics/voice-connections)
- [Discord voice close codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes)
- [Node.js built-in TypeScript support](https://nodejs.org/api/typescript.html)
- [Ubuntu `pipewire-bin` file list](https://packages.ubuntu.com/noble/all/pipewire-bin/filelist)
- [Fedora `pipewire-utils`](https://packages.fedoraproject.org/pkgs/pipewire/pipewire-utils/)
- [GitHub-hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

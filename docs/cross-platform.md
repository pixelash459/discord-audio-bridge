# Cross-platform: the decisions, and why

How this project runs on both Windows and Linux without giving anything up on either. Everything
here was validated empirically before being committed — the build pipeline was proven against the
real `@discordjs/voice` → davey chain on a live Windows host before a line of it landed in `src/`.

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
| Enumeration | `AudioTap --list-processes/--list-devices` | `pw-dump` (stream nodes and sinks) |

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

Discord has required DAVE end-to-end encryption on voice since March 2026 (non-compliant clients
are disconnected with close code 4017). `@discordjs/voice` 0.19.2+ implements DAVE through
`@snazzah/davey`. No Rust (serenity/songbird) or other alternative stack was verifiably DAVE-
compliant at decision time, so rewriting the core in a "more shippable" language would have
traded a working voice connection for nicer binaries. The bot stays TypeScript on Node, and the
distribution problem is solved at the packaging layer instead.

## Distribution: one executable per platform

The deliverable is a single-file executable per OS/arch plus system packages, built by
`scripts/package.mjs`:

| Artifact | Contents |
| --- | --- |
| `windows-x64.zip` | `discord-audio-bridge.exe`, `AudioTap.exe`, panels, davey runtime tree |
| `linux-x64/arm64.tar.gz` | same layout, portable |
| `.deb` / `.rpm` | FHS layout; wrapper at `/usr/bin`, assets under `/usr/share`, binary under `/usr/lib`; depends on `pipewire-utils`, recommends `ffmpeg` |
| `.AppImage` | the FHS layout wrapped with an `AppRun` |

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
- **Writable state** moves to `~/.local/state/discord-audio-bridge` (Linux) or
  `%APPDATA%\discord-audio-bridge` (Windows) whenever the install root is read-only — that is
  where `.control-token`, `.remote-token`, `logs/`, and the editable `.env` live.
- **System configuration**: Linux packages also read `/etc/discord-audio-bridge/env`; the
  user-level file wins for keys present in both, and real environment variables beat everything.
- `--doctor` and `--version` work on the packaged binary, so a broken install can be diagnosed
  without Node on the machine.

## CI

`check` (typecheck + smoke on Node 22.18 and 26), `native` (Windows AudioTap/desktop builds),
and `package` (windows-x64, linux-x64, linux-arm64 — arm64 runs on GitHub's free
`ubuntu-24.04-arm` runners) run on every push. A `v*` tag additionally collects every package
artifact into a GitHub Release.

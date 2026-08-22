# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Release publishing now identifies the GitHub repository explicitly, so the checkout-free release
  job can create the release after downloading its build artifacts.

## [1.1.1] - 2026-08-22

### Fixed

- The desktop source picker no longer crashes with `state is not defined`; process, output-device,
  and DirectShow source lists now render from the latest control snapshot.
- Windows release ZIPs now contain a self-contained AudioTap helper instead of an apphost missing
  its managed DLLs, so per-app and device capture work without a separate .NET installation.
- Packaged builds register slash commands directly through Discord rather than trying to execute
  an npm script and source file that are not shipped.
- Packaged configuration is written to the writable runtime state directory, and per-user Linux
  settings correctly override the system-wide environment file while real environment variables
  remain highest priority.
- The PipeWire pacer now genuinely primes and re-primes its jitter reserve, preserves complete
  channel frames, and does not burst missed ticks after downstream backpressure.
- Linux shutdown always cleans orphaned `pw-record` children, and PipeWire capability detection is
  cached instead of synchronously launching probe processes for every panel snapshot.
- Debian/Ubuntu guidance and package metadata now use `pipewire-bin` (which supplies `pw-record` and
  `pw-dump` there); Fedora guidance continues to use `pipewire-utils`.
- nFPM dependency overrides now use its supported schema, and release CI executes the packaged
  AudioTap binary before accepting a Windows artifact.
- Linux release CI now downloads the correct nFPM architecture, runs appimagetool without FUSE,
  and supplies the desktop entry's required root-level icon when building AppImages.

### Documentation

- Reconciled every project Markdown file with the current Windows/Linux runtime, local and remote
  controls, package filenames, security boundaries, configuration precedence, and CI matrix.
- Added a Linux VM validation checklist and replaced placeholder or obsolete repository links.

## [1.1.0] - 2026-08-22

### Added

- **Linux support.** Per-application capture on Linux via PipeWire: `pw-record --raw --target`
  pulls 48 kHz float from an application's output-stream node, and a TypeScript pacer (the
  counterpart of AudioTap's PacedWriter) provides priming, silence fill, drift trimming, and live
  metering. Device capture targets a sink monitor.
- **Single-file bot executables and installers.** `npm run package` bundles the bot with esbuild and
  embeds it into a Node single executable (`--build-sea`), producing a Windows x64 ZIP and Linux
  x64/arm64 tarballs, `.deb`, `.rpm`, and AppImages. The packaged binary supports `--doctor`,
  `--version`, and `--project-root`; runtime state moves to the per-user state directory when the
  install root is read-only, and Linux packages can read `/etc/discord-audio-bridge/env`.
- The smoke test exercises real-time pacer accuracy, silence fill, and dBFS metering against a
  synthetic sine.

### Fixed

- A capture stream dying mid-session can no longer crash the process with an unhandled stream
  error; it restarts the pipeline, like every other audio failure.
- The control panel now starts *before* signing in to Discord. It previously started inside the
  ready handler, so the Setup tab -- the one screen whose purpose is entering a bot token -- was
  unreachable until a valid token already existed. Saving credentials there signs in immediately
  via `POST /api/signin`, with no restart.
- A failed sign-in no longer exits when the panel is available; it leaves the panel up so the
  problem can be fixed. Headless (`CONTROL_PORT=0`), it still exits non-zero with the reason.

## 1.0.0 - 2026-08-22

First release.

### Added

- **Per-application audio capture** via WASAPI process loopback
  (`ActivateAudioInterfaceAsync` + `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`), at 48 kHz 32-bit float
  with no virtual audio cable and no extra device round trip.
- **AudioTap** capture helper (C#), with a jitter buffer that fills silence when the source app
  pauses and corrects device-clock drift a frame at a time.
- **Opus encoding** through ffmpeg/libopus in float, at 20 ms frames, with `application=audio` and
  complexity 10. Packets reach Discord without ever being decoded.
- **Desktop control panel** — a WinForms + WebView2 shell with live stereo level meters, a source
  picker, a jitter-buffer readout, settings, and a log pane. Also reachable from any browser.
- **Loopback control API** (HTTP + WebSocket), token-authenticated and bound to 127.0.0.1.
- **Slash commands**: `/stream app|device|dshow`, `/stop`, `/status`, `/gain`, `/bitrate`,
  `/quality`, `/sources`, `/diagnose`.
- **DirectShow fallback** for hosts without the .NET SDK, which probes a device's format ladder and
  pins the rung closest to 48 kHz stereo instead of accepting whatever DirectShow defaults to.
- `npm run doctor` and `npm run setup` for diagnosing and preparing a host.

### Notes

- Requires DAVE end-to-end encryption support, which Discord has mandated for all voice
  participants since 1 March 2026. `@discordjs/voice` 0.19.2+ handles this via `@snazzah/davey`.
- ffmpeg's Ogg muxer defaults to one-second pages, which starves the Discord player. This project
  sets `-page_duration 20000`; measured, that is 163 ms to first packet versus 3186 ms.

[Unreleased]: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/releases/tag/v1.1.0

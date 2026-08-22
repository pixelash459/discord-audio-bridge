# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Linux support.** Per-application capture on Linux via PipeWire: `pw-record --raw --target`
  pulls 48 kHz float from any one application's stream node, and a TypeScript pacer
  (the counterpart of AudioTap's PacedWriter) keeps the stream perfectly real time — silence
  fill while the app is idle, drift trimming, and live metering. Device capture targets a sink's
  monitor. Everything else (panel, remote dashboard, slash commands, encoding) is unchanged.
- **Single-file executables and installers.** `npm run package` bundles the bot with esbuild and
  embeds it into a Node single executable (`--build-sea`), producing a Windows x64 zip, Linux
  x64/arm64 tarballs, `.deb`, `.rpm`, and AppImages. Tagging a version publishes all of them as a
  GitHub Release via CI. The packaged binary supports `--doctor`, `--version`, and
  `--project-root`; runtime state lands in `~/.local/state/discord-audio-bridge` (or
  `%APPDATA%`) when the install root is read-only, and Linux packages read
  `/etc/discord-audio-bridge/env` for system-wide configuration.
- The smoke test now exercises the pacer for real: real-time pacing accuracy, silence fill, and
  dBFS metering against a synthetic sine.

### Fixed

- A capture stream dying mid-session can no longer crash the process with an unhandled stream
  error; it restarts the pipeline, like every other audio failure.
- The control panel now starts *before* signing in to Discord. It previously started inside the
  ready handler, so the Setup tab -- the one screen whose purpose is entering a bot token -- was
  unreachable until a valid token already existed. Saving credentials there signs in immediately
  via `POST /api/signin`, with no restart.
- A failed sign-in no longer exits when the panel is available; it leaves the panel up so the
  problem can be fixed. Headless (`CONTROL_PORT=0`), it still exits non-zero with the reason.

## [1.0.0]

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

[Unreleased]: https://github.com/OWNER/discord-audio-bridge/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/OWNER/discord-audio-bridge/releases/tag/v1.0.0

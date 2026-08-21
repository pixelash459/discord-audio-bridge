# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

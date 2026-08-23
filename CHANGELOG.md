# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-08-23

### Added

- **Local monitoring.** A Monitor button on each live session plays the encoded stream back on the
  host, so what you hear has been through the gain stage, the limiter and a real Opus round trip.
  The tee observes the encoder rather than consuming from it and drops rather than buffers when the
  player falls behind, so monitoring can never stall the outbound stream. Needs `ffplay`, which
  ships with a full ffmpeg build; `FFPLAY_PATH` overrides the location.
- **Follow a user between voice channels** (`AUTO_FOLLOW_USER_ID`). Moves a stream that is already
  running to whichever channel that user joins. It never starts one: joining a voice channel is not
  a request to begin broadcasting somebody's desktop.
- **First-run wizard.** A three-step guided setup — token, invite, capture helper — that derives its
  current step from server state rather than remembering local progress, so it cannot claim a step
  is finished when it is not. Dismissing it is remembered.
- **Copyable support reports.** The Logs tab can now copy or download one redacted text report with
  platform diagnostics and every recent log level. Clipboard fallback keeps Copy working in Linux
  browsers and packaged WebViews even when the modern clipboard API is unavailable.

### Fixed

- Application icons now appear for sandboxed child processes. Browsers render audio from content
  processes whose executable path cannot be read, so the picker previously showed one `firefox` row
  with an icon beside identical rows without one.
- Linux source discovery now invokes `pw-dump` with its real command-line contract, filters playback
  nodes from the full PipeWire graph, and recognizes Firefox/Chromium streams. Enumeration failures
  are shown in both control surfaces instead of being mislabeled as “no app is playing.”


## [1.3.1] - 2026-08-23

### Fixed

- Restored every control-panel interaction when the application is opened with its authentication
  fragment. The meter trend map no longer shadows the browser's `history` global during module
  startup, which had aborted JavaScript before tab and button handlers were registered.
- Added an independent startup guard that displays browser-side initialization failures and offers
  a reload action instead of leaving a fully rendered but inert interface.

## [1.3.0] - 2026-08-23

### Added

- Multi-source float mixing with up to four application/device inputs, independent input trims,
  reusable route presets, concurrent guild sessions, optional last-route resume, and automatic
  leave when a channel has no human listeners.
- True-peak limiting and optional EBU R128 loudness matching, with live loudness controls in the
  panel and `/loudness` command.
- One resident Windows AudioTap monitor pushes source/device changes, application icons, and system
  media title/artwork instead of spawning enumeration helpers on a timer. Sources selected by name
  follow an application to its new PID after it restarts.
- Discord activity and voice-channel status integration, Components V2 command responses, and a
  generated invite URL containing every permission used by the bridge.
- Route controls, meters, media artwork, installable-PWA metadata, lock-screen actions, and a
  **Forget this device** action in the remote dashboard.
- A stateful Windows tray icon, mute/stop menu actions and global hotkeys, opt-in autostart,
  remembered window bounds, dark system chrome, and retryable startup failures.

### Security

- Replaced the localhost-wide control cookie with random, single-use WebSocket tickets that expire
  after 30 seconds. The durable control credential is never sent to unrelated loopback ports.
- Fresh installs keep remote access and Tailscale trust disabled until explicitly enabled. Slash
  commands, autocomplete, and message controls are administrator-only by default and at runtime.
- Executable settings validate the expected binary and existing path; log paths stay within the
  runtime root. Windows state files receive an explicit current-user ACL in addition to Unix modes.
- Unexpected API failures and missing static assets no longer reveal host filesystem details.
- CI pins and SHA-256 verifies nFPM, appimagetool, and the AppImage runtime before executing them.

### Fixed

- Failed audio startup now destroys its unregistered voice connection and partial capture pipeline.
  AudioTap/monitor stdin observes asynchronous `EPIPE` errors instead of crashing the bridge.
- Environment values round-trip Windows backslashes and quotes through `node:util.parseEnv`.
- File logging is asynchronous, respects `LOG_LEVEL`, and rotates throughout a long-running session.
- Mixer gain composition, voice mute state commits, PipeWire capability refresh, child-output caps,
  static directory requests, source-monitor concurrency, and native frame/counter synchronization.
- The desktop browser action retains authentication, retry does not duplicate WebView handlers,
  polling cannot overlap, external URI schemes are rejected, Node resolves to an absolute PATH
  entry, and a Windows job object cleans up descendants after forced termination.

## [1.2.1] - 2026-08-23

### Changed

- The local panel now exchanges its bearer credential for an HttpOnly, same-origin browser-session
  cookie before opening its WebSocket. Existing 1.2.0 subprotocol-authenticated pages remain
  compatible during an upgrade.

### Fixed

- A failed or browser-incompatible WebSocket handshake no longer leaves the packaged application
  behind a permanent “Waiting for the bot” overlay. The panel proves HTTP connectivity first and
  transparently falls back to authenticated state polling while live updates reconnect.
- Remote gain and bitrate sliders once again update their visible values while they are dragged.
- CI now exercises the exact bearer-to-cookie exchange and cookie-authenticated WebSocket used by
  browsers, in addition to the legacy upgrade path.

## [1.2.0] - 2026-08-23

### Added

- Reworked both control surfaces around explicit Destination and Source modules, clearer onboarding,
  deliberate Start/Apply actions, responsive touch targets, keyboard navigation, visible focus, and
  semantic live status. The remote dashboard now offers the same route selection as the main app.
- Stage-channel support now promotes the bot to speaker and reports the required **Mute Members**
  permission before joining. Main and remote controls expose Discord self-mute, gain, and the actual
  channel-limited Opus bitrate.
- Live HTTP/WebSocket boundary tests, semantic HTML/JavaScript checks, weekly Dependabot updates,
  and a production dependency audit now run in CI.

### Changed

- Tokens are delivered in URL fragments, removed from the address bar, and sent through Bearer
  headers or WebSocket subprotocols instead of leaking into HTTP request URLs and logs.
- Tokenless tailnet access now verifies the peer through `tailscale whois --json`; matching a broad
  CGNAT or IPv6 range alone is no longer trusted.
- Windows projects target .NET 10 LTS. TypeScript 7, esbuild 0.28, Node 26 types, and all official
  GitHub Actions were updated to current releases; workflow actions are pinned to immutable commits.

### Fixed

- Rapid capture/encoder failures no longer reset the retry counter as soon as one packet arrives.
  A pipeline must remain healthy for 30 seconds to regain its bounded retry budget, preventing an
  endless AudioTap/ffmpeg process loop. All capture helpers are tracked and cleaned up on shutdown;
  overlapping source refreshes are coalesced and briefly cached instead of spawning duplicate
  AudioTap, `pw-dump`, or DirectShow enumeration processes.
- Destroyed voice sessions remove themselves from the registry, Discord mute status reflects the
  live voice state, PipeWire targets are revalidated before capture, and `pw-record` launch failures
  are surfaced immediately.
- API, configuration, environment-file, audio-source, path, port, gain, and bitrate inputs are now
  strictly typed and range checked, including NaN/infinity rejection and safe environment quoting.
- Both web servers now enforce request/header/idle timeouts, bounded rate limits, JSON body limits,
  same-origin and DNS-rebinding checks, restrictive browser headers, WebSocket payload/client/
  backpressure limits, and generic internal-error responses.
- Fatal asynchronous errors now perform bounded graceful cleanup with a non-zero exit code.

## [1.1.3] - 2026-08-23

### Fixed

- Packaged startup no longer mistakes `process.argv[0]` for a missing `--project-root` value. That
  bug ignored the Linux wrapper's asset-root override and made the local panel return `Not found`.
- DEB/RPM desktop entries now invoke `/usr/bin/discord-audio-bridge` explicitly, while the runtime
  also recognizes the standard `/usr/share/discord-audio-bridge` asset location without relying on
  launcher environment. Missing assets now produce a diagnostic path in logs and the HTTP response.

## [1.1.2] - 2026-08-22

### Added

- Linux DEB and RPM packages now install a normal Applications-menu launcher. It starts the bridge,
  opens the authenticated local control panel in the default browser, and attaches to the existing
  process on later clicks instead of spawning duplicate bots or audio capture helpers.
- The Setup tab now has a **Quit app** control for cleanly stopping a background packaged launch.

### Fixed

- Release publishing now identifies the GitHub repository explicitly, so the checkout-free release
  job can create the release after downloading its build artifacts.
- Installed Linux launchers now force writable state into the user's XDG state directory, include
  desktop and AppStream metadata in DEB/RPM payloads, run without a terminal window, and suppress
  Node's expected single-executable experimental warning using the correctly named SEA build option.
- Saved bot credentials and local/remote control tokens are tightened to user-only file permissions
  on supported filesystems, including existing token files created by an older release.

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

[Unreleased]: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/releases/tag/v1.1.0

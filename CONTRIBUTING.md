# Contributing

Thanks for taking a look. The project combines a TypeScript bot, two plain-web control surfaces,
a Windows capture helper, and an optional Windows desktop shell, so this document focuses on where
things live and which parts are platform-specific.

## Getting set up

### Windows

```powershell
git clone https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge
cd discord-audio-bridge
npm run setup      # installs dependencies, builds AudioTap and the desktop shell, creates .env
```

`npm run setup` is safe to re-run and never overwrites an existing `.env`.

You need Node 22.18+, ffmpeg with libopus, and .NET 10 SDK for the two Windows projects. Windows 10
version 2004 (build 19041) or newer is required for per-process capture.

### Linux

```bash
git clone https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge
cd discord-audio-bridge
npm ci
cp .env.example .env
npm run doctor
npm start
```

Linux has no native project to compile. Install Node 22.18+, ffmpeg, and the PipeWire commands
`pw-record` and `pw-dump` (`pipewire-bin` on Debian/Ubuntu, `pipewire-utils` on Fedora). Run the bot
as the desktop-session user that owns the PipeWire graph.

## The shape of the repo

```text
src/                 The bot. TypeScript, run directly by Node — there is no build step.
  audio/             Windows AudioTap and Linux PipeWire capture, pacing, and ffmpeg/libopus.
  voice/             One BridgeSession per guild; owns tap + encoder + voice connection.
  control/           Loopback HTTP + WebSocket API behind the control panel.
  commands.ts        Slash commands. Shares its plumbing with the control API.

web/                 The control panel. Plain HTML/CSS/ES modules, no bundler, no framework.
remote/              Restricted LAN/Tailscale dashboard. Plain HTML/CSS/JS.

native/AudioTap/     C#. Per-process WASAPI loopback capture (Windows only).
desktop/BridgeApp/   C#. WinForms + WebView2 shell around web/, plus a tray icon.

scripts/             PowerShell setup/build helpers plus JavaScript bundle/package tooling.
packaging/           Linux desktop entry and package icons.
```

### Why TypeScript with no build step

Node 22.18+ strips types at runtime, so `node src/index.ts` just works. `tsconfig.json` sets
`erasableSyntaxOnly`, which keeps the code inside the subset Node can strip — no `enum`, no
parameter properties, no namespaces. `npm run typecheck` is the real check; CI runs it plus an
import smoke test, because a syntax error that `tsc` tolerates could still break startup.

### Why there is native code at all

On Windows, per-process loopback capture goes through `ActivateAudioInterfaceAsync` with
`AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`. There is no Node binding for it, and the alternative —
routing through a virtual audio cable — is measurably worse and adds a configuration burden.
AudioTap captures, paces, and writes PCM to stdout. Linux uses PipeWire's existing `pw-record`
tool and performs pacing in `src/audio/pacer.ts`, so no Linux-native helper is needed.

### Why the desktop app is WebView2 and not Electron

Current Windows installations include the WebView2 runtime, so the framework-dependent shell does
not bundle a browser. It reuses the .NET toolchain needed for AudioTap. Everything it shows is the
same page the bot serves on loopback, so the UI can be developed with `npm start` and a browser.

## Working on each piece

**The bot** — `npm run dev` restarts on change. Set `LOG_LEVEL=debug` in `.env` to see the exact
ffmpeg command line and every event from the tap.

**The control panel** — `npm start`, then open the printed URL. Edit files under `web/` and
refresh; there is nothing to rebuild.

**AudioTap (Windows)** — `npm run build:native`. It is usable standalone, which is the fastest way
to test Windows capture changes:

```powershell
native\AudioTap\bin\AudioTap.exe --list-processes
native\AudioTap\bin\AudioTap.exe --capture --pid 1234 > out.raw
```

stdout is raw PCM; stderr is one JSON object per line.

**PipeWire capture (Linux)** — start audio in an application, confirm `pw-dump` exposes a
`Stream/Output/Audio` node, then use `npm run doctor` before testing through the panel.

**The desktop shell (Windows)** — `npm run app` builds and launches it. It attaches to an
already-running bot on the configured local control port, so you can keep `npm start` open while
iterating on the shell.

## Before opening a pull request

On every platform:

```text
npm run typecheck
npm run lint:web
npm run smoke
```

On Windows, also run:

```powershell
dotnet build DiscordAudioBridge.sln -c Release -warnaserror
```

CI runs TypeScript, semantic HTML/JS, npm security, authenticated HTTP/WebSocket, and audio-pacer
checks on Node 22.18 and 26. It builds both .NET 10 C# projects with warnings as errors and packages
Windows x64 plus Linux x64/arm64. Please do not suppress a warning without explaining why in a comment.

## Style

Match what is already there. A few things that are deliberate:

- **Comments explain why, not what.** Most of the non-obvious decisions in this codebase are
  audio-specific and would look arbitrary otherwise — `-page_duration 20000`, requesting 48 kHz
  from the tap, `inlineVolume: false`. If you change one of those, move the comment with it.
- **Measure claims about quality.** "Sounds better" is not reviewable. The README's numbers all
  come from scripts that anyone can re-run.
- Two-space indent for TS/JS, four for C# and PowerShell. `.editorconfig` covers it.

## Changes that need extra care

- **The audio path.** Anything between a WASAPI/PipeWire capture source and the Opus packet affects
  quality for every user. Say what you measured and on which OS.
- **`PacedWriter.cs`.** It is the reason the stream survives a paused app and a drifting device
  clock. It is also the easiest place to introduce a click or a slow drift that only shows up
  after an hour.
- **`src/audio/pacer.ts`.** This is the Linux counterpart: preserve complete channel frames,
  priming, real-time pacing, silence fill, and backpressure recovery.
- **`src/control/`.** It listens on a socket and can rewrite `.env`. Keep it bound to 127.0.0.1,
  keep Bearer authentication plus single-use WebSocket tickets and origin/Host checks on every
  protected route, and never return the bot token to a client. Never put a credential in a
  localhost cookie: browser cookies do not distinguish ports.
- **`src/remote/` and `remote/`.** This surface intentionally binds to the network. Keep its API
  restricted to runtime streaming controls, verify tokenless tailnet peers through the Tailscale
  daemon, and treat source enumeration as host information.

## Reporting bugs

`npm run doctor` prints everything about the host's audio setup and dependency versions. Please
include its output — it answers most of the first round of questions by itself.

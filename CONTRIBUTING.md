# Contributing

Thanks for taking a look. This project has a slightly unusual shape — three components in two
languages — so this document is mostly about where things live and why.

## Getting set up

```powershell
git clone https://github.com/<owner>/discord-audio-bridge
cd discord-audio-bridge
npm run setup      # checks prerequisites, installs, builds both native pieces, creates .env
```

`npm run setup` is safe to re-run and never overwrites an existing `.env`.

You need Node 22.18+, ffmpeg with libopus, and (for the native halves) the .NET SDK 9+. Windows 10
build 19041 or newer is required for per-process capture.

## The shape of the repo

```
src/                 The bot. TypeScript, run directly by Node — there is no build step.
  audio/             Capture (AudioTap wrapper) and encoding (ffmpeg/libopus).
  voice/             One BridgeSession per guild; owns tap + encoder + voice connection.
  control/           Loopback HTTP + WebSocket API behind the control panel.
  commands.ts        Slash commands. Shares its plumbing with the control API.

web/                 The control panel. Plain HTML/CSS/ES modules, no bundler, no framework.

native/AudioTap/     C#. Per-process WASAPI loopback capture. The only piece that must be native.
desktop/BridgeApp/   C#. WinForms + WebView2 shell around web/, plus a tray icon.

scripts/             PowerShell entry points, all reachable via npm run.
```

### Why TypeScript with no build step

Node 22.18+ strips types at runtime, so `node src/index.ts` just works. `tsconfig.json` sets
`erasableSyntaxOnly`, which keeps the code inside the subset Node can strip — no `enum`, no
parameter properties, no namespaces. `npm run typecheck` is the real check; CI runs it plus an
import smoke test, because a syntax error that `tsc` tolerates could still break startup.

### Why there is native code at all

Per-process loopback capture goes through `ActivateAudioInterfaceAsync` with
`AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`. There is no Node binding for it, and the alternative —
routing through a virtual audio cable — is measurably worse and adds a configuration burden.
AudioTap is deliberately tiny: it captures, paces, and writes PCM to stdout. Nothing else.

### Why the desktop app is WebView2 and not Electron

WebView2 ships with Windows, so the shell is ~4 MB instead of ~150 MB, and it reuses the .NET SDK
the project already needs for AudioTap. Everything the desktop app shows is the same page the bot
serves on loopback, so the UI can be developed with nothing but `npm start` and a browser.

## Working on each piece

**The bot** — `npm run dev` restarts on change. Set `LOG_LEVEL=debug` in `.env` to see the exact
ffmpeg command line and every event from the tap.

**The control panel** — `npm start`, then open the printed URL. Edit files under `web/` and
refresh; there is nothing to rebuild.

**AudioTap** — `npm run build:native`. It is usable standalone, which is the fastest way to test
capture changes:

```powershell
native\AudioTap\bin\AudioTap.exe --list-processes
native\AudioTap\bin\AudioTap.exe --capture --pid 1234 > out.raw
```

stdout is raw PCM; stderr is one JSON object per line.

**The desktop shell** — `npm run app` builds and launches it. It attaches to an already-running
bot if it finds one, so you can keep `npm start` open in a terminal while iterating on the shell.

## Before opening a pull request

```powershell
npm run typecheck
dotnet build native/AudioTap/AudioTap.csproj -c Release -warnaserror
dotnet build desktop/BridgeApp/BridgeApp.csproj -c Release -warnaserror
```

CI runs exactly these, with `-warnaserror` on both C# projects. Please do not suppress a warning
without saying why in a comment.

## Style

Match what is already there. A few things that are deliberate:

- **Comments explain why, not what.** Most of the non-obvious decisions in this codebase are
  audio-specific and would look arbitrary otherwise — `-page_duration 20000`, requesting 48 kHz
  from the tap, `inlineVolume: false`. If you change one of those, move the comment with it.
- **Measure claims about quality.** "Sounds better" is not reviewable. The README's numbers all
  come from scripts that anyone can re-run.
- Two-space indent for TS/JS, four for C# and PowerShell. `.editorconfig` covers it.

## Changes that need extra care

- **The audio path.** Anything between the WASAPI callback and the Opus packet affects quality for
  every user. Say what you measured.
- **`PacedWriter.cs`.** It is the reason the stream survives a paused app and a drifting device
  clock. It is also the easiest place to introduce a click or a slow drift that only shows up
  after an hour.
- **`src/control/`.** It listens on a socket and can rewrite `.env`. Keep it bound to 127.0.0.1,
  keep the token check on every route, and never return the bot token to a client.

## Reporting bugs

`npm run doctor` prints everything about the host's audio setup and dependency versions. Please
include its output — it answers most of the first round of questions by itself.

# discord-audio-bridge

Stream audio from **one specific Windows application** into a Discord voice channel, with the
signal path kept as short and as lossless as Discord permits.

[![CI](https://github.com/OWNER/discord-audio-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/discord-audio-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.18-339933.svg)](https://nodejs.org)

No virtual audio cable. No "Stereo Mix". Pick an app, pick a channel, and the samples it renders go
into Discord's Opus stream having been resampled once and encoded once — nothing else.

There is a desktop control panel, and there are slash commands. Both do the same things.

```
┌──────────────────────────────────────────────────────────────────┐
│  🎧 Discord Audio Bridge                       ● online   38 ms  │
├──────────────────────────────────────────────────────────────────┤
│  Stream    Setup    Logs                                         │
├──────────────────────────────────────────────────────────────────┤
│  Now streaming                                        [ Stop ]   │
│  Spotify  →  #music-lounge   48000 Hz / 2 ch / f32le   12m 04s   │
│                                                                  │
│  L ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░   −8.2        │
│  R ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░   −7.6        │
│                                                                  │
│  Bitrate 384 kbps   UDP ping 24 ms   Buffer 118/120 ms           │
└──────────────────────────────────────────────────────────────────┘
```

---

## Contents

- [The signal path](#the-signal-path)
- [Measured results](#measured-results)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [The control panel](#the-control-panel)
- [Slash commands](#slash-commands)
- [Getting the most out of it](#getting-the-most-out-of-it)
- [Why a virtual cable sounds flat](#why-a-virtual-cable-sounds-flat--and-why-this-doesnt)
- [Configuration](#configuration)
- [How it is put together](#how-it-is-put-together)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [References](#references)

---

## The signal path

```
Spotify.exe  (or any app)
     │  renders audio
     ▼
Windows audio engine
     │  WASAPI per-process loopback
     │  ActivateAudioInterfaceAsync + AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
     ▼
AudioTap.exe          32-bit float, 48 kHz, stereo
     │                jitter buffer + silence fill + drift correction
     │  raw PCM on stdout, paced to exact real time
     ▼
ffmpeg / libopus      float in, no 16-bit round trip
     │                application=audio, complexity 10, 20 ms frames
     │  Ogg/Opus on stdout, one page per packet
     ▼
@discordjs/voice      demux only — packets are never decoded
     │                DAVE end-to-end encryption
     ▼
Discord voice channel
```

Every stage is deliberate:

| Decision | Why |
| --- | --- |
| Per-process loopback, not a virtual cable | Captures only the target app. Nothing else on the PC leaks in, the app keeps playing to your speakers, and there is no extra device round trip. |
| Request 48 kHz float from the tap | The process-loopback virtual device exposes no mix format, so it would otherwise default to 44.1 kHz. Asking for 48 kHz means the audio engine performs exactly **one** resample and we never touch the samples ourselves. |
| Float all the way into libopus | libopus encodes float natively. Going through 16-bit PCM would add a quantisation step and clip any intersample peak above 0 dBFS. |
| `-page_duration 20000` | ffmpeg's Ogg muxer defaults to **one-second pages**. Measured here: default pages deliver the first packet at 3186 ms with 3-second gaps; 20 ms pages deliver it at 163 ms and flow continuously. Discord's player gives up after a handful of missed frames, so this is the difference between working and not. |
| `inlineVolume: false` | Inline volume makes @discordjs/voice decode and re-encode every packet — a second lossy generation. Gain is applied to float samples in the tap instead, before any conversion. |
| Local jitter buffer with silence fill | Per-process loopback delivers *nothing at all* while the app is idle — not even silence. Without local pacing the stream dies every time you pause the music. |

## Measured results

Windows 11 26200, Node 26.4, ffmpeg 8.1.2, tapping an `ffplay` process rendering a 440 Hz tone:

| | |
| --- | --- |
| Negotiated capture format | 48 000 Hz / 2 ch / f32le — as requested, no fallback |
| Clock accuracy over 12 s | +0.005 % |
| Isolation | tapping an unrelated process while the tone played gave **digital silence** (RMS 0.000000) |
| Opus packets while playing | 246 in 5 s (20 ms framing), 960 bytes each → 384 kbps |
| First packet | 67 ms after start |
| Largest inter-packet gap | 87 ms |
| **After the source app was killed** | packets kept flowing — 226 more, 42 bytes each. The stream survives a pause instead of dying. |
| Overruns / dropped samples | 0 |

---

## Requirements

| | | |
| --- | --- | --- |
| **Windows 10 build 19041+** | required | Per-process loopback was added in Windows 10 version 2004. |
| **Node.js 22.18+** | required | Runs the TypeScript sources directly via native type stripping. |
| **ffmpeg with libopus** | required | Any recent full build. `winget install Gyan.FFmpeg` |
| **.NET SDK 9+** | for capture + desktop app | Only needed to *build* them, once. `winget install Microsoft.DotNet.SDK.9` |
| **WebView2 runtime** | for the desktop app | Already present on Windows 11 and current Windows 10. |

Without the .NET SDK the bot still runs. You lose per-app capture and the desktop window, and fall
back to a DirectShow source plus the browser control panel.

## Quick start

```powershell
git clone https://github.com/OWNER/discord-audio-bridge
cd discord-audio-bridge
npm run setup     # checks prerequisites, installs, builds both native pieces, creates .env
npm run app       # launch the desktop control panel
```

`npm run setup` is safe to re-run and never overwrites an existing `.env`.

Prefer no desktop app? `npm start` prints a URL — open it in any browser for the same panel.

### Creating the Discord application

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** → *Reset Token* → copy it.
3. **General Information** → copy the *Application ID*.
4. Paste both into the panel's **Setup** tab (or into `.env`), and press Save.
5. **Installation** → *Guild Install*, scopes `bot` + `applications.commands`, permissions
   **Connect** and **Speak** — plus **Manage Channels** if you want the bot to be able to raise a
   channel's bitrate for you.
6. Open the generated install link and add the bot to your server.
7. Press **Register slash commands** in the Setup tab.

No privileged intents are needed. Set `DISCORD_GUILD_ID` while developing so commands appear
instantly instead of taking up to an hour to propagate globally.

---

## The control panel

Three tabs, served by the bot on `127.0.0.1` and wrapped in a small native window.

**Stream** — pick a server and voice channel, then pick a source. The app list shows only processes
that currently hold an audio session, with a pulse next to the ones actually making sound, so you
are choosing from a short and meaningful list rather than every process on the machine. Clicking one
starts the stream immediately; clicking another retargets without leaving the channel.

Once running you get stereo peak/RMS meters, the negotiated capture format, UDP ping, jitter-buffer
fill, how much silence has been filled, how much clock drift has been trimmed, and live gain and
bitrate sliders.

**Setup** — credentials, audio defaults, and paths, written straight to `.env`. Buttons to build
AudioTap, register slash commands, and run diagnostics. Settings that only apply at startup say so
rather than silently doing nothing.

**Logs** — the bot's log, live, filterable by level, with history from before you opened the window.

The window closes to the notification area so it can sit out of the way while music plays; quit
from the tray icon to stop the bot. Launching the desktop app while `npm start` is already running
attaches to that bot instead of starting a second one.

### Security

The panel binds to `127.0.0.1` only and is never reachable from the network. Because loopback alone
is not authentication, every API call and WebSocket upgrade also requires a token minted at startup
and written to `.control-token`. The bot token is write-only over the API — reads report only
whether one is set. Set `CONTROL_PORT=0` to disable the panel entirely. See [SECURITY.md](SECURITY.md).

## Slash commands

| Command | What it does |
| --- | --- |
| `/stream app <target>` | Capture one application. Autocompletes from apps currently playing audio. `invert: true` captures everything *except* that app. |
| `/stream device [target]` | Capture everything playing through one output device. |
| `/stream dshow <target>` | Capture a DirectShow input. Needs no capture helper; see [why a cable is second best](#why-a-virtual-cable-sounds-flat--and-why-this-doesnt). |
| `/stop` | Stop and leave. |
| `/status` | Live pipeline numbers. |
| `/gain <db>` | Adjust capture gain. Applied live, no restart. |
| `/bitrate [kbps]` | Re-encode at a different bitrate. Empty = match the channel. |
| `/quality [maximize]` | Show the channel's bitrate and the server's ceiling; optionally raise it. |
| `/sources` | List capturable apps, devices, and DirectShow inputs. |
| `/diagnose` | Full dependency report. |

---

## Getting the most out of it

**Raise the channel bitrate.** This is by far the biggest lever, and it is not something the bot can
conjure. Discord caps voice channels by server boost tier:

| Boost tier | Channel ceiling |
| --- | --- |
| None | 96 kbps |
| Tier 1 | 128 kbps |
| Tier 2 | 256 kbps |
| Tier 3 | 384 kbps |

The bot encodes at exactly the channel's configured bitrate by default. The panel tells you when a
channel is below its server's ceiling and offers to raise it.

For reference, Opus is generally considered transparent for stereo music somewhere around
128–160 kbps, so a Tier 1 server is already past the point where the codec is the limiting factor.
At 96 kbps you are hearing Discord's cap rather than anything this project controls.

**Set the shared-mode format to 48 kHz.** Windows → Sound → your output device → Properties →
Advanced. That way the audio engine resamples once, from the source material's rate, rather than
44.1 → 48 → 44.1 → 48.

**Leave gain at 0 dB** unless the source is genuinely quiet. Positive gain on float samples cannot
clip in the tap, but it will clip in the encoder.

**Watch the meters.** "Silence filled" climbing while music plays means the tap is starving — raise
`CAPTURE_BUFFER_MS`. Overruns above zero mean the pacing thread is being starved of CPU.

## Why a virtual cable sounds flat — and why this doesn't

If you have ever piped music into Discord through Voicemeeter or VB-CABLE and found it thin,
pumping, or lifeless, the cable was probably not the culprit.

**The cause is Discord's microphone DSP.** When a virtual cable is selected as your *input device*,
the Discord client treats it as a microphone and runs its voice chain over it before encoding: noise
suppression (Krisp), echo cancellation, automatic gain control, and a high-pass filter. Every one of
those is tuned for speech and is actively hostile to music — AGC pumps the level with the track,
noise suppression strips reverb tails and cymbal decay as if they were hiss, and the high-pass takes
out the bottom end. The client also encodes mic input for voice rather than music.

**A bot bypasses all of it.** This project never presents anything to Discord as a microphone. It
sends finished Opus packets over the voice gateway, and Discord forwards them to listeners
untouched. There is no sender-side DSP stage in that path to disable, because there isn't one.

So that flatness is not something this project inherits — even the DirectShow fallback avoids it,
because the cable feeds *the bot*, not the Discord client.

That said, **per-app capture is still the better route**, and needs no cable at all:

| | `/stream app` | DirectShow via a cable |
| --- | --- | --- |
| Capture format | 48 kHz **32-bit float** | 48 kHz 16-bit (best Voicemeeter offers) |
| Conversions before Opus | none | none, if the cable is at 48 kHz |
| Extra software in the path | none | the cable's engine, plus any bus EQ/compression on it |
| Isolation | that one app only | whatever you routed into the cable |
| App keeps playing to your speakers | yes | only if you also monitor it back |

Measured here, Voicemeeter's DirectShow outputs advertise 8 kHz–96 kHz but **only 8- or 16-bit — no
24-bit and no float**. The bot probes that ladder and pins 48 kHz/16-bit/stereo, avoiding resampling
entirely; naively taking the highest number would have picked 96 kHz and bought a pointless
downsample. 16-bit itself is not the problem — its noise floor sits far below what Opus contributes
at these bitrates. The real cost is everything upstream: an extra app in the chain, its own
resampling if rates disagree, and any strip EQ, gate, or compressor left enabled.

---

## Configuration

Everything is optional except the two Discord credentials, and all of it is editable from the Setup
tab. See [`.env.example`](.env.example).

| Variable | Default | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Required. |
| `DISCORD_APP_ID` | — | Required. |
| `DISCORD_GUILD_ID` | — | Register commands to one guild instantly instead of globally. |
| `OPUS_BITRATE` | match channel | Bits per second. Opus permits up to 510000; exceeding the channel bitrate mostly wastes upstream bandwidth. |
| `OPUS_VBR` | `on` | `on` = unconstrained VBR, best quality. `constrained` bounds peaks. `off` = CBR. |
| `OPUS_COMPLEXITY` | `10` | Encoder effort, 0–10. |
| `CAPTURE_BUFFER_MS` | `120` | Jitter buffer target. Higher is more robust, and adds latency 1:1. |
| `CONTROL_PORT` | `8787` | Control panel port, loopback only. `0` disables it. |
| `CONTROL_OPEN` | `false` | Open the panel in your browser at startup. |
| `FFMPEG_PATH` | `ffmpeg` | |
| `AUDIOTAP_PATH` | `native/AudioTap/bin/AudioTap.exe` | |
| `LOG_LEVEL` | `info` | `debug` prints the exact ffmpeg command line and every tap event. |

## How it is put together

```
src/                 The bot. TypeScript, run directly by Node — no build step.
  audio/             AudioTap wrapper and the ffmpeg/libopus encoder.
  voice/             One BridgeSession per guild: tap + encoder + voice connection.
  control/           Loopback HTTP + WebSocket API.
  commands.ts        Slash commands, sharing their plumbing with the control API.

web/                 The control panel. Plain HTML/CSS/ES modules, no bundler.

native/AudioTap/     C#. Per-process WASAPI capture. The only piece that must be native.
desktop/BridgeApp/   C#. WinForms + WebView2 shell, ~4 MB, plus a tray icon.

scripts/             PowerShell, all reachable via npm run.
```

### AudioTap

`native/AudioTap` is usable on its own:

```
AudioTap --list-processes            # JSON: apps holding a render session
AudioTap --list-devices              # JSON: active render endpoints
AudioTap --capture --pid 1234        # per-process loopback
AudioTap --capture --pid 1234 --exclude
AudioTap --capture --device default  # endpoint loopback
```

In capture mode **stdout carries nothing but raw PCM**, so it pipes straight into ffmpeg.
Diagnostics go to stderr as line-delimited JSON: `format` (always first), `ready`, `stats` five
times a second, `error`. stdin accepts `gain <db>`, `stats`, and `quit`.

The interesting file is `PacedWriter.cs`, which is what makes the stream survive a paused app and a
drifting device clock.

### Why WebView2 and not Electron

WebView2 ships with Windows, so the desktop shell is **4.3 MB** rather than the ~150 MB an Electron
build starts at, and it reuses the .NET SDK the project already needs for AudioTap — no extra
toolchain for contributors. The window is a thin wrapper around the same page the bot serves, so the
UI can be developed with nothing but `npm start` and a browser.

## Troubleshooting

Run `npm run doctor` first. It reports every dependency, the host's audio devices, and which apps
are currently capturable.

**Per-app capture is unavailable.** Run `npm run build:native`. If it reports no .NET SDK, install
it or use a DirectShow source.

**Activation fails with `E_NOTIMPL` or `AUDCLNT_E_…`.** Per-process loopback needs Windows 10 build
19041 or newer — check with `winver`. Some virtualised and remote-desktop audio stacks do not
implement it.

**Silence, but packets are flowing.** The app is rendering to a different endpoint than you think,
or is genuinely idle. `npm run doctor` shows a live peak level per process.

**Stuttering.** Raise `CAPTURE_BUFFER_MS`. Overruns in the panel point at CPU starvation rather than
the network.

**The bot connects then immediately leaves.** Almost always a missing **Connect** or **Speak**
permission on that specific channel.

**`No compatible encryption modes`, or close code 4017.** Discord retired the `xsalsa20_poly1305`
modes in November 2024, and since March 2026 requires DAVE end-to-end encryption — clients without
it are disconnected with 4017. `@discordjs/voice` 0.19.2+ pulls in `@snazzah/davey`, which handles
both. Confirm via `npm run doctor` that the DAVE section shows a version.

**The desktop app says the project folder is missing.** It walks up from its own location to find
the repo. If you moved the executable, pass `--project-root C:\path\to\discord-audio-bridge` or set
`BRIDGE_PROJECT_ROOT`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the repo layout, why each piece is written the way it is,
and what to check before opening a pull request. Bug reports are most useful with `npm run doctor`
output attached.

## A note on what you stream

Piping copyrighted music into a server is between you, the rights holders, and Discord's terms. This
captures whatever you point it at; deciding what that should be is your call.

## References

- [Application loopback audio capture sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/) — the Win32 API this is built on
- [`AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params) and [`PROCESS_LOOPBACK_MODE`](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode)
- [WASAPI loopback recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
- [NAudio `WasapiRecorder` docs](https://github.com/naudio/NAudio/blob/main/Docs/WasapiRecorder.md) — `WithProcessLoopback`
- [Opus recommended settings](https://wiki.xiph.org/Opus_Recommended_Settings) and the [encoder API](https://opus-codec.org/docs/html_api/group__opusencoder.html)
- [Discord voice connections](https://docs.discord.food/topics/voice-connections) — gateway v8, encryption modes, `max_dave_protocol_version`
- [Discord: every voice and video call is now end-to-end encrypted](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted)
- [DAVE protocol whitepaper](https://daveprotocol.com/)
- [WebView2 in WinForms](https://learn.microsoft.com/en-us/microsoft-edge/webview2/get-started/winforms)
- [discord.js voice guide](https://discordjs.guide/voice)

## License

[MIT](LICENSE)

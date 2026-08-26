# discord-audio-bridge

Stream audio from **one application, device, or live mix** on Windows into Discord voice channels,
with the signal path kept as short and as lossless as Discord permits.

[![CI](https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.18-339933.svg)](https://nodejs.org)

No virtual audio cable. No "Stereo Mix". Pick an app, pick a channel, and its audio is captured as
48 kHz float and encoded to Opus once, without an intermediate decode/re-encode stage.

The full control panel runs in any modern browser; development checkouts can also wrap it in a
small WebView2 desktop shell. Slash commands cover streaming and diagnostics, while a separate
restricted, installable dashboard provides source, destination, mute, gain, bitrate, and stop controls from a
phone or another device on the LAN or a personal Tailscale network.

```text
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
- [Install](#install)
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

```text
Spotify  (or any app)
     │  renders audio
     ▼
Windows audio engine
     │  WASAPI per-process loopback
     ▼
AudioTap.exe
     │  32-bit float, 48 kHz, stereo
     │  jitter buffer + silence fill + drift correction
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
| Per-app capture, not a virtual cable | Captures only the target app. Nothing else on the machine leaks in, the app keeps playing to your speakers, and there is no extra device round trip. |
| Request 48 kHz float from the capture | The process-loopback virtual device exposes no mix format, so AudioTap requests Discord's native rate directly. The bridge adds no separate resampling stage before libopus; the host audio graph supplies 48 kHz. |
| Float all the way into libopus | libopus encodes float natively. Going through 16-bit PCM would add a quantisation step and clip any intersample peak above 0 dBFS. |
| `-page_duration 20000` | ffmpeg's Ogg muxer defaults to **one-second pages**. Measured here: default pages deliver the first packet at 3186 ms with 3-second gaps; 20 ms pages deliver it at 163 ms and flow continuously. Discord's player gives up after a handful of missed frames, so this is the difference between working and not. |
| `inlineVolume: false` | Inline volume makes @discordjs/voice decode and re-encode every packet — a second lossy generation. Gain is applied to float samples before any conversion instead. |
| Local pacing with silence fill | Capture delivers *nothing at all* while the app is idle — not even silence. Without local pacing the stream dies every time you pause the music. That lives in AudioTap's PacedWriter. |

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

| | |
| --- | --- |
| OS | Windows 10 version 2004 / build 19041+ |
| Node.js 22.18+ | only for running from source |
| ffmpeg with libopus | required |
| .NET 10 SDK | only for building AudioTap and the optional desktop shell from source; packaged AudioTap is self-contained |
| WebView2 runtime | only for `npm run app`; `npm start` uses a browser |

Packaged artifacts embed Node and do not need a system Node installation. The Windows ZIP also
contains a self-contained AudioTap helper; ffmpeg remains an external runtime dependency.

## Install

Tagged builds are published on the
[releases page](https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/releases) when the
release workflow completes. Artifact names use the package version in place of `<version>`:

| File | Platform |
| --- | --- |
| `discord-audio-bridge-<version>-windows-amd64.zip` | Portable — unzip and run `discord-audio-bridge.exe` |
| `Discord Audio Bridge App_<version>_x64_en-US.msi` | Installer (MSI) — desktop shell with bundled bridge |
| `Discord Audio Bridge App_<version>_x64-setup.exe` | Installer (NSIS) — same app shell |

Pushing a `v*` tag runs CI, builds those assets, and publishes them on the releases page automatically.

`discord-audio-bridge --doctor` prints a full dependency report and the capturable sources;
`--version` prints the build.

## Quick start

```powershell
git clone https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge
cd discord-audio-bridge
npm run setup     # checks prerequisites, installs packages, builds AudioTap and the desktop shell
npm run app       # launch the desktop control panel
```

`npm run setup` is safe to re-run and never overwrites an existing `.env`.
`npm start` prints a tokenized URL for the full local panel; `npm run app` wraps the same page in a
WebView2 window.

### Creating the Discord application

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** → *Reset Token* → copy it.
3. **General Information** → copy the *Application ID*.
4. Paste both into the panel's **Setup** tab and press Save. The panel starts before sign-in
   precisely so this works on a fresh clone; saving a token signs in immediately, with no restart.
   (Editing `.env` by hand does the same job.)
5. Use the **Invite bot** link generated in Setup. It requests `bot` + `applications.commands` and
   the permissions used by streaming, Stage speaking, bitrate changes, messages, and voice-channel
   status. You do not need to calculate a permission integer manually.
6. Open that install link and add the bot to your server.
7. Press **Register slash commands** in the Setup tab.

No privileged intents are needed. Set `DISCORD_GUILD_ID` while developing so commands appear
instantly instead of taking up to an hour to propagate globally.

---

## The control panel

Three tabs, served by the bot on `127.0.0.1`. Source checkouts print the URL in the terminal;
`npm run app` wraps the same page in a native WebView2 window.

**Stream** — first pick a server and voice channel, then choose an application, output device, or
DirectShow input. The app list shows processes that currently hold an audio session,
with native application icons and a pulse next to active ones. Enable mixing to select up to four
compatible application/device sources and trim each input separately. Nothing changes in Discord until **Start stream** (or **Apply
route**) is pressed, so exploring the list cannot accidentally retarget a live stream.

Once running you get stereo peak/RMS meters, the negotiated capture format, UDP ping, jitter-buffer
fill, silence-fill and drift-trim counters, clipping/silence warnings, Windows media metadata, plus
live mute, per-input/master gain, loudness, bitrate, and stop controls. Up to four guild sessions
can run concurrently, and routes can be named as reusable presets. The
destination card can also raise a voice channel to the server's bitrate ceiling when the bot has
**Manage Channels**.

**Setup** — credentials, audio/loudness defaults, presence, automation, paths, logging, and
remote-control settings, written to the
writable runtime `.env` (the checkout root during development, the per-user state directory for a
read-only package). It can build AudioTap, register slash commands directly with Discord,
and run diagnostics. Settings that only apply at startup are marked as requiring a restart; use
**Quit app**, then reopen the desktop shell or restart the bot to apply them.

**Logs** — the bot's log, live, filterable by level, with history from before you opened the panel.
**Copy support report** makes one paste-ready text file from platform diagnostics and all recent log
levels; **Download report** is available if the browser blocks clipboard access. The report excludes
saved credentials and the logger redacts known token forms, but review it before sharing.
The same entries persist as JSON Lines at the configured `LOG_FILE` (by default
`logs/bridge.log` under the runtime root):

- Packaged install: `logs\bridge.log` beside the unpacked app when that folder is writable, otherwise
  `%APPDATA%\discord-audio-bridge\logs\bridge.log`.
- Source checkouts: `logs/bridge.log` in the checkout.

The Logs tab shows the exact active path. The desktop shell also writes early launcher
failures to `logs/desktop.log` beside the unpacked app. Credentials are redacted before logging.

### Remote control

The separate remote dashboard is disabled on fresh installs. To opt in, set `REMOTE_PORT=8788` and
bind `REMOTE_HOST` to a trusted interface (or `0.0.0.0` for all IPv4 interfaces). It is intended for
a phone or another computer on the same LAN or Tailscale network. At startup, the terminal prints one URL for
each local network address; open the appropriate URL on the other device. With trust enabled, the
server asks the local Tailscale daemon to identify each `100.x`/tailnet peer with `tailscale whois`
before allowing tokenless control—an address merely being in the CGNAT range is not enough. LAN URLs
carry a persistent access token from `.remote-token` in the URL fragment; the page moves it into a
Bearer header, removes it from the address bar, and retains it for the installed PWA until **Forget
this device** is pressed.

The remote dashboard can select a capture source and Discord server/voice-channel destination,
start or retarget a stream, mute/unmute the bot in Discord, stop it, and adjust gain and Opus
bitrate. It also shows live meters, mix trims, media artwork, and lock-screen mute/stop actions where
Media Session is supported. It cannot read or edit the Discord token, change setup, build helpers, or register commands.
Treat a LAN tokenized URL like a password. Plain LAN HTTP is not encrypted against a network
observer, so prefer Tailscale when possible. Set `REMOTE_PORT=0` to disable the network listener,
bind `REMOTE_HOST` to one interface, or set `REMOTE_TRUST_TAILSCALE=false` to require the app token
on Tailscale too.

Windows may show a firewall prompt for Node on first use. Allow private networks. For Tailscale,
open the URL containing the host's `100.x.y.z` address. If an inbound firewall rule is needed, add
one for TCP port 8788 on private networks from an elevated Windows Terminal.

The optional desktop window closes to the notification area. Its tray icon reflects
offline/idle/live/muted state, its menu exposes mute and stop, `Ctrl+Alt+M` / `Ctrl+Alt+S` work
globally, and Start with Windows is opt-in. Quit from the tray to stop the bot it launched. If
`npm start` already serves the local port, `npm run app` attaches instead of starting another bot.

### Security

The panel binds to `127.0.0.1` only and is never reachable from the network. Because loopback alone
is not authentication, every API call and WebSocket upgrade also requires a token minted at startup
and written to `.control-token`. Access tokens arrive in URL fragments (not HTTP request URLs), are
removed from the address bar, and are sent as Bearer credentials. The local panel exchanges its
credential for a random, single-use, 30-second WebSocket ticket (never a localhost cookie) and
falls back to authenticated HTTP polling if live updates cannot connect. Both web services enforce
origin/Host checks, conservative HTTP limits, security headers, input size/type
validation, and rate limits. The bot token is write-only over the API—reads report only whether one
is set. Set `CONTROL_PORT=0` to disable the panel entirely. See [SECURITY.md](SECURITY.md).

## Slash commands

| Command | What it does |
| --- | --- |
| `/stream app <target>` | Capture one application. Autocompletes from apps holding an audio session. `invert: true` captures everything *except* that app. |
| `/stream device [target]` | Capture everything playing through one output device. |
| `/stream dshow <target>` | DirectShow input. Needs no AudioTap helper; see [why a cable is second best](#why-a-virtual-cable-sounds-flat--and-why-this-doesnt). |
| `/stop` | Stop and leave. |
| `/status` | Live pipeline numbers. |
| `/gain <db>` | Adjust capture gain. Applied live, no restart. |
| `/loudness <mode>` | Switch between off, true-peak limiting, and loudness matching. |
| `/bitrate [kbps]` | Re-encode at a different bitrate. Empty = match the channel. |
| `/quality [maximize]` | Show the channel's bitrate and the server's ceiling; optionally raise it. |
| `/sources` | List capturable apps, output devices, and DirectShow inputs. |
| `/diagnose` | Full dependency report. |

Commands ship as administrator-only and enforce the same check at runtime, including autocomplete
and message controls.

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

**Leave gain at 0 dB** unless the source is genuinely quiet. The default `limit` mode adds true-peak
protection; `match` additionally targets consistent EBU R128 loudness and uses more CPU.

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

The Discord token and application ID are required before the bot can sign in. The Setup tab manages
the common credentials, audio defaults, paths, logging, control ports, and Tailscale trust setting;
advanced keys such as `REMOTE_TOKEN` and `CONTROL_OPEN` can be set
directly in the environment file. See [`.env.example`](.env.example).

Precedence is: real process environment, writable runtime `.env`, then checkout `.env`. A development
checkout normally uses its own directory as the runtime root, so it has only one `.env`.

| Variable | Default | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Required. |
| `DISCORD_APP_ID` | — | Optional. Resolved from the bot token; set it only when the token and the application deliberately differ. |
| `DISCORD_GUILD_ID` | — | Register commands to one guild instantly instead of globally. |
| `OPUS_BITRATE` | match channel | Bits per second. Opus permits up to 510000; exceeding the channel bitrate mostly wastes upstream bandwidth. |
| `OPUS_VBR` | `on` | `on` = unconstrained VBR, best quality. `constrained` bounds peaks. `off` = CBR. |
| `OPUS_COMPLEXITY` | `10` | Encoder effort, 0–10. |
| `CAPTURE_BUFFER_MS` | `120` | Jitter buffer target. Higher is more robust, and adds latency 1:1. |
| `AUDIO_LOUDNESS` | `limit` | `off`, true-peak `limit`, or EBU R128 `match`. |
| `AUDIO_TARGET_LUFS` | `-14` | Integrated target used by `match`. |
| `AUDIO_TRUE_PEAK_DB` | `-1` | True-peak ceiling used by limit/match. |
| `PRESENCE_ACTIVITY` | `true` | Show the source/track in bot activity. |
| `PRESENCE_CHANNEL_STATUS` | `true` | Set the voice-channel status while streaming. |
| `PRESENCE_NOW_PLAYING` | `true` | Read Windows media metadata/artwork. |
| `AUTO_LEAVE_SECONDS` | `0` | Stop after this long without human listeners; `0` disables. |
| `AUTO_RESUME` | `false` | Restore the last successful route after sign-in. |
| `AUTO_FOLLOW_USER_ID` | blank | Move a *running* stream to whichever voice channel this user joins. Never starts one. |
| `CONTROL_PORT` | `8787` | Control panel port, loopback only. `0` disables it. |
| `CONTROL_OPEN` | `false` | Open the panel in your browser at startup. |
| `REMOTE_HOST` | `127.0.0.1` | Bind address; choose a trusted interface or `0.0.0.0` when enabling remote access. |
| `REMOTE_PORT` | `0` | Remote dashboard port. Set `8788` (or another port) to opt in. |
| `REMOTE_TRUST_TAILSCALE` | `false` | Opt in to tokenless peers after `tailscale whois --json` verifies tailnet membership. |
| `REMOTE_TOKEN` | generated | Optional fixed 24–256 character token-safe secret; normally use `.remote-token` generated by the app. |
| `FFMPEG_PATH` | `ffmpeg` | |
| `AUDIOTAP_PATH` | auto | Capture helper. |
| `FFPLAY_PATH` | `ffplay` | Player for the Monitor button. Ships with a full ffmpeg build. |
| `LOG_LEVEL` | `info` | `debug` prints the exact ffmpeg command line and every tap event. |
| `LOG_FILE` | `logs/bridge.log` | Asynchronous JSON-lines log inside the runtime root; `off` disables it. Rotates continuously at 10 MiB. |

## How it is put together

```text
src/                 The bot. TypeScript, run directly by Node in a checkout.
  audio/             AudioTap wrapper and the ffmpeg/libopus encoder.
  voice/             One BridgeSession per guild: capture + encoder + voice connection.
  control/           Loopback HTTP + WebSocket API.
  commands.ts        Slash commands, sharing their plumbing with the control API.

web/                 The control panel. Plain HTML/CSS/ES modules, no bundler.
remote/              Restricted LAN/Tailscale dashboard. Plain HTML/CSS/JS.

native/AudioTap/     C#. Per-process WASAPI capture.
desktop/BridgeApp/   C#. Framework-dependent WinForms + WebView2 shell and tray icon.
desktop/TauriApp/    Rust + Tauri 2 desktop shell: window, tray, global hotkeys, and
                     single-instance launch around the same control panel.
                     See desktop/TauriApp/README.md.

scripts/             Build, package, and setup tooling.
```

### AudioTap

`native/AudioTap` is usable on its own:

```text
AudioTap --list-processes            # JSON: apps holding a render session
AudioTap --list-devices              # JSON: active render endpoints
AudioTap --now-playing               # JSON: current Windows media session
AudioTap --monitor --with-icons      # resident JSON event feed on stdout
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

The WebView2 runtime is already present on current Windows 10/11 installations, so the optional
desktop shell stays framework-dependent instead of bundling a browser. It reuses the .NET toolchain
needed to build AudioTap and wraps the same page the bot serves, so UI work needs only `npm start`
and a browser.

## Troubleshooting

Run `npm run doctor` first (or `discord-audio-bridge --doctor` on a packaged install). It reports
every dependency, the host's audio devices, and which apps are currently capturable.

**Per-app capture is unavailable.** Run `npm run build:native`. If it reports no .NET
SDK, install it or use a DirectShow source.

**Activation fails with `E_NOTIMPL` or `AUDCLNT_E_…`.** Per-process loopback needs
Windows 10 version 2004 (build 19041) or newer — check with `winver`. Some virtualised and remote-desktop audio
stacks do not implement it.

**Silence, but packets are flowing.** The app is rendering to a different endpoint than you think,
or is genuinely idle. `npm run doctor` shows a live peak level per process.

**Stuttering.** Raise `CAPTURE_BUFFER_MS`. Overruns in the panel point at CPU starvation rather than
the network.

**The bot connects then immediately leaves.** Almost always a missing **Connect** or **Speak**
permission on that specific channel. Stage channels additionally need **Mute Members** so the bot
can unsuppress itself and become a speaker.

**Several AudioTap processes keep appearing.** One resident AudioTap monitor plus one
AudioTap capture per active mix input is expected. The bridge retries a failed capture
with bounded backoff and gives up after five attempts unless the pipeline remains healthy for 30
seconds. Current capture children are tracked and stopped during stream replacement and shutdown.
Source refreshes use the resident monitor. Counts that
keep growing while no routes change indicate a crash loop; inspect Logs/Diagnostics rather than
ending helpers manually.

**`No compatible encryption modes`, or close code 4017.** Discord requires DAVE end-to-end
encryption for voice calls; clients without it are disconnected with 4017.
`@discordjs/voice` 0.19.2+ pulls in `@snazzah/davey` for DAVE support. Confirm with
`npm run doctor` that the DAVE dependency is present.

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
- [Discord voice connections](https://docs.discord.com/developers/topics/voice-connections) — gateway, transport encryption, and DAVE
- [Discord: every voice and video call is now end-to-end encrypted](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted)
- [DAVE protocol whitepaper](https://daveprotocol.com/)
- [WebView2 in WinForms](https://learn.microsoft.com/en-us/microsoft-edge/webview2/get-started/winforms)
- [discord.js voice guide](https://discordjs.guide/voice)
- [Node.js built-in TypeScript support](https://nodejs.org/api/typescript.html)
- [Tailscale CLI `whois`](https://tailscale.com/docs/reference/tailscale-cli#whois)
- [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)

## License

[MIT](LICENSE)

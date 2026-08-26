# TauriApp — Windows desktop shell

A native desktop shell for the bridge: a real app window, a tray icon that knows what the bridge
is doing, global mute/stop hotkeys, and single-instance launch — while the entire control surface
remains the bridge's own web panel, served from its authenticated loopback server. This is the
Tauri sibling of the WinForms shell in `desktop/BridgeApp`, built with Tauri 2 so it reuses
WebView2 instead of bundling Chromium.

```text
┌─────────────────────────────────────────────┐
│ Discord Audio Bridge           — □ ✕        │  Tauri window (WebView2)
│                                             │
│   ┌─────────────────────────────────────┐   │
│   │  🎧 bridge control panel            │   │  the same page the bot serves on
│   │     sources · meters · setup · logs │   │  127.0.0.1:8787, token in fragment
│   └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
        │ attaches or spawns, polls /api/state
        ▼
   discord-audio-bridge (Node SEA exe or this checkout via npm start)
```

## What it does

- **Attach or launch.** On start it looks for a bridge that already answers — so `npm start` in a
  terminal and the app share one session — and only when nothing answers does it spawn one. From
  this checkout it finds the bridge automatically (the same `web/index.html` walk-up the bot
  itself uses). Release installers (MSI/NSIS) bundle the bridge inside the app under a `bridge/`
  resource folder. Elsewhere, point `BRIDGE_PROJECT_ROOT` at a checkout or set `BRIDGE_EXECUTABLE`.
- **Loader screen.** A small status page shows what the shell is doing; when the bridge's panel
  answers, the window navigates to it with the access token in a URL fragment, exactly like the
  browser flow.
- **Tray icon.** Tooltip shows streaming/muted state and the current track ("Streaming: Artist -
  Title"), with Show / Mute / Stop / Open logs / Quit. Closing the window hides to the tray; the
  bridge keeps streaming.
- **Global hotkeys.** `Ctrl+Alt+M` mute, `Ctrl+Alt+S` stop, `Ctrl+Alt+B` show the window — the
  same combinations the WinForms shell uses.
- **Single instance.** A second launch raises the existing window instead of fighting over the
  bridge's control port.
- **Never orphans the bridge.** The child sits in a kill-on-close job object, so a crashed shell
  cannot leave a stray bot holding the voice connection.

## Prerequisites

| | |
| --- | --- |
| Rust 1.77.2+ ([rustup](https://rustup.rs)) | MSVC toolchain |
| WebView2 | ships with Windows 10/11 (bundlers can bootstrap it if missing) |
| Node 22.18+ | to run the bridge from this checkout |

## Development

```powershell
cd desktop\TauriApp
npm install
npm run dev        # finds the bridge in the repo root automatically
```

The supervisor walks up from the running executable to find a directory containing
`web/index.html` — the repo root — so no environment variables are needed for a checkout. Set
`BRIDGE_PROJECT_ROOT` to wrap a bridge somewhere else, or `BRIDGE_EXECUTABLE` for a packaged
one. Runtime state (`.control-token`, logs) resolves exactly like the bridge's own
`runtimeRoot()`.

Release builds stage the portable bridge layout into `src-tauri/bridge-payload/` (via
`scripts/package.mjs`) and Tauri embeds it as the `bridge/` resource.

## Layout

```text
ui/                 The loader screen. Plain HTML/CSS/JS, no bundler; the panel replaces it
                   in the webview once the bridge answers.
src-tauri/
  src/bridge.rs     Attach-or-spawn supervision, /api/state polling, tray actions
  src/tray.rs       Tray icon, menu, live tooltip
  src/hotkeys.rs    Ctrl+Alt+M / S / B
  src/winjob.rs     Kill-on-close job object
icons/gen-icon.mjs  Regenerates the icon deterministically
```

## Security posture

The shell grants its webview nothing beyond core defaults: no filesystem, shell, or HTTP plugin
permissions. The panel it loads is the bridge's own authenticated loopback server, and the shell
itself holds and passes the control token exactly the way a browser session does. Remote access
remains the bridge's separate, restricted dashboard on port 8788.

## CI

`.github/workflows/app-shell.yml` builds Windows MSI/NSIS bundles on pushes to this branch and
pull requests touching this folder. App-shell CI is Windows-only. Every build stages the bridge
payload before `tauri build`, so the uploaded installers are self-contained.

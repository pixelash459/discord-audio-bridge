# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/AshutoshChaudhary-lgtm/discord-audio-bridge/security/advisories/new)
rather than opening a public issue.

Expect an initial response within a week.

## What this project touches

Worth knowing before you audit or deploy it:

**The bot token comes from the environment configuration.** In a development checkout it normally
lives in `.env`; a read-only package writes the editable file under the per-user runtime state
directory. It is never returned by the control API—reads report only whether a token is set.
Configuration inputs are type/range checked and safely quoted before writing. Executable settings
must name ffmpeg/AudioTap and existing path values are verified; logs cannot escape the runtime
directory. Environment files and runtime tokens are gitignored and tightened to user-only
filesystem permissions, including an explicit current-user ACL on Windows.

**The control panel listens on a socket.** It binds to `127.0.0.1` only, never `0.0.0.0`, so it is
not reachable from the network. Loopback is not authentication on its own, so every `/api` request
and WebSocket upgrade also requires a token minted at startup and written to `.control-token`
(also gitignored). It is delivered in a URL fragment, stripped from the address bar, and then sent
in an Authorization header rather than in request URLs. An authenticated exchange creates a random,
single-use WebSocket ticket that expires after 30 seconds. The durable token is never put in a
localhost cookie because browser cookies are shared across ports. Static assets are served without
a token because they contain nothing secret.

Set `CONTROL_PORT=0` to disable the local panel entirely and use slash commands and/or the
restricted remote dashboard.

**The remote dashboard is opt-in and intentionally network-reachable when enabled.** Fresh installs
use `REMOTE_PORT=0`, `REMOTE_HOST=127.0.0.1`, and `REMOTE_TRUST_TAILSCALE=false`. Enabling it uses a
separate persistent token in `.remote-token`. Its API can
enumerate host capture sources and the bot's Discord servers/voice channels; start or retarget a
stream; and control mute, stop, gain, and bitrate. It cannot access setup, environment files, bot
credentials, native builds, diagnostics, channel-bitrate changes, or command registration. Process
names and Discord destinations are host/account information, so do not expose the dashboard to an
untrusted network.

With `REMOTE_TRUST_TAILSCALE=true`, requests on Tailscale addresses are allowed without a second app
token only after the local daemon successfully resolves the peer with `tailscale whois --json` and
confirms the returned node address. This fails closed to token authentication when the CLI or daemon
is unavailable. Use it only for a personal or otherwise controlled tailnet. LAN requests still
require the token. Anyone holding a tokenized LAN URL can control streaming, including starting a
new stream, so treat that URL and `.remote-token` as credentials. The fragment is not sent in HTTP
requests, but ordinary LAN HTTP is still unencrypted against passive observers; prefer Tailscale.
Set `REMOTE_PORT=0` to disable the listener, bind `REMOTE_HOST` to one interface, or set
`REMOTE_TRUST_TAILSCALE=false` to require a token everywhere.

**Both HTTP surfaces are hardened against browser and resource attacks.** API requests require a
same-origin browser context and an expected Host value (including DNS-rebinding defense), request
bodies are JSON-only and capped at 64 KiB, rate-limit bookkeeping is bounded, WebSocket client count
and payload/backpressure are capped, and server request/header/idle timeouts are finite. Responses
set a restrictive CSP, deny framing and sensitive browser capabilities, disable caching, and do not
return internal errors for unexpected request failures.

**The local control API can rewrite configuration and perform setup actions.** This is intentional:
the Setup tab can update the runtime `.env`, build AudioTap on Windows, register slash commands with
Discord, and trigger sign-in. Anyone who can reach the loopback API with `.control-token` can perform
those actions, so treat the token as a credential.

**Capture is output-only by construction.** AudioTap captures the selected application or render
endpoint and takes no network action. It never opens a microphone capture path.

**Slash commands are administrator-only by default and at runtime.** This includes autocomplete and
message-component controls because they can enumerate or capture host applications. Server owners
can still restrict command visibility further in Server Settings → Integrations.

## Scope

Out of scope: anything requiring an attacker to already have code execution on the host machine, or
to already possess a correctly protected bot/local/remote token without a project-provided route to
obtain it. Tailscale trust is explicitly opt-in and assumes a personal/controlled tailnet.

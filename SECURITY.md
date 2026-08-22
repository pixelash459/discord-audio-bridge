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
directory. It is never returned by the control API — reads report only whether a token is set.
Environment files and runtime tokens are gitignored.

**The control panel listens on a socket.** It binds to `127.0.0.1` only, never `0.0.0.0`, so it is
not reachable from the network. Loopback is not authentication on its own, so every `/api` request
and WebSocket upgrade also requires a token minted at startup and written to `.control-token`
(also gitignored). Static assets are served without a token because they contain nothing secret.

Set `CONTROL_PORT=0` to disable the local panel entirely and use slash commands and/or the
restricted remote dashboard.

**The remote dashboard is intentionally network-reachable.** By default it binds to `0.0.0.0:8788`
for LAN and Tailscale access. It uses a separate persistent token in `.remote-token`. Its API can
enumerate host capture sources and the bot's Discord servers/voice channels; start or retarget a
stream; and control mute, stop, gain, and bitrate. It cannot access setup, environment files, bot
credentials, native builds, diagnostics, channel-bitrate changes, or command registration. Process
names and Discord destinations are host/account information, so do not expose the dashboard to an
untrusted network.

With `REMOTE_TRUST_TAILSCALE=true`, requests whose local and peer addresses are both inside
Tailscale's assigned ranges rely on Tailscale device authentication and need no second app token.
Use that only for a personal or otherwise controlled tailnet. LAN requests still require the token.
Anyone holding a tokenized LAN URL can control streaming, including starting a new stream, so treat
that URL and `.remote-token` as credentials. Set `REMOTE_PORT=0` to disable the listener, bind
`REMOTE_HOST` to one interface, or set `REMOTE_TRUST_TAILSCALE=false` to require a token everywhere.

**The local control API can rewrite configuration and perform setup actions.** This is intentional:
the Setup tab can update the runtime `.env`, build AudioTap on Windows, register slash commands with
Discord, and trigger sign-in. Anyone who can reach the loopback API with `.control-token` can perform
those actions, so treat the token as a credential.

**Capture is output-only by construction.** On Windows, AudioTap captures the selected application
or render endpoint and takes no network action. On Linux, application capture targets an explicit
PipeWire output-stream node and device capture resolves to a sink monitor; the bridge never launches
a bare `pw-record` command that could default to the microphone.

**Slash commands do not check who is asking**, beyond Discord's own permission model. Anyone who
can use the bot's commands in your server can start, stop, and retarget a stream, and can see the
names of applications running on the host machine via autocomplete. If that matters, restrict the
commands in Server Settings → Integrations.

## Scope

Out of scope: anything requiring an attacker to already have code execution on the host machine, or
to already possess the bot token, local control token, or remote control token. Reports about the
Tailscale trust mode must assume the documented personal/controlled-tailnet threat model.

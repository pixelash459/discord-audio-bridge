# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](../../security/advisories/new) rather than opening a public issue.

Expect an initial response within a week.

## What this project touches

Worth knowing before you audit or deploy it:

**The bot token lives in `.env`.** It is never returned by the control API — reads report only
whether a token is set. Keep `.env` out of version control; it is gitignored.

**The control panel listens on a socket.** It binds to `127.0.0.1` only, never `0.0.0.0`, so it is
not reachable from the network. Loopback is not authentication on its own, so every `/api` request
and WebSocket upgrade also requires a token minted at startup and written to `.control-token`
(also gitignored). Static assets are served without a token because they contain nothing secret.

Set `CONTROL_PORT=0` to disable the control panel entirely and use slash commands only.

**The remote dashboard is intentionally network-reachable.** By default it binds to `0.0.0.0:8788`
for LAN and Tailscale access. It uses a separate persistent token in `.remote-token` and exposes
only live stream state, mute, stop, gain, and bitrate controls. It cannot access setup, `.env`, bot
credentials, build actions, or command registration. With `REMOTE_TRUST_TAILSCALE=true`, requests
whose local and peer addresses are both inside Tailscale's assigned ranges rely on Tailscale device
authentication and need no second token. Use that only for a personal/controlled tailnet. LAN
requests still require the token. Anyone holding a tokenized LAN URL can control an active stream,
so treat that URL and `.remote-token` as credentials. Set `REMOTE_PORT=0` to disable it, bind
`REMOTE_HOST` to one interface, or set `REMOTE_TRUST_TAILSCALE=false` to always require a token.

**The control API can rewrite `.env` and run npm scripts.** This is intentional — it is what the
Setup tab does — but it means anyone who can reach the API with the token can change the bot's
configuration and trigger a build. Treat `.control-token` as a credential.

**AudioTap captures audio.** It captures only what it is pointed at, and only render (output)
streams; it has no microphone access. It takes no network action of any kind.

**Slash commands do not check who is asking**, beyond Discord's own permission model. Anyone who
can use the bot's commands in your server can start, stop, and retarget a stream, and can see the
names of applications running on the host machine via autocomplete. If that matters, restrict the
commands in Server Settings → Integrations.

## Scope

Out of scope: anything requiring an attacker to already have code execution on the host machine, or
to already possess the bot token, local control token, or remote control token.

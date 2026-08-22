import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Client } from 'discord.js';

import { projectRoot } from '../config.ts';
import { controlTokenPath, removeSavedControlPanel } from './launcher.ts';
import { logger, onLog, recentLogs } from '../logger.ts';
import { handleApi, buildSnapshot, ApiError } from './api.ts';

const log = logger('control');

const webRoot = resolve(projectRoot, 'web');
// Written into the writable runtime root: the repo in development, the user state dir when
// installed read-only under /usr/share or Program Files.

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * The control panel speaks to the bot over loopback HTTP + WebSocket.
 *
 * Loopback alone is not authentication: any process on the machine could otherwise drive the bot
 * and rewrite .env. So every /api and /ws request carries a token minted at startup and written to
 * .control-token, which the desktop shell reads and a browser user gets from the printed URL.
 * Static assets stay open because they contain nothing worth protecting.
 */
export class ControlServer {
  readonly token: string;
  readonly port: number;

  #http = createServer();
  #wss = new WebSocketServer({ noServer: true });
  #clients = new Set<WebSocket>();
  #client: Client;
  #onQuit: (() => void) | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopLogFeed: (() => void) | undefined;

  constructor(client: Client, port: number, onQuit?: () => void) {
    this.#client = client;
    this.#onQuit = onQuit;
    this.port = port;
    this.token = randomBytes(24).toString('base64url');
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/?token=${this.token}`;
  }

  async start(): Promise<void> {
    if (!existsSync(join(webRoot, 'index.html'))) {
      log.error('control panel assets are missing', { projectRoot, webRoot });
    }
    this.#http.on('request', (req, res) => void this.#route(req, res));

    this.#http.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (pathname !== '/ws') {
        log.debug('rejected websocket upgrade for unknown path', { pathname });
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      if (!this.#authorized(req)) {
        log.warn('rejected unauthorized websocket connection');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#attach(ws));
    });

    await new Promise<void>((done, fail) => {
      this.#http.once('error', fail);
      // 127.0.0.1 rather than 0.0.0.0: this must never be reachable from the network.
      this.#http.listen(this.port, '127.0.0.1', () => {
        this.#http.removeListener('error', fail);
        done();
      });
    });

    mkdirSync(dirname(controlTokenPath), { recursive: true });
    writeFileSync(
      controlTokenPath,
      JSON.stringify({ port: this.port, token: this.token }),
      { encoding: 'utf8', mode: 0o600 },
    );
    chmodSync(controlTokenPath, 0o600);

    // One broadcast loop for every client: cheap, and keeps all panels in step.
    this.#timer = setInterval(() => void this.#broadcastState(), 500);
    this.#stopLogFeed = onLog((entry) => this.#send({ type: 'log', entry }));

    // The access token belongs in the one explicit stdout URL, never in logs or log history.
    log.info(`control panel listening on http://127.0.0.1:${this.port}`);
  }

  async stop(): Promise<void> {
    log.info('stopping control panel', { clients: this.#clients.size });
    if (this.#timer) clearInterval(this.#timer);
    this.#stopLogFeed?.();
    for (const ws of this.#clients) ws.close();
    this.#wss.close();
    await new Promise<void>((done) => this.#http.close(() => done()));
    removeSavedControlPanel(this.token);
    log.info('control panel stopped');
  }

  #authorized(req: IncomingMessage): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const supplied =
      url.searchParams.get('token') ??
      req.headers.authorization?.replace(/^Bearer\s+/i, '') ??
      '';

    const a = Buffer.from(supplied);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  #attach(ws: WebSocket): void {
    this.#clients.add(ws);
    log.debug('control panel websocket connected', { clients: this.#clients.size });
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      this.#clients.delete(ws);
      log.debug('control panel websocket disconnected', { clients: this.#clients.size });
    };
    ws.once('close', detach);
    ws.once('error', detach);

    // Seed the newcomer with history so the log pane is not empty on open.
    ws.send(JSON.stringify({ type: 'history', entries: recentLogs() }));
    void this.#broadcastState();
  }

  #send(payload: unknown): void {
    if (this.#clients.size === 0) return;
    const text = JSON.stringify(payload);
    for (const ws of this.#clients) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  async #broadcastState(): Promise<void> {
    if (this.#clients.size === 0) return;
    try {
      this.#send({ type: 'state', state: await buildSnapshot(this.#client) });
    } catch (error) {
      log.debug('state broadcast failed', error);
    }
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const started = performance.now();
    res.once('finish', () => {
      const details = { status: res.statusCode, durationMs: Math.round(performance.now() - started) };
      if (url.pathname.startsWith('/api/')) log.debug(`${req.method ?? 'GET'} ${url.pathname}`, details);
    });

    if (url.pathname.startsWith('/api/')) {
      if (!this.#authorized(req)) {
        log.warn(`rejected unauthorized API request: ${req.method ?? 'GET'} ${url.pathname}`);
        return json(res, 401, { error: 'Bad or missing control token.' });
      }

      try {
        if (`${req.method} ${url.pathname}` === 'POST /api/app/quit') {
          json(res, 200, { quitting: true });
          setTimeout(() => this.#onQuit?.(), 50);
          return;
        }
        const result = await handleApi(this.#client, req, url);
        return json(res, 200, result ?? { ok: true });
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (status >= 500) log.error(`${req.method} ${url.pathname} failed`, error);
        return json(res, status, { error: message });
      }
    }

    this.#serveStatic(url.pathname, res);
  }

  #serveStatic(pathname: string, res: ServerResponse): void {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');

    // Resolve, then confirm the result is still inside web/ - the only defence that actually
    // holds against traversal, since normalize() alone will happily walk out of the root.
    const target = resolve(webRoot, normalize(relative));
    if (target !== webRoot && !target.startsWith(webRoot + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    if (!existsSync(target)) {
      log.warn('control panel asset not found', { pathname, target, webRoot });
      res
        .writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        .end(`Control panel asset not found: ${pathname}\nAsset root: ${webRoot}\n`);
      return;
    }

    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(res);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

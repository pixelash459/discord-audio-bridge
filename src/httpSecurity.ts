import type { IncomingMessage, Server, ServerResponse } from 'node:http';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

/** Apply conservative limits to the two small, directly exposed HTTP servers. */
export function hardenServer(server: Server): void {
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 500;
  server.setTimeout(30_000, (socket) => socket.destroy());
}

export function securityHeaders(contentType?: string): Record<string, string> {
  return {
    ...(contentType ? { 'content-type': contentType } : {}),
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

/** Browser requests must come from the page's own origin. Header-less API clients remain usable. */
export function hasTrustedOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
  } catch {
    return false;
  }
}

function normalizeAddress(value: string): string {
  return value.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '').toLowerCase();
}

/**
 * Reject DNS-rebinding requests. A browser-controlled Host header must name the socket it actually
 * reached (or one of the small set of hostnames the service was explicitly configured to use).
 */
export function hasExpectedHost(req: IncomingMessage, allowedHostnames: string[] = []): boolean {
  const host = req.headers.host;
  if (!host) return false;
  let requested: string;
  try {
    requested = normalizeAddress(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
  const local = normalizeAddress(req.socket.localAddress ?? '');
  if (requested === local) return true;
  if ((requested === 'localhost' || requested.endsWith('.localhost')) && (local === '127.0.0.1' || local === '::1')) {
    return true;
  }
  return allowedHostnames.some((value) => normalizeAddress(value) === requested);
}

export function bearerToken(req: IncomingMessage): string {
  const authorization = req.headers.authorization ?? '';
  // RFC 6750's token68 alphabet. Generated bridge tokens use the narrower base64url subset.
  const match = /^Bearer ([A-Za-z0-9._~+\/-]{24,256}={0,2})$/.exec(authorization);
  return match?.[1] ?? '';
}

export function methodAllowed(req: IncomingMessage, res: ServerResponse, methods: string[]): boolean {
  if (methods.includes(req.method ?? '')) return true;
  res.writeHead(405, { ...securityHeaders('text/plain; charset=utf-8'), allow: methods.join(', ') });
  res.end('Method not allowed');
  return false;
}

interface Bucket {
  start: number;
  count: number;
}

/** Fixed-window limiter with bounded bookkeeping; sufficient for a personal control service. */
export class RateLimiter {
  #buckets = new Map<string, Bucket>();

  allow(key: string, limit: number, windowMs = 60_000): boolean {
    const now = Date.now();
    const bucket = this.#buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      this.#buckets.set(key, { start: now, count: 1 });
      if (this.#buckets.size > 512) this.#prune(now, windowMs);
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  }

  #prune(now: number, windowMs: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.start >= windowMs) this.#buckets.delete(key);
    }
    while (this.#buckets.size > 512) {
      const oldest = this.#buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#buckets.delete(oldest);
    }
  }
}

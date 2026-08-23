import assert from 'node:assert/strict';
import { get } from 'node:http';

import WebSocket from 'ws';

const controlBase = process.env['TEST_CONTROL_URL'] ?? 'http://127.0.0.1:18787';
const remoteBase = process.env['TEST_REMOTE_URL'] ?? 'http://127.0.0.1:18788';
const controlToken = process.env['TEST_CONTROL_TOKEN'];
const remoteToken = process.env['TEST_REMOTE_TOKEN'];
if (!controlToken || !remoteToken) throw new Error('TEST_CONTROL_TOKEN and TEST_REMOTE_TOKEN are required.');

async function request(url, init = {}) {
  const response = await fetch(url, init);
  return { response, text: await response.text() };
}

let result = await request(`${controlBase}/`);
assert.equal(result.response.status, 200);
assert.match(result.response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);

result = await request(`${controlBase}/api/state?token=${controlToken}`);
assert.equal(result.response.status, 401, 'query-string control tokens must be rejected');
result = await request(`${controlBase}/api/state`, { headers: { authorization: `Bearer ${controlToken}` } });
assert.equal(result.response.status, 200);

result = await request(`${controlBase}/api/session`, {
  method: 'POST',
  headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
  body: '{}',
});
assert.equal(result.response.status, 200);
assert.equal(result.response.headers.get('set-cookie'), null, 'control credentials must never enter a localhost cookie');
const { ticket, expiresAt } = JSON.parse(result.text);
assert.match(ticket, /^[A-Za-z0-9_-]{32}$/);
assert.ok(expiresAt > Date.now());

result = await request(`${controlBase}/api/state`, {
  headers: { authorization: `Bearer ${controlToken}`, origin: 'http://evil.invalid' },
});
assert.equal(result.response.status, 403);

function rawStatus(url, headers) {
  return new Promise((resolve, reject) => {
    get(url, { headers }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    }).once('error', reject);
  });
}

assert.equal(
  await rawStatus(`${controlBase}/api/state`, { authorization: `Bearer ${controlToken}`, host: 'evil.invalid' }),
  403,
);

result = await request(`${remoteBase}/api/state`, { headers: { authorization: `Bearer ${remoteToken}` } });
assert.equal(result.response.status, 200);
result = await request(`${remoteBase}/api/state?token=${remoteToken}`);
assert.equal(result.response.status, 401, 'query-string remote tokens must be rejected');
assert.equal(
  await rawStatus(`${remoteBase}/api/state`, { authorization: `Bearer ${remoteToken}`, host: 'evil.invalid' }),
  403,
);

const websocketBase = controlBase.replace(/^http/, 'ws');
// The durable control token is never accepted in a WebSocket handshake; only the short-lived,
// single-use ticket returned above is.
await new Promise((resolve, reject) => {
  const socket = new WebSocket(`${websocketBase}/ws`, ['bridge-v1', `auth.${ticket}`], {
    headers: { origin: controlBase },
  });
  const timer = setTimeout(() => reject(new Error('Ticket WebSocket timed out.')), 3_000);
  socket.once('message', () => {
    clearTimeout(timer);
    socket.close();
    resolve();
  });
  socket.once('error', reject);
});

console.log('live HTTP/single-use-ticket/WebSocket security integration passed');

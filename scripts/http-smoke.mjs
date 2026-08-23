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
const sessionCookie = result.response.headers.get('set-cookie')?.split(';')[0];
assert.match(sessionCookie ?? '', /^bridge_control_session=[A-Za-z0-9_-]{32}$/);
assert.match(result.response.headers.get('set-cookie') ?? '', /HttpOnly/i);
assert.match(result.response.headers.get('set-cookie') ?? '', /SameSite=Strict/i);

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
await new Promise((resolve, reject) => {
  const socket = new WebSocket(`${websocketBase}/ws`, ['bridge-v1'], {
    headers: { cookie: sessionCookie, origin: controlBase },
  });
  const timer = setTimeout(() => reject(new Error('WebSocket timed out.')), 3_000);
  socket.once('message', () => {
    clearTimeout(timer);
    socket.close();
    resolve();
  });
  socket.once('error', reject);
});

// Keep the previous protocol-token handshake valid for already-open 1.2.0 pages during upgrades.
await new Promise((resolve, reject) => {
  const socket = new WebSocket(`${websocketBase}/ws`, ['bridge-v1', `auth.${controlToken}`]);
  const timer = setTimeout(() => reject(new Error('Legacy WebSocket timed out.')), 3_000);
  socket.once('message', () => {
    clearTimeout(timer);
    socket.close();
    resolve();
  });
  socket.once('error', reject);
});

console.log('live HTTP/session-cookie/WebSocket security integration passed');

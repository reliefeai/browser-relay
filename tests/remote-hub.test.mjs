import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { deriveRouteId } from '../server/remote-protocol.js';

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25, message = 'condition timed out' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await delay(intervalMs);
  }
  if (lastError) throw lastError;
  throw new Error(message);
}

async function startHub(t, hubPort, env = {}) {
  const child = spawn(process.execPath, ['server/hub-server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BROWSER_RELAY_HUB_HOST: '127.0.0.1', BROWSER_RELAY_HUB_PORT: String(hubPort), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c.toString(); });
  child.stderr.on('data', (c) => { output += c.toString(); });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${hubPort}/v1/health`, { signal: AbortSignal.timeout(500) })).ok,
    { timeoutMs: 6000, message: `hub did not start\n${output}` });
  return { output: () => output };
}

// Simulate the browser extension: connect out to the hub as the device and
// answer every rpc.request with a canned response.
function connectDevice(t, hubPort, routeId, secret, responseBody) {
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/v1/device/connect?routeId=${encodeURIComponent(routeId)}`);
  t.after(() => { try { ws.close(); } catch {} });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'rpc.request') {
      const response = typeof responseBody === 'function' ? responseBody(msg) : responseBody;
      const status = response?.status ?? 200;
      const body = response?.body ?? response;
      ws.send(JSON.stringify({ type: 'rpc.response', id: msg.id, status, headers: { 'content-type': 'application/json' }, body }));
    }
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'device.auth', secret })); });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type !== 'device.authenticated') return;
      ws.send(JSON.stringify({ type: 'device.hello', routeId, capabilities: ['debug'] }));
      resolve(ws);
    });
    ws.on('unexpected-response', (_q, r) => reject(new Error('device upgrade rejected: HTTP ' + r.statusCode)));
    ws.on('error', reject);
  });
}

function connectLegacyDevice(t, hubPort, routeId, secret) {
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/v1/device/connect?routeId=${encodeURIComponent(routeId)}&token=${encodeURIComponent(secret)}`);
  t.after(() => { try { ws.close(); } catch {} });
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'device.hello', routeId, capabilities: ['legacy'] }));
      resolve(ws);
    });
    ws.on('unexpected-response', (_q, r) => reject(new Error('legacy device upgrade rejected: HTTP ' + r.statusCode)));
    ws.on('error', reject);
  });
}

async function runCli(t, args, env = {}) {
  const child = spawn(process.execPath, ['server/cli.js', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c.toString(); });
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

const SECRET = 'G1PMrqZmTckQP63P';                 // 16 base64url chars = 96-bit
const DEVICE_ID = `br-${SECRET}`;
const ROUTE_ID = deriveRouteId(SECRET);

test('new device authenticates in the first frame and never places its secret in the WebSocket URL', async (t) => {
  const hubPort = await getFreePort();
  await startHub(t, hubPort);
  const ws = await connectDevice(t, hubPort, ROUTE_ID, SECRET, { ok: true });
  assert.equal(new URL(ws.url).searchParams.has('token'), false);

  const status = await fetch(`http://127.0.0.1:${hubPort}/v1/status/${ROUTE_ID}`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  }).then((res) => res.json());
  assert.equal(status.connected, true);
});

test('hub temporarily accepts legacy query-token devices', async (t) => {
  const hubPort = await getFreePort();
  await startHub(t, hubPort);
  await connectLegacyDevice(t, hubPort, ROUTE_ID, SECRET);
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${hubPort}/v1/status/${ROUTE_ID}`, { headers: { Authorization: `Bearer ${SECRET}` } });
    return (await res.json()).connected;
  });
});

test('hub rejects hello before authentication and does not mark the device connected', async (t) => {
  const hubPort = await getFreePort();
  await startHub(t, hubPort);
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/v1/device/connect?routeId=${ROUTE_ID}`);
  await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'device.hello', routeId: ROUTE_ID })));
    ws.on('close', (code) => { assert.equal(code, 4003); resolve(); });
    ws.on('error', reject);
  });
  const response = await fetch(`http://127.0.0.1:${hubPort}/v1/status/${ROUTE_ID}`, { headers: { Authorization: `Bearer ${SECRET}` } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'remote_device_offline');
});

test('hub rejects rpc.response before authentication', async (t) => {
  const hubPort = await getFreePort();
  await startHub(t, hubPort);
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/v1/device/connect?routeId=${ROUTE_ID}`);
  await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'rpc.response', id: 'forged', status: 200, body: {} })));
    ws.on('close', (code) => { assert.equal(code, 4003); resolve(); });
    ws.on('error', reject);
  });
});

test('hub closes devices that do not authenticate before the deadline', async (t) => {
  const hubPort = await getFreePort();
  await startHub(t, hubPort, { BROWSER_RELAY_DEVICE_AUTH_TIMEOUT_MS: '50' });
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/v1/device/connect?routeId=${ROUTE_ID}`);
  await new Promise((resolve, reject) => {
    ws.on('close', (code) => { assert.equal(code, 4008); resolve(); });
    ws.on('error', reject);
  });
});

test('wrong secret-derived route cannot first-writer claim an offline Node hub device', async (t) => {
  const hubPort = await getFreePort();
  const hubProcess = await startHub(t, hubPort);
  const attackerSecret = 'L2QNsrAnUdlRQ74Q';
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/v1/device/connect?routeId=${ROUTE_ID}`);
  const closed = new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'device.auth', secret: attackerSecret })));
    ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
    ws.on('error', reject);
  });
  const result = await closed;
  assert.equal(result.code, 4003);
  assert.equal(result.reason.includes(attackerSecret), false);
  assert.equal(hubProcess.output().includes(attackerSecret), false);

  await connectDevice(t, hubPort, ROUTE_ID, SECRET, { ok: true });
  const status = await fetch(`http://127.0.0.1:${hubPort}/v1/status/${ROUTE_ID}`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  }).then((res) => res.json());
  assert.equal(status.connected, true);
});

test('concurrent Node hub claims cannot let a wrong secret win or replace the authenticated device', async (t) => {
  const hubPort = await getFreePort();
  await startHub(t, hubPort);
  const owner = connectDevice(t, hubPort, ROUTE_ID, SECRET, { ok: true });
  const attackerSecret = 'L2QNsrAnUdlRQ74Q';
  const attacker = new WebSocket(`ws://127.0.0.1:${hubPort}/v1/device/connect?routeId=${ROUTE_ID}`);
  t.after(() => { try { attacker.close(); } catch {} });
  const attackerClosed = new Promise((resolve, reject) => {
    attacker.on('open', () => attacker.send(JSON.stringify({ type: 'device.auth', secret: attackerSecret })));
    attacker.on('close', (code) => resolve(code));
    attacker.on('error', reject);
  });
  const [ownerWs, code] = await Promise.all([owner, attackerClosed]);
  assert.equal(code, 4003);
  assert.equal(ownerWs.readyState, WebSocket.OPEN);
});

test('an unauthenticated candidate cannot replace the current device connection', async (t) => {
  const hubPort = await getFreePort();
  await startHub(t, hubPort, { BROWSER_RELAY_DEVICE_AUTH_TIMEOUT_MS: '1000' });
  const current = await connectDevice(t, hubPort, ROUTE_ID, SECRET, { ok: true });
  const candidate = new WebSocket(`ws://127.0.0.1:${hubPort}/v1/device/connect?routeId=${ROUTE_ID}`);
  t.after(() => { try { candidate.close(); } catch {} });
  await new Promise((resolve, reject) => { candidate.on('open', resolve); candidate.on('error', reject); });
  await delay(50);
  assert.equal(current.readyState, WebSocket.OPEN);

  const status = await fetch(`http://127.0.0.1:${hubPort}/v1/status/${ROUTE_ID}`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  }).then((res) => res.json());
  assert.equal(status.connected, true);
});

test('a candidate replaces the current Node hub device only after successful authentication', async (t) => {
  const hubPort = await getFreePort();
  await startHub(t, hubPort);
  const current = await connectDevice(t, hubPort, ROUTE_ID, SECRET, { ok: true });
  const superseded = new Promise((resolve) => current.on('close', (code) => resolve(code)));
  const candidate = new WebSocket(`ws://127.0.0.1:${hubPort}/v1/device/connect?routeId=${ROUTE_ID}`);
  t.after(() => { try { candidate.close(); } catch {} });
  const authenticated = new Promise((resolve, reject) => {
    candidate.on('open', () => candidate.send(JSON.stringify({ type: 'device.auth', secret: SECRET })));
    candidate.on('message', (raw) => {
      if (JSON.parse(String(raw)).type === 'device.authenticated') resolve();
    });
    candidate.on('error', reject);
  });

  await authenticated;
  assert.equal(await superseded, 4001);
  assert.equal(candidate.readyState, WebSocket.OPEN);
});

test('Node hub disconnect logs never include an untrusted WebSocket close reason', async (t) => {
  const hubPort = await getFreePort();
  const hubProcess = await startHub(t, hubPort);
  const secretReason = 'G1PMrqZmTckQP63P';
  const ws = await connectDevice(t, hubPort, ROUTE_ID, SECRET, { ok: true });
  ws.close(4000, secretReason);
  await waitFor(() => hubProcess.output().includes('device.disconnect'));
  assert.equal(hubProcess.output().includes(secretReason), false);
  const disconnectLine = hubProcess.output().split('\n').find((line) => line.includes('device.disconnect'));
  assert.equal(JSON.parse(disconnectLine).code, 4000);
  assert.equal(Object.hasOwn(JSON.parse(disconnectLine), 'reason'), false);
});

test('hub routes a CLI request to the connected extension and returns its response', async (t) => {
  const hubPort = await getFreePort();
  await startHub(t, hubPort);
  await connectDevice(t, hubPort, ROUTE_ID, SECRET, { ok: true, service: 'test-device' });

  const hub = `http://127.0.0.1:${hubPort}`;
  await waitFor(async () => {
    const res = await fetch(`${hub}/v1/status/${ROUTE_ID}`, { headers: { Authorization: `Bearer ${SECRET}` } });
    return (await res.json()).connected;
  }, { message: 'hub did not report connected device' });

  const result = await runCli(t, ['debug', '--json', '--remote-device-id', DEVICE_ID, '--remote-host', hub]);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, 'test-device');
});

test('remote CLI preserves structured hub errors when device is offline', async (t) => {
  const hubPort = await getFreePort();
  await startHub(t, hubPort);
  const hub = `http://127.0.0.1:${hubPort}`;

  const result = await runCli(t, ['tabs', '--json', '--remote-device-id', DEVICE_ID, '--remote-host', hub]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'remote_device_offline');
  assert.equal(payload.status, 409);
});

test('remote CLI routes wait options to the extension executor', async (t) => {
  const hubPort = await getFreePort();
  await startHub(t, hubPort);
  let request = null;
  await connectDevice(t, hubPort, ROUTE_ID, SECRET, (msg) => {
    request = msg;
    return { ok: true, matched: true, selector: '.ready', state: 'attached', elapsedMs: 75, attempts: 2 };
  });
  const hub = `http://127.0.0.1:${hubPort}`;
  await waitFor(async () => {
    const res = await fetch(`${hub}/v1/status/${ROUTE_ID}`, { headers: { Authorization: `Bearer ${SECRET}` } });
    return (await res.json()).connected;
  });

  const result = await runCli(t, [
    'wait', '.ready', '--state', 'attached', '--timeout', '2500', '--poll', '75', '--json',
    '--remote-device-id', DEVICE_ID, '--remote-host', hub,
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).matched, true);
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/wait');
  assert.deepEqual(request.body, {
    selector: '.ready',
    state: 'attached',
    timeoutMs: 2500,
    pollMs: 75,
  });
});

test('remote CLI preserves extension wait_timeout details', async (t) => {
  const hubPort = await getFreePort();
  await startHub(t, hubPort);
  await connectDevice(t, hubPort, ROUTE_ID, SECRET, {
    status: 408,
    body: {
      ok: false,
      code: 'wait_timeout',
      error: 'Timed out waiting for selector: #never',
      message: 'Timed out waiting for selector: #never',
      status: 408,
      retryable: true,
      details: { selector: '#never', state: 'visible', timeoutMs: 100, elapsedMs: 101, attempts: 3 },
    },
  });
  const hub = `http://127.0.0.1:${hubPort}`;
  await waitFor(async () => {
    const res = await fetch(`${hub}/v1/status/${ROUTE_ID}`, { headers: { Authorization: `Bearer ${SECRET}` } });
    return (await res.json()).connected;
  });

  const result = await runCli(t, [
    'wait', '#never', '--timeout', '100', '--json',
    '--remote-device-id', DEVICE_ID, '--remote-host', hub,
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.code, 'wait_timeout');
  assert.equal(payload.status, 408);
  assert.equal(payload.retryable, true);
  assert.equal(payload.details.attempts, 3);
});

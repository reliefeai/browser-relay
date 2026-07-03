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

async function startHub(t, hubPort) {
  const child = spawn(process.execPath, ['server/hub-server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BROWSER_RELAY_HUB_HOST: '127.0.0.1', BROWSER_RELAY_HUB_PORT: String(hubPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c.toString(); });
  child.stderr.on('data', (c) => { output += c.toString(); });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${hubPort}/v1/health`, { signal: AbortSignal.timeout(500) })).ok,
    { timeoutMs: 6000, message: `hub did not start\n${output}` });
}

// Simulate the browser extension: connect out to the hub as the device and
// answer every rpc.request with a canned response.
function connectDevice(t, hubPort, routeId, secret, responseBody) {
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/v1/device/connect?routeId=${encodeURIComponent(routeId)}&token=${encodeURIComponent(secret)}`);
  t.after(() => { try { ws.close(); } catch {} });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'rpc.request') {
      ws.send(JSON.stringify({ type: 'rpc.response', id: msg.id, status: 200, headers: { 'content-type': 'application/json' }, body: responseBody }));
    }
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'device.hello', routeId, capabilities: ['debug'] })); resolve(ws); });
    ws.on('unexpected-response', (_q, r) => reject(new Error('device upgrade rejected: HTTP ' + r.statusCode)));
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

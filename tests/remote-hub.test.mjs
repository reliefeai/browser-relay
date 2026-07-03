import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

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

async function startProcess(t, args, env, healthUrl, label) {
  const child = spawn(process.execPath, args, {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });

  await waitFor(async () => {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
    return res.ok;
  }, { timeoutMs: 6000, message: `${label} did not start\n${output}` });

  return { child, output: () => output };
}

async function runCli(t, args, env = {}) {
  const child = spawn(process.execPath, ['server/cli.js', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('remote hub routes CLI requests through the outbound local relay connection', async (t) => {
  const hubPort = await getFreePort();
  const relayPort = await getFreePort();
  await startProcess(t, ['server/hub-server.js'], {
    BROWSER_RELAY_HUB_HOST: '127.0.0.1',
    BROWSER_RELAY_HUB_PORT: String(hubPort),
  }, `http://127.0.0.1:${hubPort}/v1/health`, 'hub');
  await startProcess(t, ['server/relay-server.js'], {
    BROWSER_RELAY_HOST: '127.0.0.1',
    BROWSER_RELAY_PORT: String(relayPort),
  }, `http://127.0.0.1:${relayPort}/`, 'relay');

  const routeId = 'routeIdForRemoteTest';
  const secret = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789';
  const remoteDeviceId = `brd1_${routeId}_${secret}`;
  const hub = `http://127.0.0.1:${hubPort}`;

  const enabled = await postJson(`http://127.0.0.1:${relayPort}/api/remote/enable`, {
    hub,
    routeId,
    secret,
    deviceName: 'test-device',
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.ok, true);
  assert.equal(enabled.body.connected, true);
  assert.equal(enabled.body.remoteDeviceId, remoteDeviceId);

  await waitFor(async () => {
    const res = await fetch(`${hub}/v1/status/${routeId}`, { headers: { Authorization: `Bearer ${secret}` } });
    const data = await res.json();
    return data.connected;
  }, { message: 'hub did not report connected device' });

  const result = await runCli(t, ['debug', '--json', '--remote-device-id', remoteDeviceId, '--remote-host', hub]);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.port, relayPort);
  assert.equal(payload.version, '1.0.16');
});

test('remote CLI preserves structured hub errors when device is offline', async (t) => {
  const hubPort = await getFreePort();
  await startProcess(t, ['server/hub-server.js'], {
    BROWSER_RELAY_HUB_HOST: '127.0.0.1',
    BROWSER_RELAY_HUB_PORT: String(hubPort),
  }, `http://127.0.0.1:${hubPort}/v1/health`, 'hub');

  const routeId = 'offlineRouteForTest';
  const secret = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789';
  const remoteDeviceId = `brd1_${routeId}_${secret}`;
  const hub = `http://127.0.0.1:${hubPort}`;

  const result = await runCli(t, ['tabs', '--json', '--remote-device-id', remoteDeviceId, '--remote-host', hub]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'remote_device_offline');
  assert.equal(payload.status, 409);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(fn, { timeoutMs = 3000, intervalMs = 25, message = 'condition timed out' } = {}) {
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

async function startRelay(t) {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['server/relay-server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BROWSER_RELAY_HOST: '127.0.0.1', BROWSER_RELAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });
  child.on('exit', (code, signal) => {
    if (code && code !== 0 && signal !== 'SIGTERM') {
      console.error(output);
    }
  });

  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  }, { timeoutMs: 5000, message: `relay did not start on port ${port}\n${output}` });

  return { port, child, output: () => output };
}

async function connectFakeExtension(t, port, handler = () => ({})) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  await once(ws, 'open');
  t.after(() => ws.close());

  const commands = [];
  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === 'ping') {
      ws.send(JSON.stringify({ method: 'pong' }));
      return;
    }
    if (typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
      commands.push(msg.params);
      try {
        const result = await handler(msg.params);
        ws.send(JSON.stringify({ id: msg.id, result }));
      } catch (err) {
        ws.send(JSON.stringify({ id: msg.id, error: err instanceof Error ? err.message : String(err) }));
      }
    }
  });

  function sendEvent(sessionId, method, params = {}) {
    ws.send(JSON.stringify({ method: 'forwardCDPEvent', params: { sessionId, method, params } }));
  }

  function announceTab({ sessionId = 'br-tab-1', targetId = 'target-1', url = 'https://example.test/', title = 'Example' } = {}) {
    sendEvent(sessionId, 'Target.attachedToTarget', {
      sessionId,
      targetInfo: { targetId, type: 'page', title, url, attached: true },
      waitingForDebugger: false,
    });
  }

  return { ws, commands, sendEvent, announceTab };
}

async function fetchJson(port, path, options) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

test('full-page screenshot uses layout metrics clip and returns capture metadata', async (t) => {
  const relay = await startRelay(t);
  const pngData = Buffer.from('png-bytes').toString('base64');
  const extension = await connectFakeExtension(t, relay.port, (cmd) => {
    if (cmd.method === 'Page.getLayoutMetrics') {
      return { cssContentSize: { x: 0, y: 0, width: 123.4, height: 456.7 } };
    }
    if (cmd.method === 'Page.captureScreenshot') {
      return { data: pngData };
    }
    return {};
  });

  extension.announceTab({ sessionId: 'session-1', targetId: 'tab-1' });
  await waitFor(async () => (await fetchJson(relay.port, '/api/tabs')).body.tabs?.length === 1);

  const { status, body } = await fetchJson(relay.port, '/api/screenshot?tabId=tab-1&fullPage=true');

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.fullPage, true);
  assert.equal(body.strategy, 'fullPageClip');
  assert.equal(body.width, 124);
  assert.equal(body.height, 457);
  assert.equal(body.bytes, Buffer.byteLength(pngData, 'base64'));
  assert.equal(body.data, pngData);

  const methods = extension.commands.map((cmd) => cmd.method);
  assert.ok(methods.includes('Page.getLayoutMetrics'));
  const capture = extension.commands.find((cmd) => cmd.method === 'Page.captureScreenshot');
  assert.deepEqual(capture.params.clip, { x: 0, y: 0, width: 124, height: 457, scale: 1 });
  assert.equal(capture.params.captureBeyondViewport, true);
});

test('network events are captured, filterable, clearable, and redact sensitive headers', async (t) => {
  const relay = await startRelay(t);
  const extension = await connectFakeExtension(t, relay.port);

  extension.announceTab({ sessionId: 'session-1', targetId: 'tab-1', url: 'https://app.example.test/' });
  await waitFor(async () => (await fetchJson(relay.port, '/api/tabs')).body.tabs?.length === 1);
  await waitFor(() => extension.commands.some((cmd) => cmd.method === 'Network.enable'), {
    message: 'relay did not enable Network domain for attached tab',
  });

  extension.sendEvent('session-1', 'Network.requestWillBeSent', {
    requestId: 'req-1',
    documentURL: 'https://app.example.test/',
    timestamp: 1,
    wallTime: 2,
    type: 'Fetch',
    request: {
      url: 'https://api.example.test/data',
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'sid=secret',
        'X-Trace': 'abc',
      },
    },
  });
  extension.sendEvent('session-1', 'Network.responseReceived', {
    requestId: 'req-1',
    timestamp: 3,
    type: 'Fetch',
    response: {
      url: 'https://api.example.test/data',
      status: 201,
      statusText: 'Created',
      mimeType: 'application/json',
      headers: {
        'Set-Cookie': 'sid=secret',
        'Content-Type': 'application/json',
      },
    },
  });
  extension.sendEvent('session-1', 'Network.loadingFinished', {
    requestId: 'req-1',
    timestamp: 4,
    encodedDataLength: 42,
  });

  await waitFor(async () => {
    const { body } = await fetchJson(relay.port, '/api/network?limit=10');
    return body.entries?.length === 3;
  });

  const requestResult = await fetchJson(relay.port, '/api/network?type=request&url=api.example.test&limit=10');
  assert.equal(requestResult.status, 200);
  assert.equal(requestResult.body.ok, true);
  assert.equal(requestResult.body.count, 1);
  const requestEntry = requestResult.body.entries[0];
  assert.equal(requestEntry.method, 'POST');
  assert.equal(requestEntry.request.headers.Authorization, '[redacted]');
  assert.equal(requestEntry.request.headers.Cookie, '[redacted]');
  assert.equal(requestEntry.request.headers['X-Trace'], 'abc');

  const responseResult = await fetchJson(relay.port, '/api/network?type=response&status=201&limit=10');
  assert.equal(responseResult.body.count, 1);
  assert.equal(responseResult.body.entries[0].response.headers['Set-Cookie'], '[redacted]');

  const clearResult = await fetchJson(relay.port, '/api/network?limit=10&clear=true');
  assert.equal(clearResult.body.count, 3);
  const afterClear = await fetchJson(relay.port, '/api/network?limit=10');
  assert.equal(afterClear.body.count, 0);
  assert.equal(afterClear.body.storedTotal, 0);
});

test('unknown API endpoint returns a structured endpoint_not_found error', async (t) => {
  const relay = await startRelay(t);

  const { status, body } = await fetchJson(relay.port, '/api/not-a-real-endpoint');

  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'endpoint_not_found');
  assert.equal(body.status, 404);
  assert.equal(body.retryable, false);
  assert.equal(body.error, 'Unknown API endpoint: /api/not-a-real-endpoint');
  assert.equal(body.message, body.error);
});

test('invalid JSON request returns a structured invalid_json error', async (t) => {
  const relay = await startRelay(t);
  const extension = await connectFakeExtension(t, relay.port);
  extension.announceTab({ sessionId: 'session-1', targetId: 'tab-1' });
  await waitFor(async () => (await fetchJson(relay.port, '/api/tabs')).body.tabs?.length === 1);

  const res = await fetch(`http://127.0.0.1:${relay.port}/api/eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'invalid_json');
  assert.equal(body.status, 400);
  assert.equal(body.retryable, false);
  assert.equal(body.error, 'Invalid JSON in request body');
  assert.equal(body.message, body.error);
});

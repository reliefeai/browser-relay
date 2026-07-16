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

  function sendEvent(sessionId, method, params = {}, tabId) {
    ws.send(JSON.stringify({ method: 'forwardCDPEvent', params: { sessionId, ...(tabId ? { tabId } : {}), method, params } }));
  }

  function announceTab({ sessionId = 'br-tab-1', tabId = 't_AAAAAAAAAA', targetId = 'target-1', url = 'https://example.test/', title = 'Example' } = {}) {
    sendEvent(sessionId, 'Target.attachedToTarget', {
      sessionId,
      tabId,
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

test('formal tab id hides Chrome internals and routes to exactly one session', async (t) => {
  const relay = await startRelay(t);
  const extension = await connectFakeExtension(t, relay.port, (cmd) => {
    if (cmd.method === 'Runtime.evaluate') return { result: { value: 'ok' } };
    return {};
  });

  extension.announceTab({
    sessionId: 'session-private',
    tabId: 't_A7k2Pm9QxL',
    targetId: '0123456789ABCDEF0123456789ABCDEF',
  });
  const listed = await waitFor(async () => {
    const result = await fetchJson(relay.port, '/api/tabs');
    return result.body.tabs?.length === 1 ? result : null;
  });
  assert.deepEqual(listed.body.tabs, [{
    id: 't_A7k2Pm9QxL',
    title: 'Example',
    url: 'https://example.test/',
  }]);

  const internalId = await fetchJson(relay.port, '/api/eval', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabId: '0123456789ABCDEF0123456789ABCDEF', expression: '1' }),
  });
  assert.equal(internalId.status, 404);
  assert.equal(internalId.body.code, 'tab_not_found');

  const formalId = await fetchJson(relay.port, '/api/eval', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabId: 't_A7k2Pm9QxL', expression: '1' }),
  });
  assert.equal(formalId.status, 200);
  assert.equal(extension.commands.at(-1).sessionId, 'session-private');

  extension.sendEvent('child-session', 'Runtime.consoleAPICalled', {
    type: 'log',
    args: [{ type: 'string', value: 'from child frame' }],
  }, 't_A7k2Pm9QxL');
  const childConsole = await waitFor(async () => {
    const result = await fetchJson(relay.port, '/api/console?tabId=t_A7k2Pm9QxL&limit=100');
    const entry = result.body.entries?.find((item) => item.text === 'from child frame');
    return entry ? { result, entry } : null;
  });
  assert.equal(childConsole.entry.tabId, 't_A7k2Pm9QxL');
});

test('old extension gets an explicit short-id upgrade error', async (t) => {
  const relay = await startRelay(t);
  const extension = await connectFakeExtension(t, relay.port);

  extension.sendEvent('old-session', 'Target.attachedToTarget', {
    sessionId: 'old-session',
    targetInfo: { targetId: 'old-target', type: 'page', title: 'Old', url: 'https://old.example/' },
  });
  const result = await waitFor(async () => {
    const response = await fetchJson(relay.port, '/api/tabs');
    return response.status === 409 ? response : null;
  });

  assert.equal(result.body.code, 'extension_upgrade_required');
  assert.match(result.body.message, /Reload the extension/);
});

test('closed or duplicate formal ids never fall through to another tab', async (t) => {
  const relay = await startRelay(t);
  const extension = await connectFakeExtension(t, relay.port, (cmd) => {
    if (cmd.method === 'Runtime.evaluate') return { result: { value: cmd.sessionId } };
    return {};
  });

  extension.announceTab({ sessionId: 'session-a', tabId: 't_AAAAAAAAAA', targetId: 'target-a' });
  extension.announceTab({ sessionId: 'session-b', tabId: 't_BBBBBBBBBB', targetId: 'target-b' });
  extension.announceTab({ sessionId: 'session-duplicate', tabId: 't_AAAAAAAAAA', targetId: 'target-duplicate' });
  await waitFor(async () => (await fetchJson(relay.port, '/api/tabs')).body.tabs?.length === 2);

  extension.sendEvent('session-a', 'Target.detachedFromTarget', { sessionId: 'session-a', targetId: 'target-a' });
  await waitFor(async () => (await fetchJson(relay.port, '/api/tabs')).body.tabs?.length === 1);
  const before = extension.commands.length;
  const stale = await fetchJson(relay.port, '/api/eval', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabId: 't_AAAAAAAAAA', expression: '1' }),
  });

  assert.equal(stale.status, 404);
  assert.equal(stale.body.code, 'tab_not_found');
  assert.equal(extension.commands.length, before);
  const remaining = await fetchJson(relay.port, '/api/tabs');
  assert.deepEqual(remaining.body.tabs.map((tab) => tab.id), ['t_BBBBBBBBBB']);
});

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

  extension.announceTab({ sessionId: 'session-1', tabId: 't_AAAAAAAAAA', targetId: 'target-1' });
  await waitFor(async () => (await fetchJson(relay.port, '/api/tabs')).body.tabs?.length === 1);

  const { status, body } = await fetchJson(relay.port, '/api/screenshot?tabId=t_AAAAAAAAAA&fullPage=true');

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

test('click uses a DOM fallback for a hidden tab instead of reporting a false mouse success', async (t) => {
  const relay = await startRelay(t);
  let domClicked = false;
  const extension = await connectFakeExtension(t, relay.port, (cmd) => {
    if (cmd.method !== 'Runtime.evaluate') return {};
    const expression = cmd.params.expression;
    if (expression === 'document.visibilityState') {
      return { result: { value: 'hidden' } };
    }
    if (expression.includes('getBoundingClientRect')) {
      return { result: { value: JSON.stringify({ found: true, x: 120, y: 80, text: 'Refresh approvals' }) } };
    }
    if (expression.includes('el.click()')) {
      domClicked = true;
      return { result: { value: true } };
    }
    return { result: { value: null } };
  });

  extension.announceTab({ sessionId: 'session-1', tabId: 't_AAAAAAAAAA', targetId: 'target-1' });
  await waitFor(async () => (await fetchJson(relay.port, '/api/tabs')).body.tabs?.length === 1);

  const { status, body } = await fetchJson(relay.port, '/api/click', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabId: 't_AAAAAAAAAA', selector: '[data-testid="refresh-approvals"]' }),
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.clicked, true);
  assert.equal(body.strategy, 'dom');
  assert.equal(domClicked, true);
  assert.equal(extension.commands.some((cmd) => cmd.method === 'Input.dispatchMouseEvent'), false);
});

test('click keeps trusted CDP mouse events for a visible tab', async (t) => {
  const relay = await startRelay(t);
  const extension = await connectFakeExtension(t, relay.port, (cmd) => {
    if (cmd.method !== 'Runtime.evaluate') return {};
    const expression = cmd.params.expression;
    if (expression === 'document.visibilityState') {
      return { result: { value: 'visible' } };
    }
    if (expression.includes('getBoundingClientRect')) {
      return { result: { value: JSON.stringify({ found: true, x: 120, y: 80, text: 'Refresh approvals' }) } };
    }
    return { result: { value: null } };
  });

  extension.announceTab({ sessionId: 'session-1', tabId: 't_AAAAAAAAAA', targetId: 'target-1' });
  await waitFor(async () => (await fetchJson(relay.port, '/api/tabs')).body.tabs?.length === 1);

  const { status, body } = await fetchJson(relay.port, '/api/click', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabId: 't_AAAAAAAAAA', selector: '[data-testid="refresh-approvals"]' }),
  });

  assert.equal(status, 200);
  assert.equal(body.strategy, 'mouse');
  assert.deepEqual(
    extension.commands.filter((cmd) => cmd.method === 'Input.dispatchMouseEvent').map((cmd) => cmd.params.type),
    ['mouseMoved', 'mousePressed', 'mouseReleased'],
  );
});

test('wait polls until a CSS selector becomes visible', async (t) => {
  const relay = await startRelay(t);
  let checks = 0;
  const extension = await connectFakeExtension(t, relay.port, (cmd) => {
    if (cmd.method === 'Runtime.evaluate' && cmd.params.expression.includes('__browserRelayWait')) {
      checks += 1;
      return {
        result: {
          value: {
            matched: checks >= 3,
            matchCount: checks >= 2 ? 1 : 0,
            visibleCount: checks >= 3 ? 1 : 0,
          },
        },
      };
    }
    return {};
  });

  extension.announceTab({ sessionId: 'session-1', tabId: 't_AAAAAAAAAA', targetId: 'target-1' });
  await waitFor(async () => (await fetchJson(relay.port, '/api/tabs')).body.tabs?.length === 1);

  const { status, body } = await fetchJson(relay.port, '/api/wait', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tabId: 't_AAAAAAAAAA',
      selector: 'button.submit',
      state: 'visible',
      timeoutMs: 1000,
      pollMs: 50,
    }),
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.matched, true);
  assert.equal(body.selector, 'button.submit');
  assert.equal(body.state, 'visible');
  assert.equal(body.attempts, 3);
  assert.equal(body.matchCount, 1);
  assert.equal(body.visibleCount, 1);
  assert.ok(body.elapsedMs >= 90);
});

test('wait timeout is a structured retryable HTTP 408', async (t) => {
  const relay = await startRelay(t);
  const extension = await connectFakeExtension(t, relay.port, (cmd) => {
    if (cmd.method === 'Runtime.evaluate' && cmd.params.expression.includes('__browserRelayWait')) {
      return { result: { value: { matched: false, matchCount: 0, visibleCount: 0 } } };
    }
    return {};
  });

  extension.announceTab({ sessionId: 'session-1', tabId: 't_AAAAAAAAAA', targetId: 'target-1' });
  await waitFor(async () => (await fetchJson(relay.port, '/api/tabs')).body.tabs?.length === 1);

  const { status, body } = await fetchJson(relay.port, '/api/wait', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabId: 't_AAAAAAAAAA', selector: '#never', timeoutMs: 120, pollMs: 50 }),
  });

  assert.equal(status, 408);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'wait_timeout');
  assert.equal(body.retryable, true);
  assert.equal(body.status, 408);
  assert.equal(body.details.selector, '#never');
  assert.equal(body.details.state, 'visible');
  assert.equal(body.details.timeoutMs, 120);
  assert.ok(body.details.attempts >= 3);
  assert.ok(body.details.elapsedMs >= 120);
});

test('wait validates options before requiring an extension', async (t) => {
  const relay = await startRelay(t);

  const invalidState = await fetchJson(relay.port, '/api/wait', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selector: '#ready', state: 'hidden' }),
  });
  assert.equal(invalidState.status, 400);
  assert.equal(invalidState.body.code, 'invalid_request');
  assert.deepEqual(invalidState.body.details, { field: 'state' });

  const invalidTimeout = await fetchJson(relay.port, '/api/wait', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selector: '#ready', timeoutMs: 20001 }),
  });
  assert.equal(invalidTimeout.status, 400);
  assert.deepEqual(invalidTimeout.body.details, { field: 'timeoutMs' });
});

test('wait returns invalid_selector immediately for malformed CSS', async (t) => {
  const relay = await startRelay(t);
  const extension = await connectFakeExtension(t, relay.port, (cmd) => {
    if (cmd.method === 'Runtime.evaluate' && cmd.params.expression.includes('__browserRelayWait')) {
      return { result: { value: { matched: false, invalidSelector: true, message: 'Invalid selector' } } };
    }
    return {};
  });
  extension.announceTab({ sessionId: 'session-1', tabId: 't_AAAAAAAAAA', targetId: 'target-1' });
  await waitFor(async () => (await fetchJson(relay.port, '/api/tabs')).body.tabs?.length === 1);

  const { status, body } = await fetchJson(relay.port, '/api/wait', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabId: 't_AAAAAAAAAA', selector: '[', timeoutMs: 1000 }),
  });

  assert.equal(status, 400);
  assert.equal(body.code, 'invalid_selector');
  assert.equal(body.retryable, false);
  assert.deepEqual(body.details, { selector: '[' });
});

test('wait does not turn tab detach or evaluation errors into a timeout', async (t) => {
  const relay = await startRelay(t);
  let extension;
  let mode = 'detach';
  extension = await connectFakeExtension(t, relay.port, (cmd) => {
    if (cmd.method !== 'Runtime.evaluate' || !cmd.params.expression.includes('__browserRelayWait')) return {};
    if (mode === 'detach') {
      extension.sendEvent('session-1', 'Target.detachedFromTarget', { sessionId: 'session-1', targetId: 'tab-1' });
      return { result: { value: { matched: false, matchCount: 0, visibleCount: 0 } } };
    }
    throw new Error('Execution context was destroyed');
  });

  extension.announceTab({ sessionId: 'session-1', tabId: 't_AAAAAAAAAA', targetId: 'target-1' });
  await waitFor(async () => (await fetchJson(relay.port, '/api/tabs')).body.tabs?.length === 1);
  const detached = await fetchJson(relay.port, '/api/wait', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabId: 't_AAAAAAAAAA', selector: '#ready', timeoutMs: 1000, pollMs: 50 }),
  });
  assert.equal(detached.status, 404);
  assert.equal(detached.body.code, 'tab_not_found');

  mode = 'error';
  extension.announceTab({ sessionId: 'session-2', tabId: 't_BBBBBBBBBB', targetId: 'target-2' });
  await waitFor(async () => (await fetchJson(relay.port, '/api/tabs')).body.tabs?.length === 1);
  const evaluation = await fetchJson(relay.port, '/api/wait', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabId: 't_BBBBBBBBBB', selector: '#ready', timeoutMs: 1000, pollMs: 50 }),
  });
  assert.equal(evaluation.status, 409);
  assert.equal(evaluation.body.code, 'wait_evaluation_failed');
  assert.equal(evaluation.body.retryable, true);
});

test('network events are captured, filterable, clearable, and redact sensitive headers', async (t) => {
  const relay = await startRelay(t);
  const extension = await connectFakeExtension(t, relay.port);

  extension.announceTab({ sessionId: 'session-1', tabId: 't_AAAAAAAAAA', targetId: 'target-1', url: 'https://app.example.test/' });
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

test('navigate with no attached tabs opens a fresh tab and navigates it', async (t) => {
  const relay = await startRelay(t);
  let ext;
  ext = await connectFakeExtension(t, relay.port, async (cmd) => {
    if (cmd.method === 'Target.createTarget') {
      // Mirror the extension: attach + announce the new page before returning
      // its id, so the relay can resolve a session for the follow-up navigate.
      ext.announceTab({ sessionId: 'session-new', tabId: 't_CCCCCCCCCC', targetId: 'target-new', url: 'about:blank' });
      return { targetId: 'target-new', tabId: 't_CCCCCCCCCC' };
    }
    if (cmd.method === 'Page.navigate') return { frameId: 'frame-1' };
    if (cmd.method === 'Runtime.evaluate') {
      if (cmd.params?.expression === 'document.title') return { result: { value: 'Loaded' } };
      if (cmd.params?.expression === 'location.href') return { result: { value: 'https://example.test/page' } };
    }
    return {};
  });

  // No tab announced beforehand → zero attached tabs at the time of the request.
  const { status, body } = await fetchJson(relay.port, '/api/navigate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.test/page' }),
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.url, 'https://example.test/page');
  assert.equal(body.title, 'Loaded');

  const createCmd = ext.commands.find((c) => c.method === 'Target.createTarget');
  assert.ok(createCmd, 'relay should create a tab when none is attached');
  assert.equal(createCmd.params.url, 'about:blank');
  const navCmd = ext.commands.find((c) => c.method === 'Page.navigate');
  assert.equal(navCmd.params.url, 'https://example.test/page');
});

test('navigate targeting an unknown tab still fails instead of creating one', async (t) => {
  const relay = await startRelay(t);
  const ext = await connectFakeExtension(t, relay.port);

  const { status, body } = await fetchJson(relay.port, '/api/navigate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.test/page', tabId: 'does-not-exist' }),
  });

  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'tab_not_found');
  assert.ok(!ext.commands.some((c) => c.method === 'Target.createTarget'));
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
  extension.announceTab({ sessionId: 'session-1', tabId: 't_AAAAAAAAAA', targetId: 'target-1' });
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

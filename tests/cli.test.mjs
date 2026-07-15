import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version;

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startFakeRelay(t, handler) {
  const port = await getFreePort();
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { port };
}

function runCli(t, port, args, env = {}) {
  const child = spawn(process.execPath, ['server/cli.js', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BROWSER_RELAY_URL: `http://127.0.0.1:${port}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI --json preserves structured relay errors on failure', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = JSON.stringify({
      ok: false,
      code: 'endpoint_not_found',
      error: 'Unknown API endpoint: /api/tabs',
      message: 'Unknown API endpoint: /api/tabs',
      status: 404,
      retryable: false,
    });
    res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['tabs', '--json']);

  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'endpoint_not_found');
  assert.equal(payload.status, 404);
});

test('wait CLI sends stable options and prints a compact success', async (t) => {
  let received = null;
  const relay = await startFakeRelay(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    received = { method: req.method, url: req.url, body: JSON.parse(raw) };
    const body = JSON.stringify({
      ok: true,
      matched: true,
      selector: '.ready',
      state: 'attached',
      elapsedMs: 75,
      attempts: 2,
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, [
    'wait', '.ready', '--state', 'attached', '--timeout', '2500', '--poll', '75', '--tab', 'tab-1',
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Matched attached: .ready (75ms, 2 attempts)');
  assert.deepEqual(received, {
    method: 'POST',
    url: '/api/wait',
    body: { selector: '.ready', state: 'attached', timeoutMs: 2500, pollMs: 75, tabId: 'tab-1' },
  });
});

test('doctor reports a ready end-to-end browser path as structured JSON', async (t) => {
  const relay = await startFakeRelay(t, (req, res) => {
    assert.equal(req.url, '/api/debug');
    const body = JSON.stringify({ ok: true, version: packageVersion, connected: true, tabCount: 2, uptimeSeconds: 42 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['doctor', '--json']);

  assert.equal(result.code, 0);
  assert.equal(result.stderr.trim(), '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal('ready' in payload, false);
  assert.equal(payload.version, 1);
  assert.equal(payload.cliVersion, packageVersion);
  assert.deepEqual(payload.checks.map((check) => check.id), [
    'runtime',
    'assets.extension',
    'assets.skill',
    'service.registration',
    'relay.http',
    'relay.version',
    'extension.connection',
    'tabs.attached',
    'logs.access',
  ]);
  assert.equal(payload.checks.find((check) => check.id === 'extension.connection').status, 'pass');
  assert.equal(payload.checks.find((check) => check.id === 'tabs.attached').details.count, 2);
  assert.equal(payload.checks.find((check) => check.id === 'relay.http').details.uptimeSeconds, 42);
  assert.equal(payload.checks.find((check) => check.id === 'service.registration').status, 'skip');
  assert.equal(payload.summary.failed, 0);
  assert.deepEqual(payload.recommendations.filter((item) => item.includes('reload the unpacked extension')), []);
});

test('doctor treats a disconnected extension and zero tabs as warnings', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = JSON.stringify({ ok: true, version: packageVersion, connected: false, tabCount: 0 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['doctor', '--json']);

  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal('ready' in payload, false);
  assert.equal(payload.checks.find((check) => check.id === 'extension.connection').status, 'warn');
  assert.equal(payload.checks.find((check) => check.id === 'tabs.attached').status, 'warn');
  assert.ok(payload.recommendations.some((item) => item.includes('reload the unpacked extension')));
  assert.ok(payload.recommendations.some((item) => item.includes('browser-relay tabs')));
});

test('doctor warns but succeeds when CLI and daemon versions differ', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = JSON.stringify({ ok: true, version: '0.0.0-test', connected: true, tabCount: 1 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['doctor', '--json']);

  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.checks.find((check) => check.id === 'relay.version').status, 'warn');
  assert.equal(payload.summary.failed, 0);
  assert.ok(payload.recommendations.some((item) => item.includes('Restart the foreground relay process')));
});

test('doctor fails only the HTTP check for an invalid relay response', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = 'not json';
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['doctor', '--json']);

  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.checks.find((check) => check.id === 'relay.http').status, 'fail');
  assert.equal(payload.checks.find((check) => check.id === 'relay.version').status, 'skip');
  assert.equal(payload.checks.find((check) => check.id === 'extension.connection').status, 'skip');
  assert.equal(payload.checks.find((check) => check.id === 'tabs.attached').status, 'skip');
});

test('doctor rejects a JSON object that is not the debug endpoint contract', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = JSON.stringify({});
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['doctor', '--json']);

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.checks.find((check) => check.id === 'relay.http').status, 'fail');
  assert.match(payload.checks.find((check) => check.id === 'relay.http').message, /invalid debug payload/);
});

test('doctor human output has stable prefixes and summary', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = JSON.stringify({ ok: true, version: packageVersion, connected: false, tabCount: 0 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['doctor'], { NO_COLOR: '1' });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Browser Relay doctor/m);
  assert.match(result.stdout, /^\[PASS\] Relay HTTP debug endpoint is healthy$/m);
  assert.match(result.stdout, /^\[WARN\] Chrome extension is not connected$/m);
  assert.match(result.stdout, /^\[SKIP\] Local background service check skipped for a custom relay URL$/m);
  assert.match(result.stdout, /^Doctor: \d+ passed, \d+ warnings, 0 failed, \d+ skipped$/m);
  assert.doesNotMatch(result.stdout, /\x1b\[/);
});

test('doctor redacts query parameters from its JSON relay URL', async (t) => {
  const relay = await startFakeRelay(t, (req, res) => {
    assert.equal(req.url, '/api/debug?token=secret-value');
    const body = JSON.stringify({ ok: true, version: packageVersion, connected: true, tabCount: 1 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  const relayUrl = `http://127.0.0.1:${relay.port}?token=secret-value`;

  const result = await runCli(t, relay.port, ['doctor', '--json'], { BROWSER_RELAY_URL: relayUrl });

  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /secret-value/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.relayUrl, `http://127.0.0.1:${relay.port}`);
});

test('doctor uses exit code 2 for unknown options and supports help', async (t) => {
  const port = await getFreePort();
  const invalid = await runCli(t, port, ['doctor', '--bogus']);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /Unknown doctor option: --bogus/);

  const invalidJson = await runCli(t, port, ['doctor', '--json', '--bogus']);
  assert.equal(invalidJson.code, 2);
  assert.equal(invalidJson.stderr.trim(), '');
  assert.equal(JSON.parse(invalidJson.stdout).code, 'invalid_option');

  const help = await runCli(t, port, ['doctor', '--help']);
  assert.equal(help.code, 0);
  assert.equal(help.stderr.trim(), '');
  assert.match(help.stdout, /browser-relay doctor \[--json\]/);
  assert.match(help.stdout, /never installs or restarts anything/);
});

test('doctor rejects URL userinfo without exposing credentials', async (t) => {
  const port = await getFreePort();
  const relayUrl = `http://secret-user:secret-password@127.0.0.1:${port}`;

  const result = await runCli(t, port, ['doctor', '--json'], { BROWSER_RELAY_URL: relayUrl });

  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout, /secret-user|secret-password/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.relayUrl, `http://127.0.0.1:${port}`);
  assert.match(payload.checks.find((check) => check.id === 'relay.http').message, /userinfo is not supported/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import net from 'node:net';

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

function runCli(t, port, args) {
  const child = spawn(process.execPath, ['server/cli.js', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BROWSER_RELAY_URL: `http://127.0.0.1:${port}` },
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

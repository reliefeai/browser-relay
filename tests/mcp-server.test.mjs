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

function writeMcpMessage(stream, msg) {
  const json = JSON.stringify(msg);
  stream.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function readMcpMessage(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) return;
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      stream.off('data', onData);
      resolve(JSON.parse(buffer.slice(bodyStart, bodyStart + length)));
    };
    stream.on('data', onData);
    stream.on('error', reject);
  });
}

test('MCP tool calls map structured relay errors to isError responses', async (t) => {
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

  const child = spawn(process.execPath, ['server/mcp-server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, BROWSER_RELAY_URL: `http://127.0.0.1:${relay.port}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });

  writeMcpMessage(child.stdin, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'browser_tabs', arguments: {} },
  });

  const msg = await readMcpMessage(child.stdout);

  assert.equal(msg.id, 1);
  assert.equal(msg.result.isError, true);
  const payload = JSON.parse(msg.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'endpoint_not_found');
  assert.equal(payload.status, 404);
});

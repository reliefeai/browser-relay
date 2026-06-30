import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('keepalive reconnect path recovers relay tab session after direct reconnect', () => {
  const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf-8');

  assert.match(source, /async function recoverRelaySession\s*\(\)\s*{/);
  assert.match(
    source,
    /Keepalive: WebSocket unhealthy, triggering reconnect[\s\S]*await ensureRelayConnection\(\)[\s\S]*await recoverRelaySession\(\)/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteAuthMessageHandler } from '../extension/remote-auth.js';

test('remote auth handler keeps one stateful path and forwards the first RPC after authentication', () => {
  const events = [];
  const handler = createRemoteAuthMessageHandler({
    onAuthenticated: () => events.push('authenticated'),
    onMessage: (_text, msg) => events.push(msg),
  });

  handler(JSON.stringify({ type: 'rpc.request', id: 'too-early' }));
  handler(JSON.stringify({ type: 'device.authenticated' }));
  handler(JSON.stringify({ type: 'rpc.request', id: 'first-after-auth' }));

  assert.deepEqual(events, [
    'authenticated',
    { type: 'rpc.request', id: 'first-after-auth' },
  ]);
});

test('remote auth handler ignores malformed and duplicate authentication frames', () => {
  let authenticated = 0;
  const messages = [];
  const handler = createRemoteAuthMessageHandler({
    onAuthenticated: () => { authenticated += 1; },
    onMessage: (_text, msg) => messages.push(msg),
  });

  handler('not json');
  handler(JSON.stringify({ type: 'device.authenticated' }));
  handler(JSON.stringify({ type: 'device.authenticated' }));
  assert.equal(authenticated, 1);
  assert.deepEqual(messages, []);
});

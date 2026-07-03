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

test('options external-control UI is off by default and exposes generate/regenerate/copy affordances', () => {
  const html = readFileSync(new URL('../extension/options.html', import.meta.url), 'utf-8');
  const js = readFileSync(new URL('../extension/options.js', import.meta.url), 'utf-8');

  assert.match(html, /id="remoteState" class="state-pill is-off">Off/);
  assert.match(html, /id="remoteDetails" class="remote-details hidden"/);
  assert.match(html, /id="copyRemoteDeviceId"/);
  assert.match(js, /newRemoteCapability\s*\(\)/);
  assert.match(js, /Enable & Generate Device ID/);
  assert.match(js, /Regenerate Device ID/);
  assert.match(js, /chrome\.storage\.local\.remove\(\['remoteRouteId', 'remoteSecret', 'remoteDeviceId'\]\)/);
  assert.doesNotMatch(js, /Reconnect External Control/);
});

test('extension external-control talks directly to hub, not local relay remote endpoints', () => {
  const options = readFileSync(new URL('../extension/options.js', import.meta.url), 'utf-8');
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf-8');

  assert.doesNotMatch(options, /\/api\/remote\/(enable|disable|status)/);
  assert.match(options, /chrome\.runtime\.sendMessage\(\{ type: 'enableRemoteControl'/);
  assert.match(options, /chrome\.runtime\.sendMessage\(\{ type: 'disableRemoteControl'/);
  assert.match(background, /async function ensureRemoteHubConnection\s*\(/);
  assert.match(background, /async function onRemoteHubMessage\s*\(/);
  assert.match(background, /msg\?\.type === 'enableRemoteControl'/);
  assert.match(background, /msg\?\.type === 'disableRemoteControl'/);
});

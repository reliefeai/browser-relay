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

test('extension owns one 12-character formal tab id across local and remote paths', () => {
  const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf-8');

  assert.match(source, /PUBLIC_TAB_ID_PATTERN = \/\^t_\[A-Za-z0-9_-\]\{10\}\$\//);
  assert.match(source, /crypto\.getRandomValues\(new Uint8Array\(10\)\)/);
  assert.match(source, /while \(issuedPublicTabIds\.has\(id\)\)/);
  assert.match(source, /persistedPublicTabIds:[\s\S]*issuedPublicTabIds:/);
  assert.match(source, /Target\.attachedToTarget'[\s\S]*tabId: publicTabId/);
  assert.match(source, /sessionId: source\.sessionId \|\| tab\.sessionId, tabId: publicTabIdFor\(tabId\), method, params/);
  assert.match(source, /id: publicTabIdFor\(t\.id\)/);
  assert.match(source, /const base = \{ tabId: publicTabIdFor\(tabId\) \}/);

  const remoteResolver = source.slice(
    source.indexOf('async function resolveRemoteTabId'),
    source.indexOf('async function ensureRemoteAttached'),
  );
  assert.match(remoteResolver, /PUBLIC_TAB_ID_PATTERN\.test\(publicTabId\)/);
  assert.doesNotMatch(remoteResolver, /getTabByTargetId|Number\(tabIdParam\)/);
  assert.match(source, /if \(sessionId && !bySession\) throw new Error/);
});

test('options remote-relay UI is off by default and exposes toggle/regenerate/copy affordances', () => {
  const html = readFileSync(new URL('../extension/options.html', import.meta.url), 'utf-8');
  const js = readFileSync(new URL('../extension/options.js', import.meta.url), 'utf-8');

  assert.match(html, /class="lbl is-off" id="remoteState"/);
  assert.match(html, /id="remoteToggle"/);
  assert.match(html, /id="remoteDetails" class="hidden"/);
  assert.match(html, /id="copyRemoteDeviceId"/);
  assert.match(html, /id="copyRemoteCommand"/);
  assert.match(html, /id="regenerateDevice"/);
  assert.match(js, /newRemoteCapability\s*\(/);
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
  assert.match(background, /async function handleHubMessage\s*\(/);
  assert.match(background, /msg\?\.type === 'enableRemoteControl'/);
  assert.match(background, /msg\?\.type === 'disableRemoteControl'/);
  assert.match(background, /type: 'device\.auth', secret: cfg\.remoteSecret/);
  assert.match(background, /createRemoteAuthMessageHandler/);
  const remoteConnectSource = background.slice(
    background.indexOf('async function ensureRemoteHubConnection'),
    background.indexOf('function onRemoteHubClosed'),
  );
  assert.equal((remoteConnectSource.match(/ws\.onmessage\s*=/g) || []).length, 1);
  assert.match(background, /remoteAuthenticated = true[\s\S]*resolve\(\)/);
  assert.match(background, /function remoteConnected\(\)[\s\S]*remoteAuthenticated/);
  assert.doesNotMatch(background, /device\/connect\?[^\n`]*token=/);
});

test('remote click falls back to DOM click when the controlled tab is in the background', () => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf-8');

  assert.match(background, /const visibility = await evalValue\(tabId, 'document\.visibilityState'\)/);
  assert.match(background, /visibility === 'hidden'[\s\S]*el\.click\(\)[\s\S]*strategy: 'dom'/);
  assert.match(background, /strategy: 'mouse'/);
});

test('remote extension executor exposes the same wait contract as the local relay', () => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf-8');

  assert.match(background, /import \{ buildWaitExpression, normalizeWaitOptions \} from '\.\/wait\.js'/);
  assert.match(background, /capabilities: \[[^\]]*'wait'/);
  assert.match(background, /p === '\/api\/wait'\) return await apiWait\(payload\)/);
  assert.match(background, /async function apiWait\s*\(body\)\s*{/);
  assert.match(background, /'wait_timeout'[\s\S]*408[\s\S]*true/);
  assert.match(background, /'tab_not_found'/);
  assert.match(background, /'wait_evaluation_failed'/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

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

test('options requires explicit local and remote consent before enabling control', () => {
  const html = readFileSync(new URL('../extension/options.html', import.meta.url), 'utf-8');
  const js = readFileSync(new URL('../extension/options.js', import.meta.url), 'utf-8');

  assert.match(html, /id="localToggle"/);
  assert.match(html, /id="localConsent" class="disclosure hidden"/);
  assert.match(html, /id="localConsentCheck"/);
  assert.match(html, /id="localConsentApply"/);
  assert.match(html, /class="lbl is-off" id="remoteState"/);
  assert.match(html, /id="remoteToggle"/);
  assert.match(html, /id="remoteDisclosure" class="disclosure hidden"/);
  assert.match(html, /id="remoteDisclosureCheck"/);
  assert.match(html, /id="remoteDisclosureApply"/);
  assert.match(html, /id="remoteDetails" class="hidden"/);
  assert.match(html, /id="copyRemoteDeviceId"/);
  assert.match(html, /id="copyRemoteCommand"/);
  assert.match(html, /id="regenerateDevice"/);
  assert.match(js, /type: 'enableLocalControl'/);
  assert.match(js, /fetch\(`http:\/\/127\.0\.0\.1:\$\{port\}\/api\/debug`/);
  assert.ok(js.indexOf('await prepareLoopbackAccess(port)') < js.indexOf("chrome.runtime.sendMessage({ type: 'enableLocalControl'"));
  assert.match(js, /renderLocal\(data\?\.connected === true\)/);
  assert.match(js, /disclosureConfirmed: true/);
  assert.match(js, /newRemoteCapability\s*\(/);
  assert.doesNotMatch(js, /remoteControlEnabled:\s*true[\s\S]{0,200}chrome\.runtime\.sendMessage/);
  assert.doesNotMatch(js, /Reconnect External Control/);
});

test('extension external-control talks directly to hub, not local relay remote endpoints', () => {
  const options = readFileSync(new URL('../extension/options.js', import.meta.url), 'utf-8');
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf-8');

  assert.doesNotMatch(options, /\/api\/remote\/(enable|disable|status)/);
  assert.match(options, /type: 'enableRemoteControl'/);
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
  assert.match(background, /remoteAuthenticated = true[\s\S]*finish\(resolve\)/);
  assert.match(background, /function remoteConnected\(\)[\s\S]*remoteAuthenticated/);
  assert.doesNotMatch(background, /device\/connect\?[^\n`]*token=/);
});

test('manifest minimizes permissions and runtime gates optional downloads and custom hosts', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf-8'));
  const options = readFileSync(new URL('../extension/options.js', import.meta.url), 'utf-8');
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf-8');

  assert.equal(manifest.permissions.includes('activeTab'), false);
  assert.equal(manifest.permissions.includes('webNavigation'), false);
  assert.equal(manifest.permissions.includes('downloads'), false);
  assert.deepEqual(manifest.optional_permissions, ['downloads']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
  assert.match(options, /chrome\.permissions\.request\(\{ permissions: \['downloads'\] \}\)/);
  assert.match(options, /chrome\.permissions\.request\(\{ origins: \[host\.permissionOrigin\] \}\)/);
  assert.match(background, /downloads_permission_required/);
  assert.match(background, /refreshDownloadEventListeners/);
  assert.doesNotMatch(background, /chrome\.webNavigation/);
});

test('service worker startup is deny-by-default and reconnect paths honor local consent', () => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf-8');
  const popup = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf-8');

  assert.match(background, /const initPromise = initializeExtensionState\(\)/);
  assert.match(background, /if \(consent\.localEnabled\)[\s\S]*ensureRelayConnection/);
  assert.match(background, /if \(!localControlEnabled\) throw new Error\('Local control requires explicit consent/);
  assert.match(background, /async function disableLocalControl[\s\S]*closeLocalRelay\(\)[\s\S]*detachAllControlledTabs/);
  assert.match(background, /async function autoAttachAllTabs\(\)[\s\S]*if \(!localControlEnabled\) return/);
  assert.match(popup, /if \(!lastState\?\.enabled\)[\s\S]*openOptionsPage/);
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
  assert.match(background, /const capabilities = \[[^\]]*'wait'/);
  assert.match(background, /p === '\/api\/wait'\) return await apiWait\(payload\)/);
  assert.match(background, /async function apiWait\s*\(body\)\s*{/);
  assert.match(background, /'wait_timeout'[\s\S]*408[\s\S]*true/);
  assert.match(background, /'tab_not_found'/);
  assert.match(background, /'wait_evaluation_failed'/);
});

test('every Options and popup translation key exists in English and Chinese', () => {
  const html = [
    readFileSync(new URL('../extension/options.html', import.meta.url), 'utf-8'),
    readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf-8'),
  ].join('\n');
  const uiJs = [
    readFileSync(new URL('../extension/options.js', import.meta.url), 'utf-8'),
    readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf-8'),
  ].join('\n');
  const i18nSource = readFileSync(new URL('../extension/i18n.js', import.meta.url), 'utf-8');
  const keys = new Set([
    ...[...html.matchAll(/data-i18n(?:-html|-ph)?="([^"]+)"/g)].map((match) => match[1]),
    ...[...uiJs.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1]),
  ]);
  const context = {
    chrome: { i18n: { getUILanguage: () => 'en' } },
    navigator: { language: 'en' },
    document: { querySelectorAll: () => [] },
    window: {},
  };
  runInNewContext(i18nSource, context);

  for (const lang of ['en', 'zh_CN']) {
    context.window.I18N.setLang(lang);
    for (const key of keys) {
      assert.notEqual(context.window.I18N.t(key), key, `${lang} is missing ${key}`);
    }
  }
});

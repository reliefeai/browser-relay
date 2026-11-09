import test from 'node:test';
import assert from 'node:assert/strict';
import { setupBrowser, waitFor } from './helpers/real-browser.mjs';

test('background reads, input and scrolling preserve the user foreground tab', {
  skip: process.env.BROWSER_RELAY_E2E !== '1', timeout: 45000,
}, async t => {
  const env = await setupBrowser({ nativeVisibility: true });
  t.after(env.close);
  const { page, context, worker, tab, fixtureUrl } = env;
  const foreground = await context.newPage();
  await foreground.goto(fixtureUrl + '?user-foreground');
  await foreground.bringToFront();
  await waitFor(() => page.evaluate(() => document.visibilityState === 'hidden'));
  await worker.evaluate(() => {
    globalThis.focusEvents = [];
    chrome.tabs.onActivated.addListener(info => globalThis.focusEvents.push({ kind: 'tab', id: info.tabId }));
    chrome.windows.onFocusChanged.addListener(id => globalThis.focusEvents.push({ kind: 'window', id }));
  });
  const assertBackground = async () => {
    assert.equal(await page.evaluate(() => document.visibilityState), 'hidden');
    assert.equal(await foreground.evaluate(() => document.visibilityState), 'visible');
    assert.deepEqual(await worker.evaluate(() => globalThis.focusEvents), []);
  };
  await assertBackground();
  assert.match((await tab.read()).snapshot, /Browser Relay benchmark/);
  const scrolled = await tab.scroll(250, { waitForChange: true, timeoutMs: 100 });
  assert.equal(scrolled.results[0].strategy, 'dom');
  assert.equal(scrolled.results[0].viewportMoved, true);
  assert.equal(scrolled.results[0].contentChanged, false);
  assert((await page.evaluate(() => scrollY)) > 0);
  await assertBackground();
  // Even an old caller passing allowFocus must not activate a tab for scrolling.
  await tab.scroll(-150, { x: 10, y: 10, allowFocus: true });
  await assertBackground();
  await tab.act([{ type: 'scroll', target: { selector: '#scrollbox' }, deltaY: 80 }]);
  const before = await page.locator('#scrollbox').evaluate(el => el.scrollTop);
  assert(before > 0);
  const rect = await page.locator('#scrollbox').boundingBox();
  await tab.scroll(60, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  assert((await page.locator('#scrollbox').evaluate(el => el.scrollTop)) > before);
  await assertBackground();
  await tab.getByRole('textbox', { name: 'Search', exact: true }).fill('background');
  await tab.getByRole('button', { name: 'Add row', exact: true }).click();
  assert.equal(await page.locator('input[name=query]').inputValue(), 'background');
  assert.equal(await page.locator('#rows li').count(), 2);
  await assertBackground();
  await assert.rejects(() => tab.clickAt(10, 10), { code: 'needs_foreground' });
  await assertBackground();
  await tab.focus();
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
  await waitFor(() => worker.evaluate(() => globalThis.focusEvents.some(e => e.kind === 'tab')));
  await env.browser.dispose();
});

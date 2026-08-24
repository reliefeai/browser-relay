import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogBlockedMessage, normalizeDialog } from '../extension/dialog.js';

test('normalizeDialog exposes the stable public dialog fields', () => {
  assert.deepEqual(normalizeDialog({
    type: 'prompt',
    message: 'Name?',
    url: 'https://example.test/form',
    defaultPrompt: 'Anonymous',
    hasBrowserHandler: true,
  }, { tabId: 't_AAAAAAAAAA', openedAt: 42 }), {
    type: 'prompt',
    message: 'Name?',
    url: 'https://example.test/form',
    defaultPrompt: 'Anonymous',
    hasBrowserHandler: true,
    openedAt: 42,
    tabId: 't_AAAAAAAAAA',
  });
});

test('dialogBlockedMessage tells callers to make an explicit decision', () => {
  const message = dialogBlockedMessage({ type: 'confirm' });
  assert.match(message, /blocked by an open confirm dialog/);
  assert.match(message, /explicitly accept or dismiss/);
});

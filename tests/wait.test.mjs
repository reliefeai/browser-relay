import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWaitExpression,
  normalizeWaitOptions,
  WAIT_DEFAULT_POLL_MS,
  WAIT_DEFAULT_TIMEOUT_MS,
} from '../extension/wait.js';

function element({ width = 10, height = 10, styles = {}, parentElement = null } = {}) {
  return {
    isConnected: true,
    nodeType: 1,
    parentElement,
    getBoundingClientRect: () => ({ width, height }),
    getClientRects: () => (width > 0 || height > 0 ? [{}] : []),
    styles,
  };
}

function evaluateWait(selector, state, nodesOrError) {
  const document = {
    querySelectorAll: () => {
      if (nodesOrError instanceof Error) throw nodesOrError;
      return nodesOrError;
    },
  };
  const getComputedStyle = (node) => ({
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    ...node.styles,
  });
  return Function('document', 'getComputedStyle', `return ${buildWaitExpression(selector, state)}`)(document, getComputedStyle);
}

test('wait options have stable defaults and reject out-of-range input', () => {
  assert.deepEqual(normalizeWaitOptions({ selector: '#ready' }), {
    ok: true,
    selector: '#ready',
    state: 'visible',
    timeoutMs: WAIT_DEFAULT_TIMEOUT_MS,
    pollMs: WAIT_DEFAULT_POLL_MS,
    tabId: undefined,
  });
  assert.deepEqual(normalizeWaitOptions({ selector: '  ' }), {
    ok: false,
    field: 'selector',
    message: 'selector is required',
  });
  assert.equal(normalizeWaitOptions({ selector: '#ready', state: 'hidden' }).field, 'state');
  assert.equal(normalizeWaitOptions({ selector: '#ready', timeoutMs: 0 }).field, 'timeoutMs');
  assert.equal(normalizeWaitOptions({ selector: '#ready', pollMs: 49 }).field, 'pollMs');
});

test('attached wait succeeds for a hidden element while visible wait does not', () => {
  const hidden = element({ width: 0, height: 0, styles: { display: 'none' } });
  assert.deepEqual(evaluateWait('#ready', 'attached', [hidden]), {
    matched: true,
    matchCount: 1,
    visibleCount: 0,
  });
  assert.deepEqual(evaluateWait('#ready', 'visible', [hidden]), {
    matched: false,
    matchCount: 1,
    visibleCount: 0,
  });
});

test('visible wait checks every match and ancestor visibility', () => {
  const transparentParent = element({ styles: { opacity: '0' } });
  const hiddenByParent = element({ parentElement: transparentParent });
  const visible = element();
  assert.deepEqual(evaluateWait('.item', 'visible', [hiddenByParent, visible]), {
    matched: true,
    matchCount: 2,
    visibleCount: 1,
  });
});

test('wait expression reports invalid CSS selectors without throwing', () => {
  const result = evaluateWait('[', 'visible', new Error('Invalid selector'));
  assert.equal(result.matched, false);
  assert.equal(result.invalidSelector, true);
  assert.match(result.message, /Invalid selector/);
});

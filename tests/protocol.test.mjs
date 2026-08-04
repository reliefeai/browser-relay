import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BRIDGE_PROTOCOL,
  bridgeCompatibility,
  negotiateBridgeProtocol,
  sanitizeBridgeCapabilities,
} from '../extension/protocol.js'

test('bridge protocol treats an undeclared old peer as compatible legacy mode', () => {
  assert.deepEqual(negotiateBridgeProtocol(undefined), {
    compatible: true,
    mode: 'legacy',
    selected: 1,
    peer: null,
    reason: null,
  })
})

test('bridge protocol selects the highest shared version without requiring package versions to match', () => {
  const compatibility = bridgeCompatibility({
    localVersion: '1.4.0',
    peerVersion: '1.3.2',
    peerProtocol: { name: BRIDGE_PROTOCOL.name, min: 1, max: 3 },
    peerCapabilities: ['tabs', 'CDP', 'tabs', '../invalid'],
  })
  assert.equal(compatibility.compatible, true)
  assert.equal(compatibility.selected, 1)
  assert.equal(compatibility.versionMismatch, true)
  assert.deepEqual(compatibility.peerCapabilities, ['cdp', 'tabs'])
})

test('bridge protocol rejects malformed, foreign, and non-overlapping declarations', () => {
  assert.equal(negotiateBridgeProtocol({ name: BRIDGE_PROTOCOL.name, min: 2, max: 1 }).compatible, false)
  assert.match(negotiateBridgeProtocol({ name: 'other-protocol', min: 1, max: 1 }).reason, /Unsupported/)
  assert.match(negotiateBridgeProtocol({ name: BRIDGE_PROTOCOL.name, min: 2, max: 3 }).reason, /No compatible/)
})

test('bridge capability declarations are normalized, deduplicated, and bounded', () => {
  assert.deepEqual(sanitizeBridgeCapabilities(['Wait', 'wait', 'downloads', '', 'bad capability', 42]), ['downloads', 'wait'])
})

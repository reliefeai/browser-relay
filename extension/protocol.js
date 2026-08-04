export const BRIDGE_PROTOCOL = Object.freeze({
  name: 'browser-relay-bridge',
  min: 1,
  max: 1,
})

export const BRIDGE_BASE_CAPABILITIES = Object.freeze([
  'cdp',
  'tabs',
  'eval',
  'wait',
  'snapshot',
  'click',
  'type',
  'key',
  'scroll',
  'navigate',
  'screenshot',
  'console',
  'network',
])

function protocolInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 ? number : null
}

export function normalizeBridgeProtocol(value) {
  if (!value || typeof value !== 'object') return null
  const min = protocolInteger(value.min)
  const max = protocolInteger(value.max)
  if (!min || !max || min > max) return null
  return {
    name: typeof value.name === 'string' ? value.name : '',
    min,
    max,
  }
}

export function negotiateBridgeProtocol(peerProtocol) {
  if (peerProtocol === undefined || peerProtocol === null) {
    return {
      compatible: true,
      mode: 'legacy',
      selected: BRIDGE_PROTOCOL.min,
      peer: null,
      reason: null,
    }
  }

  const peer = normalizeBridgeProtocol(peerProtocol)
  if (!peer) {
    return {
      compatible: false,
      mode: 'declared',
      selected: null,
      peer: null,
      reason: 'The peer returned an invalid Browser Relay bridge protocol range.',
    }
  }
  if (peer.name !== BRIDGE_PROTOCOL.name) {
    return {
      compatible: false,
      mode: 'declared',
      selected: null,
      peer,
      reason: `Unsupported bridge protocol: ${peer.name || '(missing)'}.`,
    }
  }

  const minimum = Math.max(BRIDGE_PROTOCOL.min, peer.min)
  const maximum = Math.min(BRIDGE_PROTOCOL.max, peer.max)
  if (minimum > maximum) {
    return {
      compatible: false,
      mode: 'declared',
      selected: null,
      peer,
      reason: `No compatible bridge protocol (extension ${BRIDGE_PROTOCOL.min}-${BRIDGE_PROTOCOL.max}, daemon ${peer.min}-${peer.max}).`,
    }
  }
  return {
    compatible: true,
    mode: 'declared',
    selected: maximum,
    peer,
    reason: null,
  }
}

export function sanitizeBridgeCapabilities(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item) => typeof item === 'string' && /^[a-z][a-z0-9._-]{0,63}$/i.test(item))
    .map((item) => item.toLowerCase()))]
    .sort()
}

export function bridgeCompatibility({ localVersion, peerVersion, peerProtocol, peerCapabilities } = {}) {
  const negotiation = negotiateBridgeProtocol(peerProtocol)
  const normalizedLocalVersion = typeof localVersion === 'string' && localVersion ? localVersion : null
  const normalizedPeerVersion = typeof peerVersion === 'string' && peerVersion ? peerVersion : null
  return {
    ...negotiation,
    localVersion: normalizedLocalVersion,
    peerVersion: normalizedPeerVersion,
    versionMismatch: !!normalizedLocalVersion && !!normalizedPeerVersion && normalizedLocalVersion !== normalizedPeerVersion,
    peerCapabilities: sanitizeBridgeCapabilities(peerCapabilities),
  }
}

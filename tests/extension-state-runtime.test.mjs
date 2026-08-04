import test from 'node:test'
import assert from 'node:assert/strict'

class MockEvent {
  constructor() { this.listeners = [] }
  addListener(listener) { this.listeners.push(listener) }
  removeListener(listener) { this.listeners = this.listeners.filter((item) => item !== listener) }
  async emit(...args) {
    for (const listener of [...this.listeners]) await listener(...args)
  }
}

function storageArea(initial = {}) {
  const data = structuredClone(initial)
  const area = {
    data,
    beforeGet: null,
    beforeSet: null,
    async get(keys) {
      if (area.beforeGet) await area.beforeGet(keys)
      if (keys == null) return structuredClone(data)
      if (typeof keys === 'string') return { [keys]: structuredClone(data[keys]) }
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, structuredClone(data[key])]))
      const result = { ...keys }
      for (const key of Object.keys(keys)) if (key in data) result[key] = structuredClone(data[key])
      return result
    },
    async set(values) {
      if (area.beforeSet) await area.beforeSet(structuredClone(values))
      Object.assign(data, structuredClone(values))
    },
    async remove(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete data[key]
    },
  }
  return area
}

function buildChrome({ local = {}, session = {}, tabs = [], grantedOrigins = [], removeOrigins = true } = {}) {
  const localArea = storageArea(local)
  const sessionArea = storageArea(session)
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]))
  const calls = { attach: [], detach: [], fetch: [], webSockets: [], openedOptions: 0, reloads: 0 }
  const events = {
    onMessage: new MockEvent(),
    onInstalled: new MockEvent(),
    onAlarm: new MockEvent(),
  }
  const permissions = {
    origins: new Set(grantedOrigins),
    permissions: new Set(),
    removeOrigins,
  }

  const chrome = {
    storage: { local: localArea, session: sessionArea },
    runtime: {
      onMessage: events.onMessage,
      onInstalled: events.onInstalled,
      getManifest: () => ({ version: '1.2.1' }),
      openOptionsPage: async () => { calls.openedOptions++ },
      reload: () => { calls.reloads++ },
    },
    alarms: {
      create: () => {},
      onAlarm: events.onAlarm,
    },
    permissions: {
      onAdded: new MockEvent(),
      onRemoved: new MockEvent(),
      contains: async ({ permissions: requestedPermissions = [], origins = [] }) => (
        requestedPermissions.every((value) => permissions.permissions.has(value))
        && origins.every((value) => permissions.origins.has(value))
      ),
      remove: async ({ permissions: removedPermissions = [], origins = [] }) => {
        if (!permissions.removeOrigins && origins.length) return false
        for (const value of removedPermissions) permissions.permissions.delete(value)
        for (const value of origins) permissions.origins.delete(value)
        return true
      },
    },
    tabs: {
      onRemoved: new MockEvent(),
      onReplaced: new MockEvent(),
      onUpdated: new MockEvent(),
      onActivated: new MockEvent(),
      query: async () => [...tabMap.values()].map((tab) => ({ ...tab })),
      get: async (tabId) => {
        if (!tabMap.has(tabId)) throw new Error('No tab')
        return { ...tabMap.get(tabId) }
      },
      create: async ({ url, active }) => {
        const id = Math.max(0, ...tabMap.keys()) + 1
        const tab = { id, url, title: '', active, windowId: 1 }
        tabMap.set(id, tab)
        return { ...tab }
      },
      update: async (tabId, patch) => Object.assign(tabMap.get(tabId), patch),
      remove: async (tabId) => { tabMap.delete(tabId) },
    },
    windows: { update: async () => ({}) },
    debugger: {
      onEvent: new MockEvent(),
      onDetach: new MockEvent(),
      attach: async ({ tabId }) => { calls.attach.push(tabId) },
      detach: async ({ tabId }) => { calls.detach.push(tabId) },
      sendCommand: async ({ tabId }, method) => {
        if (!tabMap.has(tabId)) throw new Error('No tab')
        if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: `target-${tabId}`, title: tabMap.get(tabId).title, url: tabMap.get(tabId).url } }
        return { result: { value: 1 } }
      },
    },
    action: {
      onClicked: new MockEvent(),
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
      setTitle: async () => {},
    },
    downloads: {
      onCreated: new MockEvent(),
      onChanged: new MockEvent(),
      onErased: new MockEvent(),
      download: async () => 1,
      search: async () => [],
    },
  }

  async function sendMessage(message) {
    const listener = events.onMessage.listeners[0]
    assert.ok(listener, 'background message listener should be registered')
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No response for ${message.type}`)), 1000)
      const sendResponse = (value) => { clearTimeout(timeout); resolve(value) }
      const keepAlive = listener(message, {}, sendResponse)
      if (keepAlive !== true) { clearTimeout(timeout); resolve(undefined) }
    })
  }

  return { chrome, calls, events, permissions, localArea, sessionArea, sendMessage }
}

function fakeWebSocketClass({ remoteFails = false, remoteBehavior = null, calls = null } = {}) {
  return class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    constructor(url) {
      this.url = url
      this.sent = []
      this.readyState = FakeWebSocket.CONNECTING
      calls?.webSockets.push(this)
      const behavior = url.includes('/v1/device/connect')
        ? (remoteBehavior?.(url) || { fail: remoteFails, delay: 0 })
        : { fail: false, delay: 0 }
      const settle = () => {
        if (this.readyState === FakeWebSocket.CLOSED) return
        if (behavior.fail) {
          this.readyState = FakeWebSocket.CLOSED
          this.onerror?.(new Error('remote failed'))
          return
        }
        this.readyState = FakeWebSocket.OPEN
        this.onopen?.()
      }
      if (behavior.delay) setTimeout(settle, behavior.delay)
      else queueMicrotask(settle)
    }
    send(value) {
      this.sent.push(String(value))
      const message = JSON.parse(String(value))
      if (message.type === 'device.auth') {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'device.authenticated' }) }))
      }
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.({ code: 1000 })
    }
  }
}

let importCounter = 0
async function loadBackground(harness, {
  fetchImpl,
  remoteFails = false,
  remoteBehavior = null,
  settle = true,
} = {}) {
  globalThis.chrome = harness.chrome
  globalThis.WebSocket = fakeWebSocketClass({ remoteFails, remoteBehavior, calls: harness.calls })
  globalThis.fetch = async (...args) => {
    harness.calls.fetch.push(args)
    if (fetchImpl) return await fetchImpl(...args)
    return { ok: true, json: async () => ({ version: '1.2.1' }) }
  }
  await import(`../extension/background.js?runtime-test=${++importCounter}`)
  if (!settle) return
  await harness.events.onAlarm.emit({ name: 'relay-keepalive' })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const currentLocalConsent = {
  localConsentVersion: 1,
  localConsentAcceptedAt: 1,
}
const currentRemoteConsent = {
  remoteDisclosureVersion: 1,
  remoteDisclosureAcceptedAt: 1,
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function waitUntil(predicate, message, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.fail(message)
}

test('fresh startup and reconnect stay inert before local consent', async () => {
  const harness = buildChrome({
    tabs: [{ id: 1, url: 'https://example.com', title: 'Example' }],
    session: { persistedTabs: [{ tabId: 1, sessionId: 'old', targetId: 'old-target' }] },
  })
  await loadBackground(harness)

  assert.equal(harness.calls.fetch.length, 0)
  assert.deepEqual(harness.calls.attach, [])
  assert.deepEqual(harness.calls.detach, [1])
  const reconnect = await harness.sendMessage({ type: 'reconnect' })
  assert.equal(reconnect.consentRequired, true)
  assert.equal(harness.calls.openedOptions, 1)
})

test('fresh install opens Local onboarding without connecting or attaching tabs', async () => {
  const harness = buildChrome({
    tabs: [{ id: 1, url: 'https://example.com', title: 'Example' }],
  })
  await loadBackground(harness)
  harness.calls.fetch.length = 0
  harness.calls.attach.length = 0

  await harness.events.onInstalled.emit({ reason: 'install' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(harness.localArea.data.localOnboardingPending, true)
  assert.equal(harness.localArea.data.localControlEnabled, false)
  assert.equal(harness.calls.openedOptions, 1)
  assert.equal(harness.calls.fetch.length, 0)
  assert.deepEqual(harness.calls.attach, [])
})

test('an install event does not re-arm onboarding after Local consent', async () => {
  const harness = buildChrome({
    local: {
      localControlEnabled: true,
      localConsentVersion: 1,
      localConsentAcceptedAt: Date.now(),
      localOnboardingPending: false,
    },
  })
  await loadBackground(harness)

  await harness.events.onInstalled.emit({ reason: 'install' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(harness.localArea.data.localOnboardingPending, false)
})

test('status messages wait for consent state restoration after a service worker wake', async () => {
  const harness = buildChrome({
    local: {
      ...currentLocalConsent,
      localControlEnabled: true,
      ...currentRemoteConsent,
      remoteControlEnabled: true,
      remoteHost: 'https://relay.linso.ai',
      remoteRouteId: 'route-id',
      remoteSecret: 'secret-value',
      remoteDeviceId: 'br-secret-value',
    },
    tabs: [{ id: 1, url: 'https://example.com', title: 'Example' }],
  })
  const startupGate = deferred()
  harness.localArea.beforeGet = async () => await startupGate.promise
  await loadBackground(harness, { settle: false })

  const localStatusPromise = harness.sendMessage({ type: 'getStatus' })
  const remoteStatusPromise = harness.sendMessage({ type: 'getRemoteControlStatus' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  startupGate.resolve()

  const [localStatus, remoteStatus] = await Promise.all([localStatusPromise, remoteStatusPromise])
  assert.equal(localStatus.enabled, true)
  assert.equal(remoteStatus.enabled, true)
  assert.equal(remoteStatus.connected, true)
})

test('failed local enable keeps consent but rolls enabled state and reconnect back', async () => {
  const harness = buildChrome({
    local: { localOnboardingPending: true },
    tabs: [{ id: 1, url: 'https://example.com', title: 'Example' }],
  })
  await loadBackground(harness, { fetchImpl: async () => { throw new Error('offline') } })

  const result = await harness.sendMessage({ type: 'enableLocalControl' })
  assert.equal(result.connected, false)
  assert.equal(harness.localArea.data.localControlEnabled, false)
  assert.equal(harness.localArea.data.localConsentVersion, 1)
  assert.ok(harness.localArea.data.localConsentAcceptedAt > 0)
  assert.equal(harness.localArea.data.localOnboardingPending, false)
  const fetchesAfterFailure = harness.calls.fetch.length
  await harness.events.onAlarm.emit({ name: 'relay-keepalive' })
  assert.equal(harness.calls.fetch.length, fetchesAfterFailure)
  assert.deepEqual(harness.calls.attach, [])
})

test('different npm and Store versions connect without reloading when the bridge remains compatible', async () => {
  const harness = buildChrome({ tabs: [{ id: 1, url: 'https://example.com', title: 'Example' }] })
  await loadBackground(harness, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ version: '1.3.0' }),
    }),
  })

  const result = await harness.sendMessage({ type: 'enableLocalControl' })
  assert.equal(result.connected, true)
  assert.equal(harness.calls.reloads, 0)
  assert.equal(harness.calls.webSockets.length, 1)

  const hello = harness.calls.webSockets[0].sent
    .map((value) => JSON.parse(value))
    .find((message) => message.method === 'BrowserRelay.hello')
  assert.equal(hello.params.version, '1.2.1')
  assert.deepEqual(hello.params.protocol, { name: 'browser-relay-bridge', min: 1, max: 1 })
  assert.ok(hello.params.capabilities.includes('cdp'))

  const status = await harness.sendMessage({ type: 'getStatus' })
  assert.equal(status.connected, true)
  assert.equal(status.daemonVersion, '1.3.0')
  assert.equal(status.compatibility.mode, 'legacy')
  assert.equal(status.compatibility.versionMismatch, true)
})

test('an incompatible declared bridge protocol fails closed without opening a socket', async () => {
  const harness = buildChrome({ tabs: [{ id: 1, url: 'https://example.com', title: 'Example' }] })
  await loadBackground(harness, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        version: '9.0.0',
        bridgeProtocol: { name: 'browser-relay-bridge', min: 2, max: 2 },
        capabilities: ['cdp'],
      }),
    }),
  })

  const result = await harness.sendMessage({ type: 'enableLocalControl' })
  assert.equal(result.connected, false)
  assert.match(result.lastError, /No compatible bridge protocol/)
  assert.equal(harness.calls.webSockets.length, 0)
  assert.equal(harness.calls.reloads, 0)
  assert.equal(harness.localArea.data.localControlEnabled, false)
})

test('a superseded Local enable failure cannot close or clear a newer successful enable', async () => {
  const firstFetch = deferred()
  let fetchCount = 0
  const harness = buildChrome({ tabs: [{ id: 1, url: 'https://example.com', title: 'Example' }] })
  await loadBackground(harness, {
    fetchImpl: async () => {
      fetchCount++
      if (fetchCount === 1) return await firstFetch.promise
      return { ok: true, json: async () => ({ version: '1.2.1' }) }
    },
  })

  const older = harness.sendMessage({ type: 'enableLocalControl' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const newer = harness.sendMessage({ type: 'enableLocalControl' })
  const newerResult = await newer
  firstFetch.reject(new Error('older request failed'))
  const olderResult = await older

  assert.equal(newerResult.connected, true)
  assert.equal(olderResult.superseded, true)
  assert.equal(harness.localArea.data.localControlEnabled, true)
  const status = await harness.sendMessage({ type: 'getStatus' })
  assert.equal(status.enabled, true)
  assert.equal(status.connected, true)
})

test('shared debugger sessions survive one mode turning off and detach after both are off', async () => {
  const harness = buildChrome({
    local: {
      ...currentLocalConsent,
      localControlEnabled: true,
      ...currentRemoteConsent,
      remoteControlEnabled: true,
      remoteHost: 'https://relay.linso.ai',
      remoteRouteId: 'route-id',
      remoteSecret: 'secret-value',
      remoteDeviceId: 'br-secret-value',
    },
    session: {
      persistedTabs: [{ tabId: 1, sessionId: 'session-1', targetId: 'target-1', attachOrder: 1 }],
      nextSession: 2,
    },
    tabs: [{ id: 1, url: 'https://example.com', title: 'Example' }],
  })
  await loadBackground(harness)

  harness.calls.detach.length = 0
  await harness.sendMessage({ type: 'disableLocalControl' })
  assert.deepEqual(harness.calls.detach, [])
  assert.ok(harness.sessionArea.data.persistedTabs?.length)

  const remoteDisabled = await harness.sendMessage({ type: 'disableRemoteControl' })
  assert.equal(remoteDisabled.ok, true)
  assert.deepEqual(harness.calls.detach, [1])
  assert.equal(harness.sessionArea.data.persistedTabs, undefined)
})

test('failed remote enable rolls capability and mode back', async () => {
  const harness = buildChrome({ tabs: [{ id: 1, url: 'https://example.com', title: 'Example' }] })
  await loadBackground(harness, { remoteFails: true })

  const result = await harness.sendMessage({
    type: 'enableRemoteControl',
    disclosureConfirmed: true,
    remoteHost: 'https://relay.linso.ai',
    routeId: 'route-id',
    secret: 'secret-value',
    remoteDeviceId: 'br-secret-value',
  })
  assert.equal(result.connected, false)
  assert.equal(harness.localArea.data.remoteControlEnabled, false)
  assert.equal(harness.localArea.data.remoteRouteId, undefined)
  assert.equal(harness.localArea.data.remoteSecret, undefined)
  assert.equal(harness.localArea.data.remoteDeviceId, undefined)
})

test('Remote hello advertises the bridge protocol after first-frame authentication', async () => {
  const harness = buildChrome()
  await loadBackground(harness)

  const result = await harness.sendMessage({
    type: 'enableRemoteControl',
    disclosureConfirmed: true,
    remoteHost: 'https://relay.linso.ai',
    routeId: 'route-id',
    secret: 'secret-value',
    remoteDeviceId: 'br-secret-value',
  })
  assert.equal(result.connected, true)

  const remoteSocket = harness.calls.webSockets.find((socket) => socket.url.includes('/v1/device/connect'))
  const messages = remoteSocket.sent.map((value) => JSON.parse(value))
  assert.equal(messages[0].type, 'device.auth')
  assert.equal(messages[0].secret, 'secret-value')
  const hello = messages.find((message) => message.type === 'device.hello')
  assert.deepEqual(hello.protocol, { name: 'browser-relay-bridge', min: 1, max: 1 })
  assert.ok(hello.capabilities.includes('tabs'))
})

test('failed Remote capability replacement restores the previous capability without Options', async () => {
  const harness = buildChrome({
    local: {
      ...currentRemoteConsent,
      remoteControlEnabled: true,
      remoteHost: 'https://relay.linso.ai',
      remoteRouteId: 'old-route',
      remoteSecret: 'old-secret',
      remoteDeviceId: 'br-old-secret',
    },
  })
  await loadBackground(harness, {
    remoteBehavior: (url) => ({ fail: new URL(url).searchParams.get('routeId') === 'new-route', delay: 0 }),
  })

  const result = await harness.sendMessage({
    type: 'enableRemoteControl',
    disclosureConfirmed: true,
    remoteHost: 'https://relay.linso.ai',
    routeId: 'new-route',
    secret: 'new-secret',
    remoteDeviceId: 'br-new-secret',
  })

  assert.equal(result.connected, false)
  assert.equal(result.restored, true)
  assert.equal(harness.localArea.data.remoteControlEnabled, true)
  assert.equal(harness.localArea.data.remoteRouteId, 'old-route')
  assert.equal(harness.localArea.data.remoteSecret, 'old-secret')
  assert.equal(harness.localArea.data.remoteDeviceId, 'br-old-secret')
  const status = await harness.sendMessage({ type: 'getRemoteControlStatus' })
  assert.equal(status.enabled, true)
  assert.equal(status.connected, true)
})

test('malformed Remote enable requests leave an existing connection and capability untouched', async () => {
  const harness = buildChrome({
    local: {
      ...currentRemoteConsent,
      remoteControlEnabled: true,
      remoteHost: 'https://relay.linso.ai',
      remoteRouteId: 'old-route',
      remoteSecret: 'old-secret',
      remoteDeviceId: 'br-old-secret',
    },
  })
  await loadBackground(harness)
  const socketsBefore = harness.calls.webSockets.length
  const activeSocket = harness.calls.webSockets.at(-1)

  const result = await harness.sendMessage({
    type: 'enableRemoteControl',
    disclosureConfirmed: false,
    remoteHost: 'not a valid host',
  })

  assert.equal(result.connected, false)
  assert.equal(result.restored, true)
  assert.equal(result.restoredConnected, true)
  assert.equal(harness.calls.webSockets.length, socketsBefore)
  assert.equal(activeSocket.readyState, globalThis.WebSocket.OPEN)
  assert.equal(harness.localArea.data.remoteControlEnabled, true)
  assert.equal(harness.localArea.data.remoteRouteId, 'old-route')
  assert.equal(harness.localArea.data.remoteSecret, 'old-secret')
  assert.equal(harness.localArea.data.remoteDeviceId, 'br-old-secret')
})

test('a superseded Remote failure cannot close or clear a newer successful capability', async () => {
  const harness = buildChrome()
  await loadBackground(harness, {
    remoteBehavior: (url) => {
      const routeId = new URL(url).searchParams.get('routeId')
      return routeId === 'older-route' ? { fail: true, delay: 30 } : { fail: false, delay: 0 }
    },
  })

  const older = harness.sendMessage({
    type: 'enableRemoteControl',
    disclosureConfirmed: true,
    remoteHost: 'https://relay.linso.ai',
    routeId: 'older-route',
    secret: 'older-secret',
    remoteDeviceId: 'br-older-secret',
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const newer = harness.sendMessage({
    type: 'enableRemoteControl',
    disclosureConfirmed: true,
    remoteHost: 'https://relay.linso.ai',
    routeId: 'newer-route',
    secret: 'newer-secret',
    remoteDeviceId: 'br-newer-secret',
  })

  const newerResult = await newer
  const olderResult = await older
  assert.equal(newerResult.connected, true)
  assert.equal(olderResult.superseded, true)
  assert.equal(harness.localArea.data.remoteControlEnabled, true)
  assert.equal(harness.localArea.data.remoteRouteId, 'newer-route')
  assert.equal(harness.localArea.data.remoteSecret, 'newer-secret')
  const status = await harness.sendMessage({ type: 'getRemoteControlStatus' })
  assert.equal(status.enabled, true)
  assert.equal(status.connected, true)
})

test('concurrent custom-host cleanup failures merge pending origins without losing either', async () => {
  const originA = 'https://hub-a.example.com/*'
  const originB = 'https://hub-b.example.com/*'
  const harness = buildChrome({
    grantedOrigins: [originA, originB],
    removeOrigins: false,
  })
  await loadBackground(harness, {
    remoteBehavior: (url) => {
      const routeId = new URL(url).searchParams.get('routeId')
      return routeId === 'route-a' ? { fail: true, delay: 30 } : { fail: true, delay: 0 }
    },
  })

  const first = harness.sendMessage({
    type: 'enableRemoteControl',
    disclosureConfirmed: true,
    remoteHost: 'https://hub-a.example.com',
    routeId: 'route-a',
    secret: 'secret-a',
    remoteDeviceId: 'br-secret-a',
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const second = harness.sendMessage({
    type: 'enableRemoteControl',
    disclosureConfirmed: true,
    remoteHost: 'https://hub-b.example.com',
    routeId: 'route-b',
    secret: 'secret-b',
    remoteDeviceId: 'br-secret-b',
  })
  await Promise.all([first, second])

  assert.deepEqual(
    new Set(harness.localArea.data.remoteHostPermissionCleanupOrigins),
    new Set([originA, originB]),
  )
  harness.permissions.removeOrigins = true
  const cleaned = await harness.sendMessage({ type: 'retryRemoteHostPermissionCleanup' })
  assert.equal(cleaned.ok, true)
  assert.equal(harness.localArea.data.remoteHostPermissionCleanupOrigins, undefined)
  assert.equal(harness.permissions.origins.size, 0)
})

test('a granted custom-host permission is durably registered and abandoned grants are cleaned on startup', async () => {
  const eventOrigin = 'https://abandoned.example.com/*'
  const explicitOrigin = 'https://explicit.example.com/*'
  const first = buildChrome({ grantedOrigins: [eventOrigin, explicitOrigin] })
  await loadBackground(first)

  await first.chrome.permissions.onAdded.emit({ origins: [eventOrigin] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const registered = await first.sendMessage({
    type: 'registerRemoteHostPermissionCandidate',
    remoteHost: 'https://explicit.example.com',
  })
  assert.equal(registered.ok, true)
  assert.deepEqual(
    new Set(first.localArea.data.remoteHostPermissionCleanupOrigins),
    new Set([eventOrigin, explicitOrigin]),
  )

  const restarted = buildChrome({
    local: { remoteHostPermissionCleanupOrigins: [eventOrigin, explicitOrigin] },
    grantedOrigins: [eventOrigin, explicitOrigin],
  })
  await loadBackground(restarted)
  assert.equal(restarted.permissions.origins.has(eventOrigin), false)
  assert.equal(restarted.permissions.origins.has(explicitOrigin), false)
  assert.equal(restarted.localArea.data.remoteHostPermissionCleanupOrigins, undefined)
})

test('cleanup keeps an in-flight custom-host candidate pending until durable commit', async () => {
  const origin = 'https://hub.example.com/*'
  const harness = buildChrome({ grantedOrigins: [origin] })
  await loadBackground(harness, {
    remoteBehavior: () => ({ fail: false, delay: 30 }),
  })

  const enabling = harness.sendMessage({
    type: 'enableRemoteControl',
    disclosureConfirmed: true,
    remoteHost: 'https://hub.example.com',
    routeId: 'route-id',
    secret: 'secret-value',
    remoteDeviceId: 'br-secret-value',
  })
  await waitUntil(
    () => harness.localArea.data.remoteHostPermissionCleanupOrigins?.includes(origin),
    'candidate permission should be in the durable cleanup ledger during handshake',
  )

  const duringHandshake = await harness.sendMessage({ type: 'retryRemoteHostPermissionCleanup' })
  assert.equal(duringHandshake.ok, false)
  assert.deepEqual(duringHandshake.pending, [origin])
  assert.equal(harness.permissions.origins.has(origin), true)
  assert.deepEqual(harness.localArea.data.remoteHostPermissionCleanupOrigins, [origin])

  const result = await enabling
  assert.equal(result.connected, true)
  assert.equal(harness.localArea.data.remoteControlEnabled, true)
  assert.equal(harness.localArea.data.remoteHostPermissionCleanupOrigins, undefined)
})

test('Remote rechecks custom-host permission after handshake before committing capability', async () => {
  const origin = 'https://hub.example.com/*'
  const harness = buildChrome({ grantedOrigins: [origin] })
  await loadBackground(harness, {
    remoteBehavior: () => ({ fail: false, delay: 30 }),
  })

  const enabling = harness.sendMessage({
    type: 'enableRemoteControl',
    disclosureConfirmed: true,
    remoteHost: 'https://hub.example.com',
    routeId: 'route-id',
    secret: 'secret-value',
    remoteDeviceId: 'br-secret-value',
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  harness.permissions.origins.delete(origin)
  await harness.chrome.permissions.onRemoved.emit({ origins: [origin] })
  const result = await enabling

  assert.equal(result.connected, false)
  assert.equal(result.superseded, true)
  assert.equal(harness.localArea.data.remoteControlEnabled, false)
  assert.equal(harness.localArea.data.remoteRouteId, undefined)
  assert.equal(harness.localArea.data.remoteSecret, undefined)
  assert.equal(harness.localArea.data.remoteDeviceId, undefined)
  const status = await harness.sendMessage({ type: 'getRemoteControlStatus' })
  assert.match(status.lastError, /candidate Remote Host was removed/i)
})

test('candidate permission removal during storage commit cancels first-time Remote enable', async () => {
  const origin = 'https://hub.example.com/*'
  const harness = buildChrome({ grantedOrigins: [origin] })
  await loadBackground(harness)

  let removedDuringCommit = false
  harness.localArea.beforeSet = async (values) => {
    if (
      removedDuringCommit
      || values.remoteControlEnabled !== true
      || values.remoteRouteId !== 'route-id'
    ) return
    removedDuringCommit = true
    harness.permissions.origins.delete(origin)
    await harness.chrome.permissions.onRemoved.emit({ origins: [origin] })
  }

  const result = await harness.sendMessage({
    type: 'enableRemoteControl',
    disclosureConfirmed: true,
    remoteHost: 'https://hub.example.com',
    routeId: 'route-id',
    secret: 'secret-value',
    remoteDeviceId: 'br-secret-value',
  })
  await waitUntil(
    () => harness.localArea.data.remoteControlEnabled === false,
    'candidate revocation handler should persist Remote disabled after the commit race',
  )

  assert.equal(removedDuringCommit, true)
  assert.equal(result.connected, false)
  assert.equal(result.superseded, true)
  assert.equal(harness.localArea.data.remoteControlEnabled, false)
  assert.equal(harness.localArea.data.remoteRouteId, undefined)
  assert.equal(harness.localArea.data.remoteSecret, undefined)
  assert.equal(harness.localArea.data.remoteDeviceId, undefined)
  assert.equal(harness.localArea.data.remoteHostPermissionCleanupOrigins, undefined)
  assert.ok(harness.calls.webSockets.every((socket) => socket.readyState === globalThis.WebSocket.CLOSED))
  const status = await harness.sendMessage({ type: 'getRemoteControlStatus' })
  assert.equal(status.enabled, false)
  assert.match(status.lastError, /candidate Remote Host was removed/i)
})

test('candidate permission removal during replacement commit restores the previous Remote capability', async () => {
  const origin = 'https://hub.example.com/*'
  const harness = buildChrome({
    local: {
      ...currentRemoteConsent,
      remoteControlEnabled: true,
      remoteHost: 'https://relay.linso.ai',
      remoteRouteId: 'old-route',
      remoteSecret: 'old-secret',
      remoteDeviceId: 'br-old-secret',
    },
    grantedOrigins: [origin],
  })
  await loadBackground(harness)

  let removedDuringCommit = false
  harness.localArea.beforeSet = async (values) => {
    if (
      removedDuringCommit
      || values.remoteControlEnabled !== true
      || values.remoteRouteId !== 'new-route'
    ) return
    removedDuringCommit = true
    harness.permissions.origins.delete(origin)
    await harness.chrome.permissions.onRemoved.emit({ origins: [origin] })
  }

  const result = await harness.sendMessage({
    type: 'enableRemoteControl',
    disclosureConfirmed: true,
    remoteHost: 'https://hub.example.com',
    routeId: 'new-route',
    secret: 'new-secret',
    remoteDeviceId: 'br-new-secret',
  })
  await waitUntil(
    () => harness.localArea.data.remoteRouteId === 'old-route' && harness.localArea.data.remoteControlEnabled === true,
    'candidate revocation handler should restore the previous capability after the commit race',
  )

  assert.equal(removedDuringCommit, true)
  assert.equal(result.connected, false)
  assert.equal(result.superseded, true)
  assert.equal(harness.localArea.data.remoteHost, 'https://relay.linso.ai')
  assert.equal(harness.localArea.data.remoteRouteId, 'old-route')
  assert.equal(harness.localArea.data.remoteSecret, 'old-secret')
  assert.equal(harness.localArea.data.remoteDeviceId, 'br-old-secret')
  assert.equal(harness.localArea.data.remoteHostPermissionCleanupOrigins, undefined)
  const status = await harness.sendMessage({ type: 'getRemoteControlStatus' })
  assert.equal(status.enabled, true)
  assert.equal(status.connected, true)
  assert.equal(status.deviceId, 'br-old-secret')
  assert.match(status.lastError, /previous Remote connection was restored/i)
})

test('removing the active custom-host permission disables Remote and clears its capability', async () => {
  const origin = 'https://hub.example.com/*'
  const harness = buildChrome({
    local: {
      ...currentRemoteConsent,
      remoteControlEnabled: true,
      remoteHost: 'https://hub.example.com',
      remoteOptionalHostOrigin: origin,
      remoteRouteId: 'route-id',
      remoteSecret: 'secret-value',
      remoteDeviceId: 'br-secret-value',
    },
    grantedOrigins: [origin],
  })
  await loadBackground(harness)

  harness.permissions.origins.delete(origin)
  await harness.chrome.permissions.onRemoved.emit({ origins: [origin] })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(harness.localArea.data.remoteControlEnabled, false)
  assert.equal(harness.localArea.data.remoteRouteId, undefined)
  assert.equal(harness.localArea.data.remoteSecret, undefined)
  assert.equal(harness.localArea.data.remoteDeviceId, undefined)
  const status = await harness.sendMessage({ type: 'getRemoteControlStatus' })
  assert.equal(status.enabled, false)
  assert.match(status.lastError, /permission.*removed/i)
})

test('legacy custom-host permission cleanup is verified, persisted, and retryable', async () => {
  const origin = 'https://hub.example.com/*'
  const harness = buildChrome({
    local: {
      remoteControlEnabled: true,
      remoteHost: 'https://hub.example.com',
      remoteRouteId: 'legacy-route',
      remoteSecret: 'legacy-secret',
      remoteDeviceId: 'br-legacy-secret',
    },
    grantedOrigins: [origin],
    removeOrigins: false,
  })
  await loadBackground(harness)

  assert.equal(harness.localArea.data.remoteControlEnabled, false)
  assert.equal(harness.localArea.data.remoteSecret, undefined)
  assert.deepEqual(harness.localArea.data.remoteHostPermissionCleanupOrigins, [origin])
  assert.equal(harness.permissions.origins.has(origin), true)

  const stillPending = await harness.sendMessage({ type: 'retryRemoteHostPermissionCleanup' })
  assert.equal(stillPending.ok, false)
  harness.permissions.removeOrigins = true
  const cleaned = await harness.sendMessage({ type: 'retryRemoteHostPermissionCleanup' })
  assert.equal(cleaned.ok, true)
  assert.equal(harness.permissions.origins.has(origin), false)
  assert.equal(harness.localArea.data.remoteHostPermissionCleanupOrigins, undefined)
})

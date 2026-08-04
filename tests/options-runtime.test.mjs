import test from 'node:test'
import assert from 'node:assert/strict'

class FakeClassList {
  constructor() { this.values = new Set() }
  add(...values) { for (const value of values) this.values.add(value) }
  remove(...values) { for (const value of values) this.values.delete(value) }
  toggle(value, force) {
    if (force === true) this.values.add(value)
    else if (force === false) this.values.delete(value)
    else if (this.values.has(value)) this.values.delete(value)
    else this.values.add(value)
    return this.values.has(value)
  }
  contains(value) { return this.values.has(value) }
}

class FakeElement {
  constructor(id) {
    this.id = id
    this.value = ''
    this.checked = false
    this.disabled = false
    this.textContent = ''
    this.className = ''
    this.classList = new FakeClassList()
    this.listeners = new Map()
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }
  async emit(type) {
    for (const listener of this.listeners.get(type) || []) await listener({ target: this })
  }
}

function storageArea(initial = {}) {
  const data = { ...initial }
  return {
    data,
    async get(keys) {
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {}
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]))
      return { ...data }
    },
    async set(values) { Object.assign(data, values) },
    async remove(keys) { for (const key of (Array.isArray(keys) ? keys : [keys])) delete data[key] },
  }
}

test('fresh install presents Local consent by default without enabling control', async () => {
  const elements = new Map()
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const element = new FakeElement(id)
        if (id === 'localConsent') element.classList.add('hidden')
        elements.set(id, element)
      }
      return elements.get(id)
    },
  }
  globalThis.window = {
    I18N: {
      t: (key) => key,
      setLang: () => {},
      apply: () => {},
    },
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async () => {} } },
  })
  const local = storageArea({ localOnboardingPending: true })
  const messages = []
  globalThis.chrome = {
    storage: { local },
    permissions: {
      contains: async () => false,
      request: async () => false,
      remove: async () => true,
    },
    runtime: {
      sendMessage: async (message) => {
        messages.push(message)
        return { ok: true }
      },
    },
  }

  await import(`../extension/options.js?options-runtime-onboarding=${Date.now()}`)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(elements.get('localToggle').checked, false)
  assert.equal(elements.get('localState').textContent, 'stateOff')
  assert.equal(elements.get('localConsent').classList.contains('hidden'), false)
  assert.equal(elements.get('localConsentCheck').checked, false)
  assert.equal(elements.get('status').textContent, 'statusReviewLocalConsent')
  assert.equal(messages.some((message) => message.type === 'enableLocalControl'), false)

  await elements.get('localConsentCancel').emit('click')
  assert.equal(elements.get('localConsent').classList.contains('hidden'), true)
  assert.equal(local.data.localOnboardingPending, false)
})

test('Options keeps Local visibly off when the daemon connection fails', async () => {
  const elements = new Map()
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id))
      return elements.get(id)
    },
  }
  globalThis.window = {
    I18N: {
      t: (key) => key,
      setLang: () => {},
      apply: () => {},
    },
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async () => {} } },
  })
  const local = storageArea()
  const fetchCalls = []
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options })
    return { ok: true, status: 200, json: async () => ({ ok: true, version: '1.2.1' }) }
  }
  globalThis.chrome = {
    storage: { local },
    permissions: {
      contains: async () => false,
      request: async () => false,
      remove: async () => true,
    },
    runtime: {
      sendMessage: async (message) => {
        if (message.type === 'enableLocalControl') return { connected: false, lastError: 'daemon offline' }
        return { ok: true }
      },
    },
  }

  await import(`../extension/options.js?options-runtime=${Date.now()}`)
  await new Promise((resolve) => setTimeout(resolve, 0))

  const consent = elements.get('localConsentCheck')
  const apply = elements.get('localConsentApply')
  consent.checked = true
  await apply.emit('click')

  assert.equal(elements.get('localToggle').checked, false)
  assert.equal(elements.get('localState').textContent, 'stateOff')
  assert.match(elements.get('status').className, /err/)
  assert.match(elements.get('status').textContent, /daemon offline/)
  assert.equal(fetchCalls[0].url, 'http://127.0.0.1:18795/api/debug')
  assert.equal(fetchCalls[0].options.targetAddressSpace, undefined)
})

test('Options does not enable Local when Chrome denies loopback network access', async () => {
  const elements = new Map()
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id))
      return elements.get(id)
    },
  }
  globalThis.window = {
    I18N: {
      t: (key) => key,
      setLang: () => {},
      apply: () => {},
    },
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async () => {} } },
  })
  globalThis.fetch = async () => { throw new DOMException('Permission denied', 'NotAllowedError') }
  const local = storageArea()
  let enableCalls = 0
  globalThis.chrome = {
    storage: { local },
    permissions: {
      contains: async () => false,
      request: async () => false,
      remove: async () => true,
    },
    runtime: {
      sendMessage: async (message) => {
        if (message.type === 'enableLocalControl') enableCalls++
        return { ok: true }
      },
    },
  }

  await import(`../extension/options.js?options-runtime-lna=${Date.now()}`)
  await new Promise((resolve) => setTimeout(resolve, 0))
  elements.get('localConsentCheck').checked = true
  await elements.get('localConsentApply').emit('click')

  assert.equal(enableCalls, 0)
  assert.equal(elements.get('localToggle').checked, false)
  assert.match(elements.get('status').className, /err/)
  assert.match(elements.get('status').textContent, /statusLoopbackDenied/)
})

test('Options durably registers a granted custom Host before sending Remote capability', async () => {
  const elements = new Map()
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id))
      return elements.get(id)
    },
  }
  globalThis.window = {
    I18N: {
      t: (key) => key,
      setLang: () => {},
      apply: () => {},
    },
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async () => {} } },
  })
  const local = storageArea()
  const events = []
  globalThis.chrome = {
    storage: { local },
    permissions: {
      contains: async () => false,
      request: async ({ origins }) => { events.push(`request:${origins[0]}`); return true },
      remove: async () => true,
    },
    runtime: {
      sendMessage: async (message) => {
        events.push(message.type)
        if (message.type === 'registerRemoteHostPermissionCandidate') return { ok: true }
        if (message.type === 'enableRemoteControl') return { connected: false, lastError: 'hub offline' }
        return { ok: true }
      },
    },
  }

  await import(`../extension/options.js?options-runtime-remote=${Date.now()}`)
  await new Promise((resolve) => setTimeout(resolve, 0))
  elements.get('remoteHost').value = 'https://hub.example.com'
  elements.get('remoteDisclosureCheck').checked = true
  await elements.get('remoteDisclosureApply').emit('click')

  assert.deepEqual(events.slice(0, 3), [
    'request:https://hub.example.com/*',
    'registerRemoteHostPermissionCandidate',
    'enableRemoteControl',
  ])
})

test('Options explains compatible npm and Store version drift instead of asking for a reload', async () => {
  const elements = new Map()
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id))
      return elements.get(id)
    },
  }
  globalThis.window = {
    I18N: {
      t: (key) => key === 'statusConnectedLocalVersionMismatch'
        ? 'extension {extensionVersion}; daemon {daemonVersion}; protocol {protocolVersion} compatible'
        : key,
      setLang: () => {},
      apply: () => {},
    },
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async () => {} } },
  })
  const local = storageArea({
    localControlEnabled: true,
    localConsentVersion: 1,
    localConsentAcceptedAt: 1,
  })
  globalThis.chrome = {
    storage: { local },
    permissions: {
      contains: async () => false,
      request: async () => false,
      remove: async () => true,
    },
    runtime: {
      sendMessage: async (message) => {
        if (message.type === 'getStatus') {
          return {
            enabled: true,
            connected: true,
            version: '1.2.1',
            daemonVersion: '1.3.0',
            compatibility: { compatible: true, versionMismatch: true, selected: 1 },
          }
        }
        return { ok: true }
      },
    },
  }

  await import(`../extension/options.js?options-runtime-compat=${Date.now()}`)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(
    elements.get('status').textContent,
    'extension 1.2.1; daemon 1.3.0; protocol 1 compatible',
  )
  assert.match(elements.get('status').className, /ok/)
})

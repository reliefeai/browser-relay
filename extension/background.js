// Browser Relay Extension — Universal CDP agent bridge
// Core logic adapted from openclaw auto-attach fork, stripped of gateway handshake

import { SNAPSHOT_JS } from './snapshot.js'
import { buildWaitExpression, normalizeWaitOptions } from './wait.js'
import { createRemoteAuthMessageHandler } from './remote-auth.js'
import {
  LOCAL_CONSENT_VERSION,
  REMOTE_DISCLOSURE_VERSION,
  REMOTE_CAPABILITY_KEYS,
  buildConsentMigration,
  hasRemoteCapability,
  hasCurrentRemoteDisclosure,
} from './consent.js'
import { DEFAULT_REMOTE_HOST, remoteHostConfig, remoteWsBase } from './remote-host.js'
import {
  BRIDGE_BASE_CAPABILITIES,
  BRIDGE_PROTOCOL,
  bridgeCompatibility,
} from './protocol.js'

const DEFAULT_PORT = 18795
// Soft-detach a tab's debugger after this many idle seconds so Chrome's
// "started debugging this browser" infobar disappears while inactive.
// 0 disables it (debugger stays attached, infobar always shown).
// Default 10 min: short enough to hide the bar when genuinely idle, long
// enough that it won't recycle a tab an agent is still working with.
const DEFAULT_IDLE_DETACH_SECONDS = 600
const IDLE_DETACH_DEFAULT_MIGRATION_KEY = 'idleDetachDefaultMigratedTo600'

const BADGE = {
  on: { text: 'ON', color: '#22c55e' },
  off: { text: '', color: '#000000' },
  connecting: { text: '...', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
  idle: { text: '·', color: '#6B7280' },
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const TITLE_FRAMES = ['🔵', '⚪']

// Prepend an animated frame to the page title (visible in the tab strip), or
// strip it when frame is null. Stateless: every call strips any existing frame
// first, so page-driven title changes are picked up automatically.
function setTabTitleFrame(tabId, frame) {
  const expr = `(() => {
    let t = document.title
    for (const f of ${JSON.stringify(TITLE_FRAMES)}) {
      if (t.startsWith(f + ' ')) { t = t.slice(f.length + 1); break }
    }
    document.title = ${frame ? `${JSON.stringify(frame + ' ')} + t` : 't'}
  })()`
  return chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: expr, returnByValue: true }).catch(() => {})
}

/** @type {Map<number, {interval: ReturnType<typeof setInterval>, timeout: ReturnType<typeof setTimeout>}>} */
const tabActivity = new Map()

function markTabActivity(tabId) {
  const existing = tabActivity.get(tabId)
  if (existing) {
    clearTimeout(existing.timeout)
    existing.timeout = setTimeout(() => clearTabActivity(tabId), 2000)
    return
  }
  let tick = 0
  void setTabTitleFrame(tabId, TITLE_FRAMES[0])
  const interval = setInterval(() => {
    tick++
    void chrome.action.setBadgeText({ tabId, text: SPINNER_FRAMES[tick % SPINNER_FRAMES.length] })
    void chrome.action.setBadgeBackgroundColor({ tabId, color: '#3B82F6' })
    void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
    // Tab-strip blink: flip the title prefix every 500ms
    if (tick % 5 === 0) void setTabTitleFrame(tabId, TITLE_FRAMES[(tick / 5) % TITLE_FRAMES.length])
  }, 100)
  const timeout = setTimeout(() => clearTabActivity(tabId), 2000)
  tabActivity.set(tabId, { interval, timeout })
}

function clearTabActivity(tabId) {
  const anim = tabActivity.get(tabId)
  if (!anim) return
  clearInterval(anim.interval)
  clearTimeout(anim.timeout)
  tabActivity.delete(tabId)
  void setTabTitleFrame(tabId, null)
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected' && !tab.idle) {
    setBadge(tabId, (relayWs?.readyState === WebSocket.OPEN || remoteConnected()) ? 'on' : 'connecting')
  }
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
let relayConnectCancel = null
/** @type {WebSocket|null} */
let remoteWs = null
/** @type {Promise<void>|null} */
let remoteConnectPromise = null
let remoteConnectCancel = null
let remoteReconnectTimer = null
let remoteConfig = null
let remoteConnectedAt = null
let remoteLastError = null
let nextSession = 1

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number, idle?:boolean, lastActivity?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()
const PUBLIC_TAB_ID_PATTERN = /^t_[A-Za-z0-9_-]{10}$/
const PUBLIC_TAB_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
/** @type {Map<number, string>} */
const publicTabIds = new Map()
/** IDs already issued in this browser session are never reused. */
const issuedPublicTabIds = new Set()

function createPublicTabId() {
  let id
  do {
    const random = crypto.getRandomValues(new Uint8Array(10))
    let token = ''
    for (const byte of random) token += PUBLIC_TAB_ID_ALPHABET[byte & 63]
    id = `t_${token}`
  } while (issuedPublicTabIds.has(id))
  issuedPublicTabIds.add(id)
  return id
}

function publicTabIdFor(chromeTabId) {
  let id = publicTabIds.get(chromeTabId)
  if (!id) {
    id = createPublicTabId()
    publicTabIds.set(chromeTabId, id)
  }
  return id
}

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

const tabOperationLocks = new Set()
const reattachPending = new Set()
// Tabs we are deliberately detaching for idleness — guards onDebuggerDetach
// from treating the self-initiated detach as a navigation/teardown event.
const idleDetaching = new Set()

let reconnectAttempt = 0
let reconnectTimer = null
let lastConnectError = null
let localBridgeCompatibility = null
let localControlEnabled = false
let remoteControlEnabled = false
let localConnectionGeneration = 0
let remoteConnectionGeneration = 0
let localControlOperationGeneration = 0
let remoteControlOperationGeneration = 0
let remoteControlCandidateOrigin = null
let remoteCandidateOperation = 0
let remoteCandidatePreviousState = null
let localStateMutation = Promise.resolve()
let remoteStateMutation = Promise.resolve()
let remotePermissionMutation = Promise.resolve()

function anyControlModeEnabled() {
  return localControlEnabled || remoteControlEnabled
}

function serializeMutation(queueName, fn) {
  const previous = queueName === 'local'
    ? localStateMutation
    : queueName === 'remote'
      ? remoteStateMutation
      : remotePermissionMutation
  const current = previous.then(fn, fn)
  const settled = current.then(() => undefined, () => undefined)
  if (queueName === 'local') localStateMutation = settled
  else if (queueName === 'remote') remoteStateMutation = settled
  else remotePermissionMutation = settled
  return current
}

async function getRelayPort() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const n = Number.parseInt(String(stored.relayPort || ''), 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

async function getIdleDetachMs() {
  const stored = await chrome.storage.local.get(['idleDetachSeconds', IDLE_DETACH_DEFAULT_MIGRATION_KEY])
  const raw = stored.idleDetachSeconds
  if (raw === undefined || raw === null || raw === '') return DEFAULT_IDLE_DETACH_SECONDS * 1000
  const n = Number.parseInt(String(raw), 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_DETACH_SECONDS * 1000

  if (n === 30 && !stored[IDLE_DETACH_DEFAULT_MIGRATION_KEY]) {
    await chrome.storage.local.set({
      idleDetachSeconds: DEFAULT_IDLE_DETACH_SECONDS,
      [IDLE_DETACH_DEFAULT_MIGRATION_KEY]: true,
    })
    return DEFAULT_IDLE_DETACH_SECONDS * 1000
  }

  return n * 1000 // 0 => idle-detach disabled
}

const CONSENT_STORAGE_KEYS = [
  'localControlEnabled',
  'localConsentVersion',
  'localConsentAcceptedAt',
  'localMigrationPending',
  'localOnboardingPending',
  'remoteControlEnabled',
  'remoteDisclosureVersion',
  'remoteDisclosureAcceptedAt',
  'remoteMigrationPending',
  'remoteHost',
  'remoteOptionalHostOrigin',
  'remoteHostPermissionCleanupOrigins',
  ...REMOTE_CAPABILITY_KEYS,
]

async function hasRemoteHostAccess(host) {
  const config = remoteHostConfig(host)
  if (!config.requiresOptionalHostPermission) return true
  return await chrome.permissions.contains({ origins: [config.permissionOrigin] })
}

function optionalRemoteHostOrigin(host) {
  try {
    const config = remoteHostConfig(host || DEFAULT_REMOTE_HOST)
    return config.requiresOptionalHostPermission ? config.permissionOrigin : null
  } catch {
    return null
  }
}

function isCustomRemotePermissionOrigin(origin) {
  try {
    const url = new URL(String(origin || '').replace(/\*$/, ''))
    return url.protocol === 'https:'
      && !['relay.linso.ai', 'localhost', '127.0.0.1'].includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

async function cleanupRemoteHostPermissions(origins = [], { activeOrigin = null, candidateOrigin = null } = {}) {
  return await serializeMutation('permission', async () => {
    const stored = await chrome.storage.local.get(['remoteHostPermissionCleanupOrigins'])
    const pending = new Set([
      ...(Array.isArray(stored.remoteHostPermissionCleanupOrigins) ? stored.remoteHostPermissionCleanupOrigins : []),
      ...origins,
    ].filter(Boolean))
    const errors = []
    const protectedValue = typeof activeOrigin === 'function' ? await activeOrigin() : activeOrigin
    const activeOrigins = new Set(
      protectedValue instanceof Set
        ? protectedValue
        : Array.isArray(protectedValue)
          ? protectedValue
          : [protectedValue].filter(Boolean),
    )
    const candidateValue = typeof candidateOrigin === 'function' ? await candidateOrigin() : candidateOrigin
    const candidateOrigins = new Set(
      candidateValue instanceof Set
        ? candidateValue
        : Array.isArray(candidateValue)
          ? candidateValue
          : [candidateValue].filter(Boolean),
    )

    for (const origin of [...pending]) {
      // A candidate is not durable yet: keep it pending so a worker restart can
      // clean it. A committed active origin is durable elsewhere, so it can be
      // removed from the pending ledger without revoking the permission.
      if (candidateOrigins.has(origin)) continue
      if (activeOrigins.has(origin)) {
        pending.delete(origin)
        continue
      }
      try {
        await chrome.permissions.remove({ origins: [origin] })
        const stillGranted = await chrome.permissions.contains({ origins: [origin] })
        if (stillGranted) throw new Error(`Chrome kept the optional permission for ${origin}`)
        pending.delete(origin)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }

    if (pending.size) {
      await chrome.storage.local.set({ remoteHostPermissionCleanupOrigins: [...pending] })
    } else {
      await chrome.storage.local.remove(['remoteHostPermissionCleanupOrigins'])
    }
    return { ok: pending.size === 0, pending: [...pending], errors }
  })
}

async function clearRemoteHostPermissionCandidates(origins = []) {
  return await serializeMutation('permission', async () => {
    const stored = await chrome.storage.local.get(['remoteHostPermissionCleanupOrigins'])
    const pending = new Set(
      Array.isArray(stored.remoteHostPermissionCleanupOrigins)
        ? stored.remoteHostPermissionCleanupOrigins
        : [],
    )
    for (const origin of origins.filter(Boolean)) pending.delete(origin)
    if (pending.size) await chrome.storage.local.set({ remoteHostPermissionCleanupOrigins: [...pending] })
    else await chrome.storage.local.remove(['remoteHostPermissionCleanupOrigins'])
    return [...pending]
  })
}

async function registerRemoteHostPermissionCandidates(origins = []) {
  return await serializeMutation('permission', async () => {
    const stored = await chrome.storage.local.get([
      'remoteControlEnabled',
      'remoteOptionalHostOrigin',
      'remoteHost',
      'remoteHostPermissionCleanupOrigins',
    ])
    const activeOrigin = stored.remoteControlEnabled
      ? (stored.remoteOptionalHostOrigin || optionalRemoteHostOrigin(stored.remoteHost))
      : null
    const pending = new Set(
      Array.isArray(stored.remoteHostPermissionCleanupOrigins)
        ? stored.remoteHostPermissionCleanupOrigins
        : [],
    )
    for (const origin of origins.filter(isCustomRemotePermissionOrigin)) {
      if (origin !== activeOrigin) pending.add(origin)
    }
    if (pending.size) await chrome.storage.local.set({ remoteHostPermissionCleanupOrigins: [...pending] })
    else await chrome.storage.local.remove(['remoteHostPermissionCleanupOrigins'])
    return [...pending]
  })
}

async function enforceConsentState(reason = 'startup') {
  const stored = await chrome.storage.local.get(CONSENT_STORAGE_KEYS)
  const plan = buildConsentMigration(stored, { reason })
  const previousOptionalOrigin = stored.remoteOptionalHostOrigin
    || optionalRemoteHostOrigin(stored.remoteHost)

  if (Object.keys(plan.updates).length) await chrome.storage.local.set(plan.updates)
  if (plan.remove.length) await chrome.storage.local.remove(plan.remove)

  if (!plan.remoteDisclosureCurrent && previousOptionalOrigin) {
    await chrome.storage.local.remove(['remoteOptionalHostOrigin'])
    await cleanupRemoteHostPermissions([previousOptionalOrigin])
  }

  let remoteEnabled = plan.remoteEnabled
  if (remoteEnabled) {
    try {
      if (!await hasRemoteHostAccess(stored.remoteHost || DEFAULT_REMOTE_HOST)) {
        throw new Error('The optional permission for this Remote Host was removed.')
      }
    } catch (error) {
      remoteEnabled = false
      remoteLastError = error instanceof Error ? error.message : String(error)
      await chrome.storage.local.set({ remoteControlEnabled: false })
      await chrome.storage.local.remove(REMOTE_CAPABILITY_KEYS)
      if (previousOptionalOrigin) {
        await chrome.storage.local.remove(['remoteOptionalHostOrigin'])
        await cleanupRemoteHostPermissions([previousOptionalOrigin])
      }
    }
  }

  let activeOrigin = null
  if (remoteEnabled) {
    activeOrigin = optionalRemoteHostOrigin(stored.remoteHost)
    if (activeOrigin) await chrome.storage.local.set({ remoteOptionalHostOrigin: activeOrigin })
    else await chrome.storage.local.remove(['remoteOptionalHostOrigin'])
  }
  await cleanupRemoteHostPermissions([], { activeOrigin })

  localControlEnabled = plan.localEnabled
  remoteControlEnabled = remoteEnabled
  return { ...plan, remoteEnabled }
}

async function discardPersistedTabSessions() {
  let entries = []
  try {
    const stored = await chrome.storage.session.get(['persistedTabs'])
    entries = Array.isArray(stored.persistedTabs) ? stored.persistedTabs : []
  } catch { /* storage.session may be unavailable */ }

  for (const entry of entries) {
    if (!Number.isInteger(entry?.tabId)) continue
    try { await chrome.debugger.detach({ tabId: entry.tabId }) } catch { /* already detached */ }
    setBadge(entry.tabId, 'off')
    void chrome.action.setTitle({ tabId: entry.tabId, title: 'Browser Relay: permission required' })
  }
  try { await chrome.storage.session.remove(['persistedTabs', 'nextSession']) } catch { /* ignore */ }
}

async function initializeExtensionState() {
  const consent = await enforceConsentState('startup')
  if (consent.localEnabled || consent.remoteEnabled) await rehydrateState()
  else await discardPersistedTabSessions()
  await refreshDownloadEventListeners()
  return consent
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

async function persistState() {
  try {
    const entries = []
    for (const [tabId, tab] of tabs.entries()) {
      if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
        entries.push({ tabId, sessionId: tab.sessionId, targetId: tab.targetId, attachOrder: tab.attachOrder, idle: !!tab.idle })
      }
    }
    await chrome.storage.session.set({
      persistedTabs: entries,
      persistedPublicTabIds: [...publicTabIds.entries()],
      issuedPublicTabIds: [...issuedPublicTabIds],
      nextSession,
    })
  } catch {
    // chrome.storage.session may not be available in all contexts
  }
}

async function rehydrateState() {
  try {
    const stored = await chrome.storage.session.get(['persistedTabs', 'persistedPublicTabIds', 'issuedPublicTabIds', 'nextSession'])
    if (stored.nextSession) nextSession = Math.max(nextSession, stored.nextSession)
    for (const id of Array.isArray(stored.issuedPublicTabIds) ? stored.issuedPublicTabIds : []) {
      if (PUBLIC_TAB_ID_PATTERN.test(id)) issuedPublicTabIds.add(id)
    }
    const restoredIds = new Set()
    for (const pair of Array.isArray(stored.persistedPublicTabIds) ? stored.persistedPublicTabIds : []) {
      if (!Array.isArray(pair) || pair.length !== 2) continue
      const chromeTabId = Number(pair[0])
      const id = pair[1]
      if (!Number.isInteger(chromeTabId) || !PUBLIC_TAB_ID_PATTERN.test(id) || publicTabIds.has(chromeTabId) || restoredIds.has(id)) continue
      publicTabIds.set(chromeTabId, id)
      issuedPublicTabIds.add(id)
      restoredIds.add(id)
    }
    const entries = stored.persistedTabs || []
    for (const entry of entries) {
      publicTabIdFor(entry.tabId)
      tabs.set(entry.tabId, { state: 'connected', sessionId: entry.sessionId, targetId: entry.targetId, attachOrder: entry.attachOrder, idle: !!entry.idle, lastActivity: Date.now() })
      tabBySession.set(entry.sessionId, entry.tabId)
      setBadge(entry.tabId, entry.idle ? 'idle' : 'on')
    }
    for (const entry of entries) {
      try {
        await chrome.tabs.get(entry.tabId)
        // Idle tabs are intentionally detached — don't probe (it would fail
        // and wrongly evict them); they re-attach on the next command.
        if (!entry.idle) {
          await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Runtime.evaluate', { expression: '1', returnByValue: true })
        }
      } catch {
        tabs.delete(entry.tabId)
        tabBySession.delete(entry.sessionId)
        publicTabIds.delete(entry.tabId)
        setBadge(entry.tabId, 'off')
      }
    }
    for (const chromeTabId of publicTabIds.keys()) {
      try { await chrome.tabs.get(chromeTabId) } catch { publicTabIds.delete(chromeTabId) }
    }
  } catch {
    // Ignore rehydration errors
  }
}

async function ensureRelayConnection() {
  if (!localControlEnabled) throw new Error('Local control requires explicit consent in Browser Relay Options')
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  const generation = localConnectionGeneration
  const connectPromise = (async () => {
    const port = await getRelayPort()
    const httpBase = `http://127.0.0.1:${port}`
    const wsUrl = `ws://127.0.0.1:${port}/extension`

    let relayInfo = null
    try {
      const res = await fetch(`${httpBase}/api/debug`, { signal: AbortSignal.timeout(2000) })
      relayInfo = await res.json().catch(() => null)
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase}`)
    }
    if (!localControlEnabled || generation !== localConnectionGeneration) {
      throw new Error('Local control was disabled during connection')
    }

    const myVersion = chrome.runtime.getManifest().version
    localBridgeCompatibility = bridgeCompatibility({
      localVersion: myVersion,
      peerVersion: relayInfo?.version,
      peerProtocol: relayInfo?.bridgeProtocol,
      peerCapabilities: relayInfo?.capabilities,
    })
    if (!localBridgeCompatibility.compatible) {
      throw new Error(localBridgeCompatibility.reason || 'The local daemon uses an incompatible Browser Relay bridge protocol.')
    }

    const hello = {
      method: 'BrowserRelay.hello',
      params: {
        version: myVersion,
        protocol: BRIDGE_PROTOCOL,
        capabilities: [
          ...BRIDGE_BASE_CAPABILITIES,
          ...(await hasDownloadsPermission() ? ['downloads'] : []),
        ],
      },
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws

    ws.onmessage = (event) => {
      if (ws !== relayWs) return
      void whenReady(() => onRelayMessage(String(event.data || '')))
    }

    let cancelPending = null
    try {
      await new Promise((resolve, reject) => {
        let settled = false
        const finish = (fn, value) => {
          if (settled) return
          settled = true
          clearTimeout(t)
          fn(value)
        }
        const t = setTimeout(() => finish(reject, new Error('WebSocket connect timeout')), 5000)
        cancelPending = (error) => finish(reject, error)
        relayConnectCancel = cancelPending
        ws.onopen = () => {
          try {
            ws.send(JSON.stringify(hello))
            finish(resolve)
          } catch (error) {
            finish(reject, error instanceof Error ? error : new Error(String(error)))
          }
        }
        ws.onerror = () => finish(reject, new Error('WebSocket connect failed'))
        ws.onclose = (ev) => finish(reject, new Error(`WebSocket closed (${ev.code})`))
      })
    } finally {
      if (relayConnectCancel === cancelPending) relayConnectCancel = null
    }

    if (!localControlEnabled || generation !== localConnectionGeneration) {
      try { ws.close() } catch { /* ignore */ }
      throw new Error('Local control was disabled during connection')
    }

    ws.onclose = () => { if (ws !== relayWs) return; onRelayClosed('closed') }
    ws.onerror = () => { if (ws !== relayWs) return; onRelayClosed('error') }
  })()
  relayConnectPromise = connectPromise

  try {
    await connectPromise
    reconnectAttempt = 0
    lastConnectError = null
  } catch (err) {
    lastConnectError = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    if (relayConnectPromise === connectPromise) relayConnectPromise = null
  }
}

function onRelayClosed(reason) {
  relayWs = null

  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }
  reattachPending.clear()

  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected' && !tab.idle) {
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({ tabId, title: 'Browser Relay: reconnecting...' })
    }
  }
  if (localControlEnabled) scheduleReconnect()
}

function scheduleReconnect() {
  if (!localControlEnabled) return
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000)
  reconnectAttempt++
  console.log(`Scheduling reconnect attempt ${reconnectAttempt} in ${delay}ms`)
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    try {
      await ensureRelayConnection()
      reconnectAttempt = 0
      console.log('Reconnected successfully')
      await recoverRelaySession()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`Reconnect attempt ${reconnectAttempt} failed: ${message}`)
      if (message.includes('not reachable')) {
        scheduleReconnect()
      }
    }
  }, delay)
}

function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempt = 0
}

function closeLocalRelay() {
  localConnectionGeneration++
  cancelReconnect()
  const cancelConnect = relayConnectCancel
  relayConnectCancel = null
  if (cancelConnect) cancelConnect(new Error('Local control changed during connection'))
  const ws = relayWs
  relayWs = null
  relayConnectPromise = null
  if (ws) {
    try { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.close() } catch { /* ignore */ }
  }
  for (const [id, pendingRequest] of pending.entries()) {
    pending.delete(id)
    pendingRequest.reject(new Error('Local control was disabled'))
  }
  reattachPending.clear()
}

async function announceLocalBridge() {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify({
    method: 'BrowserRelay.hello',
    params: {
      version: chrome.runtime.getManifest().version,
      protocol: BRIDGE_PROTOCOL,
      capabilities: [
        ...BRIDGE_BASE_CAPABILITIES,
        ...(await hasDownloadsPermission() ? ['downloads'] : []),
      ],
    },
  }))
  return true
}

async function detachAllControlledTabs(reason) {
  for (const tabId of [...tabs.keys()]) await detachTab(tabId, reason)
  tabs.clear()
  tabBySession.clear()
  childSessionToTab.clear()
  consoleEntries = []
  networkEntries = []
  consoleCaptureTabs.clear()
  networkCaptureTabs.clear()
  try { await chrome.storage.session.remove(['persistedTabs', 'nextSession']) } catch { /* ignore */ }
}

async function enableLocalControl() {
  const operation = ++localControlOperationGeneration
  const now = Date.now()
  closeLocalRelay()
  localControlEnabled = true
  try {
    const started = await serializeMutation('local', async () => {
      if (operation !== localControlOperationGeneration) return false
      await chrome.storage.local.set({
        localControlEnabled: false,
        localConsentVersion: LOCAL_CONSENT_VERSION,
        localConsentAcceptedAt: now,
        localMigrationPending: false,
        localOnboardingPending: false,
      })
      return operation === localControlOperationGeneration
    })
    if (!started) return { connected: false, superseded: true, lastError: 'A newer Local control request replaced this one.' }
    await ensureRelayConnection()
    if (operation !== localControlOperationGeneration) {
      return { connected: false, superseded: true, lastError: 'A newer Local control request replaced this one.' }
    }
    await recoverRelaySession()
    const committed = await serializeMutation('local', async () => {
      if (operation !== localControlOperationGeneration) return false
      await chrome.storage.local.set({ localControlEnabled: true })
      return operation === localControlOperationGeneration
    })
    if (!committed) return { connected: false, superseded: true, lastError: 'A newer Local control request replaced this one.' }
    return { connected: true, lastError: null }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (operation !== localControlOperationGeneration) {
      return { connected: false, superseded: true, lastError: errorMessage }
    }
    localControlEnabled = false
    closeLocalRelay()
    try {
      await serializeMutation('local', async () => {
        if (operation === localControlOperationGeneration) {
          await chrome.storage.local.set({ localControlEnabled: false })
        }
      })
    } catch { /* keep runtime disabled */ }
    if (operation !== localControlOperationGeneration) {
      return { connected: false, superseded: true, lastError: errorMessage }
    }
    if (!anyControlModeEnabled()) await detachAllControlledTabs('local_enable_failed')
    lastConnectError = errorMessage
    return { connected: false, lastError: errorMessage }
  }
}

async function disableLocalControl({ migrationPending = false } = {}) {
  const operation = ++localControlOperationGeneration
  localControlEnabled = false
  closeLocalRelay()
  await serializeMutation('local', async () => {
    if (operation === localControlOperationGeneration) {
      await chrome.storage.local.set({ localControlEnabled: false, localMigrationPending: migrationPending })
    }
  })
  if (operation !== localControlOperationGeneration) return { superseded: true }
  if (!anyControlModeEnabled()) await detachAllControlledTabs('local_control_disabled')
  lastConnectError = null
  return { superseded: false }
}

async function reannounceAttachedTabs() {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== 'connected' || !tab.sessionId || !tab.targetId) continue
    if (tab.idle) {
      // Wake briefly so the upstream relay learns this session still exists;
      // the next idle sweep will soft-detach it again.
      try { await wakeTab(tabId) } catch { /* fall through to probe/evict */ }
    }
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1', returnByValue: true })
    } catch {
      tabs.delete(tabId)
      if (tab.sessionId) tabBySession.delete(tab.sessionId)
      setBadge(tabId, 'off')
      void chrome.action.setTitle({ tabId, title: 'Browser Relay' })
      continue
    }
    try {
      const info = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
      sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.attachedToTarget', params: { sessionId: tab.sessionId, tabId: publicTabIdFor(tabId), targetInfo: { ...info?.targetInfo, attached: true }, waitingForDebugger: false } } })
      setBadge(tabId, 'on')
      void chrome.action.setTitle({ tabId, title: 'Browser Relay: attached (click to detach)' })
    } catch { setBadge(tabId, 'on') }
  }
  await persistState()
}

async function recoverRelaySession() {
  // The relay drops all session state when a new extension socket connects —
  // re-announce existing tabs or they vanish from the relay's tab list.
  await reannounceAttachedTabs()
  await autoAttachAllTabs()
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Relay not connected')
  ws.send(JSON.stringify(payload))
}

function requestFromRelay(command) {
  const id = command.id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Relay request timeout (30s)')) }, 30000)
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    try { sendToRelay(command) }
    catch (err) { clearTimeout(timer); pending.delete(id); reject(err instanceof Error ? err : new Error(String(err))) }
  })
}

const DOWNLOAD_CONFLICT_ACTIONS = new Set(['uniquify', 'overwrite', 'prompt'])
const DOWNLOADS_PERMISSION_ERROR = 'downloads_permission_required: Enable Downloads access in Browser Relay Options.'
const MAX_DOWNLOAD_EVENTS = 500
let downloadListenersRegistered = false
let registeredDownloadApi = null
let downloadEvents = []

function recordDownloadEvent(type, data) {
  downloadEvents.push({ type, timestamp: Date.now(), ...data })
  if (downloadEvents.length > MAX_DOWNLOAD_EVENTS) downloadEvents = downloadEvents.slice(-MAX_DOWNLOAD_EVENTS)
}

const onDownloadCreated = (item) => void whenReady(() => {
  recordDownloadEvent('created', { item })
  forwardDownloadEvent('BrowserRelay.downloadCreated', { item })
})
const onDownloadChanged = (delta) => void whenReady(() => {
  recordDownloadEvent('changed', { delta })
  forwardDownloadEvent('BrowserRelay.downloadChanged', { delta })
})
const onDownloadErased = (downloadId) => void whenReady(() => {
  recordDownloadEvent('erased', { id: downloadId })
  forwardDownloadEvent('BrowserRelay.downloadErased', { id: downloadId })
})

async function hasDownloadsPermission() {
  return await chrome.permissions.contains({ permissions: ['downloads'] })
}

async function refreshDownloadEventListeners() {
  const granted = await hasDownloadsPermission()
  const api = chrome.downloads
  if (granted && api && !downloadListenersRegistered) {
    api.onCreated.addListener(onDownloadCreated)
    api.onChanged.addListener(onDownloadChanged)
    api.onErased.addListener(onDownloadErased)
    downloadListenersRegistered = true
    registeredDownloadApi = api
  } else if ((!granted || !api) && downloadListenersRegistered) {
    const previousApi = registeredDownloadApi || api
    previousApi?.onCreated.removeListener(onDownloadCreated)
    previousApi?.onChanged.removeListener(onDownloadChanged)
    previousApi?.onErased.removeListener(onDownloadErased)
    downloadListenersRegistered = false
    registeredDownloadApi = null
    downloadEvents = []
  }
  return granted && !!api
}

async function requireDownloadsPermission() {
  if (!await hasDownloadsPermission()) throw new Error(DOWNLOADS_PERMISSION_ERROR)
  if (!chrome.downloads) throw new Error('downloads_api_unavailable: Reload Browser Relay after granting Downloads access.')
}

function downloadOptionsFromParams(params = {}) {
  const url = typeof params.url === 'string' ? params.url.trim() : ''
  if (!url) throw new Error('url is required')

  const options = { url }
  if (typeof params.filename === 'string' && params.filename.trim()) {
    options.filename = params.filename
  }
  if (params.saveAs === true) {
    options.saveAs = true
  }
  if (typeof params.conflictAction === 'string' && params.conflictAction.trim()) {
    if (!DOWNLOAD_CONFLICT_ACTIONS.has(params.conflictAction)) {
      throw new Error('conflictAction must be uniquify, overwrite, or prompt')
    }
    options.conflictAction = params.conflictAction
  }
  return options
}

async function startBrowserDownload(params = {}) {
  await requireDownloadsPermission()
  const options = downloadOptionsFromParams(params)
  const id = await chrome.downloads.download(options)
  return { id, options }
}

async function searchBrowserDownloads(params = {}) {
  await requireDownloadsPermission()

  const query = {}
  const id = Number(params.id)
  if (Number.isInteger(id) && id > 0) query.id = id
  if (typeof params.state === 'string' && params.state.trim()) query.state = params.state
  if (typeof params.url === 'string' && params.url.trim()) query.url = params.url
  if (typeof params.filename === 'string' && params.filename.trim()) query.filename = params.filename
  if (typeof params.query === 'string' && params.query.trim()) query.query = [params.query]

  const limit = Number(params.limit)
  if (Number.isInteger(limit) && limit > 0) query.limit = Math.min(limit, 1000)

  const downloads = await chrome.downloads.search(query)
  return { downloads }
}

function forwardDownloadEvent(method, params) {
  try { sendToRelay({ method: 'forwardCDPEvent', params: { method, params } }) } catch { /* Relay may be down */ }
}

async function onRelayMessage(text) {
  let msg
  try { msg = JSON.parse(text) } catch { return }

  if (msg?.method === 'BrowserRelay.helloAck') {
    const params = msg.params || {}
    localBridgeCompatibility = bridgeCompatibility({
      localVersion: chrome.runtime.getManifest().version,
      peerVersion: params.version,
      peerProtocol: params.protocol,
      peerCapabilities: params.capabilities,
    })
    if (params.compatible === false) {
      localBridgeCompatibility.compatible = false
      localBridgeCompatibility.reason = params.reason || localBridgeCompatibility.reason || 'The local daemon rejected the bridge protocol.'
      lastConnectError = localBridgeCompatibility.reason
    }
    return
  }

  if (msg?.method === 'ping') {
    try { sendToRelay({ method: 'pong' }) } catch { /* ignore */ }
    return
  }

  if (typeof msg?.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (typeof msg?.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) { if (tab.targetId === targetId) return tabId }
  return null
}

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, '1.3')
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})

  const info = await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo')
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) throw new Error('Target.getTargetInfo returned no targetId')
  await chrome.tabs.get(tabId) // Do not publish an id for a tab closed mid-attach.

  const sid = nextSession++
  const sessionId = `br-tab-${sid}`
  const publicTabId = publicTabIdFor(tabId)

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder: sid, idle: false, lastActivity: Date.now() })
  tabBySession.set(sessionId, tabId)
  // Fresh attach resets CDP domains — re-enable console/network capture on demand.
  consoleCaptureTabs.delete(tabId)
  networkCaptureTabs.delete(tabId)
  void chrome.action.setTitle({ tabId, title: 'Browser Relay: attached (click to detach)' })

  if (!opts.skipAttachedEvent) {
    // Best-effort notify the local daemon. Remote (External Control) attaches
    // tabs the same way but has no daemon, so a closed relay must not fail attach.
    try {
      sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.attachedToTarget', params: { sessionId, tabId: publicTabId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false } } })
    } catch { /* local relay down — fine for remote mode */ }
  }

  setBadge(tabId, 'on')
  await persistState()
  return { sessionId, targetId, tabId: publicTabId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) {
      try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: childSessionId, reason: 'parent_detached' } } }) } catch { /* ignore */ }
      childSessionToTab.delete(childSessionId)
    }
  }

  if (tab?.sessionId && tab?.targetId) {
    try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: tab.sessionId, targetId: tab.targetId, reason } } }) } catch { /* ignore */ }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)
  idleDetaching.delete(tabId)
  clearTabActivity(tabId)

  try { await chrome.debugger.detach({ tabId }) } catch { /* may already be detached */ }

  setBadge(tabId, 'off')
  void chrome.action.setTitle({ tabId, title: 'Browser Relay (click to connect)' })
  await persistState()
}

// Re-attach a tab that was soft-detached for idleness. Reuses the same
// br-tab sessionId so the upstream agent's session reference stays valid,
// and re-announces it (like reannounceAttachedTabs) so the relay refreshes
// its targetId mapping — the page may have navigated to a new target while
// the debugger was detached.
async function wakeTab(tabId) {
  const tab = tabs.get(tabId)
  if (!tab || !tab.idle) return
  idleDetaching.delete(tabId)
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
  } catch (err) {
    // attach() throws the same "Another debugger is already attached" message
    // whether DevTools/another extension owns the tab or a stale session of
    // ours survived — the text can't tell them apart. Probe instead: only
    // treat the tab as awake if a command actually works. Otherwise stay
    // idle (don't flip to connected) so the next command retries wakeTab
    // once the blocking debugger goes away.
    let alive = false
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1', returnByValue: true })
      alive = true
    } catch { /* no usable debug session */ }
    if (!alive) {
      setBadge(tabId, 'error')
      void chrome.action.setTitle({ tabId, title: 'Browser Relay: tab busy — close DevTools/other debugger' })
      throw err instanceof Error ? err : new Error(String(err))
    }
  }
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {})
  try {
    const info = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
    const tid = String(info?.targetInfo?.targetId || '').trim()
    if (tid) tab.targetId = tid
    // Refresh the relay's sessionId->targetId map; targetId may have changed
    // if the page navigated while we were detached.
    try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.attachedToTarget', params: { sessionId: tab.sessionId, tabId: publicTabIdFor(tabId), targetInfo: { ...info?.targetInfo, attached: true }, waitingForDebugger: false } } }) } catch { /* relay may be down */ }
  } catch { /* keep previous targetId */ }
  tab.idle = false
  tab.lastActivity = Date.now()
  setBadge(tabId, (relayWs?.readyState === WebSocket.OPEN || remoteConnected()) ? 'on' : 'connecting')
  void chrome.action.setTitle({ tabId, title: 'Browser Relay: attached (click to detach)' })
  await persistState()
}

// Detach the debugger from tabs idle longer than the configured timeout.
// This only drops the Chrome-level debugger (hiding the infobar); the logical
// relay session is kept so the next command transparently re-attaches.
async function softDetachIdleTabs() {
  const idleMs = await getIdleDetachMs()
  if (idleMs <= 0) return
  const now = Date.now()
  let changed = false
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== 'connected' || tab.idle) continue
    if (tabOperationLocks.has(tabId) || reattachPending.has(tabId)) continue
    if (!tab.lastActivity || now - tab.lastActivity < idleMs) continue
    tab.idle = true
    idleDetaching.add(tabId)
    // chrome.debugger.detach destroys all of Chrome's real flat-mode child
    // sessions (OOPIFs/related pages). Their sessionIds are now dead, so tell
    // the relay to drop them and forget the mappings — otherwise a later
    // command routed to a stale child session fails with CDP -32001
    // "Session with given id not found". The main br-tab session is kept
    // (it is addressed by tabId and survives the wake).
    for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
      if (parentTabId !== tabId) continue
      try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: childSessionId, reason: 'parent_detached' } } }) } catch { /* relay may be down */ }
      childSessionToTab.delete(childSessionId)
    }
    try { await chrome.debugger.detach({ tabId }) } catch { /* may already be detached */ }
    setBadge(tabId, 'idle')
    void chrome.action.setTitle({ tabId, title: 'Browser Relay: idle (re-attaches on next command)' })
    changed = true
  }
  if (changed) await persistState()
}

function isAttachableUrl(url) {
  if (!url) return false
  if (url.startsWith('chrome://')) return false
  if (url.startsWith('chrome-extension://')) return false
  if (url.startsWith('devtools://')) return false
  return true
}

async function autoAttachAllTabs() {
  if (!localControlEnabled) return
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return
  const allTabs = await chrome.tabs.query({})
  for (const tab of allTabs) {
    const tabId = tab.id
    if (!tabId) continue
    if (tabs.has(tabId)) continue
    if (!isAttachableUrl(tab.url)) continue
    if (tabOperationLocks.has(tabId)) continue
    if (reattachPending.has(tabId)) continue

    tabOperationLocks.add(tabId)
    try { await attachTab(tabId) } catch (err) {
      console.warn(`Auto-attach tab ${tabId} failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally { tabOperationLocks.delete(tabId) }
  }
}

async function connectOrToggle() {
  if (!localControlEnabled) {
    void chrome.runtime.openOptionsPage()
    return { ok: false, consentRequired: true }
  }
  cancelReconnect()
  try {
    await ensureRelayConnection()
    await recoverRelaySession()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('Connect failed:', message)
    // Popup surfaces lastConnectError + install hint; no need to open options.
  }
  return { ok: relayWs?.readyState === WebSocket.OPEN, error: lastConnectError }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  if (method === 'BrowserRelay.download') return await startBrowserDownload(params)
  if (method === 'BrowserRelay.searchDownloads') return await searchBrowserDownloads(params)

  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined

  // A command already routed to a closed tab must fail, never fall through to
  // another tab that the user may be actively using.
  if (sessionId && !bySession) throw new Error(`No attached tab for session ${sessionId}`)

  // Target.createTarget spins up its own fresh tab, so it needs no existing
  // attached tab. Handle it before the guard below so it works from a cold start
  // (zero attached tabs) — otherwise the relay could never open the first tab.
  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise((r) => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId, tabId: attached.tabId }
  }

  const tabId = bySession?.tabId || (targetId ? getTabByTargetId(targetId) : null) || (() => { for (const [id, tab] of tabs.entries()) { if (tab.state === 'connected') return id } return null })()

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  const activeTab = tabs.get(tabId)
  if (activeTab) {
    activeTab.lastActivity = Date.now()
    if (activeTab.state === 'connected') markTabActivity(tabId)
  }
  // closeTarget/activateTarget use the tabs API and need no debugger — everything
  // else must wake an idle tab first.
  const noDebuggerMethods = method === 'Target.closeTarget' || method === 'Target.activateTarget'
  if (activeTab?.idle && !noDebuggerMethods) {
    await wakeTab(tabId)
  }

  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try { await chrome.debugger.sendCommand(debuggee, 'Runtime.disable'); await new Promise((r) => setTimeout(r, 50)) } catch { /* ignore */ }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try { await chrome.tabs.remove(toClose) } catch { return { success: false } }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession = sessionId && mainSessionId && sessionId !== mainSessionId ? { ...debuggee, sessionId } : debuggee
  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }
  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  // Buffer console/network events for remote /api/console and /api/network.
  captureCdpEvent(tabId, method, params)

  try {
    sendToRelay({ method: 'forwardCDPEvent', params: { sessionId: source.sessionId || tab.sessionId, tabId: publicTabIdFor(tabId), method, params } })
  } catch { /* Relay may be down */ }
}

async function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return

  // We detached this tab ourselves for idleness — keep the logical session
  // (same sessionId/targetId) so it transparently re-attaches on demand.
  if (idleDetaching.has(tabId) || tabs.get(tabId)?.idle) return

  if (reason === 'canceled_by_user' || reason === 'replaced_with_devtools') {
    void detachTab(tabId, reason)
    return
  }

  let tabInfo
  try { tabInfo = await chrome.tabs.get(tabId) } catch {
    void detachTab(tabId, reason)
    return
  }

  if (tabInfo.url?.startsWith('chrome://') || tabInfo.url?.startsWith('chrome-extension://')) {
    void detachTab(tabId, reason)
    return
  }

  if (reattachPending.has(tabId)) return

  const oldTab = tabs.get(tabId)
  const oldSessionId = oldTab?.sessionId
  const oldTargetId = oldTab?.targetId

  if (oldSessionId) tabBySession.delete(oldSessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  if (oldSessionId && oldTargetId) {
    try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: oldSessionId, targetId: oldTargetId, reason: 'navigation-reattach' } } }) } catch { /* ignore */ }
  }

  reattachPending.add(tabId)
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({ tabId, title: 'Browser Relay: re-attaching after navigation...' })

  const delays = [300, 700, 1500]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    await new Promise((r) => setTimeout(r, delays[attempt]))
    if (!reattachPending.has(tabId)) return

    try { await chrome.tabs.get(tabId) } catch {
      reattachPending.delete(tabId)
      setBadge(tabId, 'off')
      return
    }

    if ((!localControlEnabled || !relayWs || relayWs.readyState !== WebSocket.OPEN) && !remoteConnected()) {
      reattachPending.delete(tabId)
      setBadge(tabId, 'error')
      void chrome.action.setTitle({ tabId, title: 'Browser Relay: control connection lost during re-attach' })
      return
    }

    try { await attachTab(tabId); reattachPending.delete(tabId); return } catch { /* continue */ }
  }

  reattachPending.delete(tabId)
  setBadge(tabId, 'off')
  void chrome.action.setTitle({ tabId, title: 'Browser Relay: re-attach failed (click to retry)' })
}

// Tab lifecycle listeners
chrome.tabs.onRemoved.addListener((tabId) => void whenReady(() => {
  reattachPending.delete(tabId)
  idleDetaching.delete(tabId)
  clearTabActivity(tabId)
  const hadPublicTabId = publicTabIds.delete(tabId)
  if (!tabs.has(tabId)) {
    if (hadPublicTabId) void persistState()
    return
  }
  const tab = tabs.get(tabId)
  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }
  if (tab?.sessionId && tab?.targetId) {
    try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: tab.sessionId, targetId: tab.targetId, reason: 'tab_closed' } } }) } catch { /* ignore */ }
  }
  void persistState()
}))

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => void whenReady(() => {
  clearTabActivity(removedTabId)
  const publicTabId = publicTabIds.get(removedTabId)
  publicTabIds.delete(removedTabId)
  if (publicTabId) publicTabIds.set(addedTabId, publicTabId)
  const tab = tabs.get(removedTabId)
  if (!tab) {
    if (publicTabId) void persistState()
    return
  }
  tabs.delete(removedTabId)
  tabs.set(addedTabId, tab)
  if (tab.sessionId) tabBySession.set(tab.sessionId, addedTabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === removedTabId) childSessionToTab.set(childSessionId, addedTabId)
  }
  setBadge(addedTabId, 'on')
  void persistState()
}))

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => void whenReady(async () => {
  if (changeInfo.status !== 'complete') return
  const attached = tabs.get(tabId)
  if (attached?.state === 'connected' && !attached.idle) {
    setBadge(tabId, (relayWs?.readyState === WebSocket.OPEN || remoteConnected()) ? 'on' : 'connecting')
    return
  }
  if (tabs.has(tabId)) return
  if (!isAttachableUrl(tab.url)) return
  if (tabOperationLocks.has(tabId)) return
  if (reattachPending.has(tabId)) return
  if (!localControlEnabled || !relayWs || relayWs.readyState !== WebSocket.OPEN) return

  tabOperationLocks.add(tabId)
  try { await attachTab(tabId) } catch (err) {
    console.warn(`Auto-attach tab ${tabId} on update failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally { tabOperationLocks.delete(tabId) }
}))

chrome.debugger.onEvent.addListener((...args) => void whenReady(() => onDebuggerEvent(...args)))
chrome.debugger.onDetach.addListener((...args) => void whenReady(() => onDebuggerDetach(...args)))

chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions.permissions?.includes('downloads')) void refreshDownloadEventListeners()
  if (permissions.origins?.length) {
    // Register optional origins from the permission event itself. This closes
    // the MV3 interruption window between Options receiving request() success
    // and the enable message reaching this service worker. A successful enable
    // removes the active origin from this queue; startup removes abandoned ones.
    // Start the storage write directly while handling the permission event,
    // rather than delaying it behind general connection initialization.
    void registerRemoteHostPermissionCandidates(permissions.origins).catch(() => {})
  }
})
chrome.permissions.onRemoved.addListener((permissions) => {
  if (permissions.permissions?.includes('downloads')) void refreshDownloadEventListeners()
  if (permissions.origins?.length) {
    void whenReady(() => handleRemovedRemoteHostOrigins(permissions.origins))
  }
})

chrome.action.onClicked.addListener(() => void whenReady(() => connectOrToggle()))

chrome.tabs.onActivated.addListener(({ tabId }) => void whenReady(() => {
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected' && !tab.idle) {
    setBadge(tabId, (relayWs?.readyState === WebSocket.OPEN || remoteConnected()) ? 'on' : 'connecting')
  }
}))

chrome.runtime.onInstalled.addListener((details) => {
  void whenReady(async () => {
    const consent = await enforceConsentState(details?.reason || 'update')
    if (details?.reason === 'install' && !consent.localConsentCurrent) {
      await chrome.storage.local.set({ localOnboardingPending: true })
    }
    if (!consent.localEnabled) closeLocalRelay()
    if (!consent.remoteEnabled) closeRemoteHub({ disable: true })
    if (!anyControlModeEnabled()) await detachAllControlledTabs('consent_migration')
    if (details?.reason === 'install' || !consent.localConsentCurrent) {
      await chrome.runtime.openOptionsPage()
    }
  })
})

chrome.alarms.create('relay-keepalive', { periodInMinutes: 0.5 })

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'relay-keepalive') return
  await initPromise

  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected' && !tab.idle) {
      setBadge(tabId, (relayWs?.readyState === WebSocket.OPEN || remoteConnected()) ? 'on' : 'connecting')
    }
  }

  if (localControlEnabled && relayWs && relayWs.readyState === WebSocket.OPEN) {
    await autoAttachAllTabs()
  }

  if (anyControlModeEnabled()) await softDetachIdleTabs()

  if (localControlEnabled && (!relayWs || relayWs.readyState !== WebSocket.OPEN)) {
    if (!relayConnectPromise && !reconnectTimer) {
      console.log('Keepalive: WebSocket unhealthy, triggering reconnect')
      try {
        await ensureRelayConnection()
        await recoverRelaySession()
      } catch {
        if (!reconnectTimer) scheduleReconnect()
      }
    }
  }

  // Keep the External Control hub connection alive across service-worker
  // restarts: if enabled but not connected, reconnect on this 30s tick.
  const remoteCfg = await getRemoteConfig()
  if (remoteCfg && !remoteConnected() && !remoteConnectPromise) {
    await ensureRemoteHubConnection().catch(() => {})
  }
})

// ============================================================================
// Remote hub (External Control): the extension connects OUT to the Cloudflare
// hub over WSS and executes rpc.request frames itself, so a remote CLI can drive
// this browser with no local port exposed. Local mode (relayWs) is untouched.
// ============================================================================

const REMOTE_RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 15000]
let remoteReconnectAttempt = 0
let remoteAuthenticated = false

function remoteConnected() {
  return !!remoteWs && remoteWs.readyState === WebSocket.OPEN && remoteAuthenticated
}

async function getRemoteConfig() {
  const s = await chrome.storage.local.get([
    'remoteControlEnabled',
    'remoteDisclosureVersion',
    'remoteDisclosureAcceptedAt',
    'remoteHost',
    ...REMOTE_CAPABILITY_KEYS,
  ])
  if (!s.remoteControlEnabled || !hasCurrentRemoteDisclosure(s) || !s.remoteRouteId || !s.remoteSecret) return null
  let host
  try {
    host = remoteHostConfig(s.remoteHost || DEFAULT_REMOTE_HOST)
    if (!await hasRemoteHostAccess(host.remoteHost)) {
      remoteLastError = 'The optional permission for this Remote Host is missing.'
      return null
    }
  } catch (error) {
    remoteLastError = error instanceof Error ? error.message : String(error)
    return null
  }
  return {
    remoteHost: host.remoteHost,
    remoteRouteId: s.remoteRouteId,
    remoteSecret: s.remoteSecret,
    remoteDeviceId: s.remoteDeviceId,
  }
}

function remoteStatusPayload() {
  return {
    enabled: remoteControlEnabled,
    connected: remoteConnected(),
    deviceId: remoteConfig?.remoteDeviceId || null,
    connectedAt: remoteConnectedAt,
    lastError: remoteLastError,
  }
}

function remoteHubUrl(config) {
  const base = remoteWsBase(config.remoteHost)
  return `${base}/v1/device/connect?routeId=${encodeURIComponent(config.remoteRouteId)}`
}

async function ensureRemoteHubConnection({ config = null, reconnectOnFailure = true } = {}) {
  const generation = remoteConnectionGeneration
  const cfg = config || await getRemoteConfig()
  if (generation !== remoteConnectionGeneration) return false
  if (!cfg) { remoteConfig = null; return false }
  remoteConfig = cfg
  if (remoteConnected()) return true
  if (remoteConnectPromise) { try { await remoteConnectPromise } catch { /* fall through */ } return remoteConnected() }

  const connectPromise = (async () => {
    const ws = new WebSocket(remoteHubUrl(cfg))
    if (generation !== remoteConnectionGeneration) {
      try { ws.close() } catch { /* ignore */ }
      throw new Error('Remote control changed during connection')
    }
    remoteWs = ws
    remoteAuthenticated = false

    let cancelPending = null
    try {
      await new Promise((resolve, reject) => {
        let settled = false
        const finish = (fn, value) => {
          if (settled) return
          settled = true
          clearTimeout(t)
          fn(value)
        }
        const t = setTimeout(() => finish(reject, new Error('Hub connect timeout')), 8000)
        cancelPending = (error) => finish(reject, error)
        remoteConnectCancel = cancelPending
        const handleRemoteFrame = createRemoteAuthMessageHandler({
          onAuthenticated: () => {
            if (generation !== remoteConnectionGeneration) {
              finish(reject, new Error('Remote control changed during connection'))
              return
            }
            remoteAuthenticated = true
            finish(resolve)
          },
          onMessage: (text) => { void whenReady(() => handleHubMessage(text)) },
        })
        ws.onmessage = (event) => handleRemoteFrame(String(event.data || ''))
        ws.onopen = () => {
          if (generation !== remoteConnectionGeneration) {
            finish(reject, new Error('Remote control changed during connection'))
            try { ws.close() } catch { /* ignore */ }
            return
          }
          ws.send(JSON.stringify({ type: 'device.auth', secret: cfg.remoteSecret }))
        }
        ws.onerror = () => finish(reject, new Error('Hub connect failed'))
        ws.onclose = (ev) => finish(reject, new Error(`Hub closed (${ev.code})`))
      })
    } finally {
      if (remoteConnectCancel === cancelPending) remoteConnectCancel = null
    }

    if (generation !== remoteConnectionGeneration) {
      try { ws.close() } catch { /* ignore */ }
      throw new Error('Remote control changed during connection')
    }

    const capabilities = ['tabs', 'eval', 'wait', 'snapshot', 'click', 'type', 'key', 'scroll', 'navigate', 'screenshot', 'console', 'network']
    if (await hasDownloadsPermission()) capabilities.push('downloads')
    ws.send(JSON.stringify({
      type: 'device.hello',
      version: chrome.runtime.getManifest().version,
      protocol: BRIDGE_PROTOCOL,
      routeId: cfg.remoteRouteId,
      deviceName: 'Browser Relay',
      capabilities,
    }))

    ws.onclose = () => { if (ws !== remoteWs) return; onRemoteHubClosed('closed') }
    ws.onerror = () => { if (ws !== remoteWs) return; onRemoteHubClosed('error') }
  })()
  remoteConnectPromise = connectPromise

  try {
    await connectPromise
    if (generation !== remoteConnectionGeneration) return false
    remoteReconnectAttempt = 0
    remoteConnectedAt = Date.now()
    remoteLastError = null
    return true
  } catch (err) {
    if (generation !== remoteConnectionGeneration) return false
    remoteLastError = err instanceof Error ? err.message : String(err)
    remoteAuthenticated = false
    try { remoteWs?.close() } catch { /* ignore */ }
    remoteWs = null
    if (remoteControlEnabled && reconnectOnFailure) scheduleRemoteReconnect()
    return false
  } finally {
    if (remoteConnectPromise === connectPromise) remoteConnectPromise = null
  }
}

function onRemoteHubClosed(reason) {
  remoteWs = null
  remoteAuthenticated = false
  remoteConnectedAt = null
  remoteLastError = `disconnected (${reason})`
  if (remoteControlEnabled) scheduleRemoteReconnect()
}

function scheduleRemoteReconnect() {
  if (!remoteControlEnabled) return
  if (remoteReconnectTimer) return
  void getRemoteConfig().then((cfg) => {
    if (!cfg) return // disabled — stop reconnecting
    const delay = REMOTE_RECONNECT_DELAYS[Math.min(remoteReconnectAttempt, REMOTE_RECONNECT_DELAYS.length - 1)]
    remoteReconnectTimer = setTimeout(() => {
      remoteReconnectTimer = null
      remoteReconnectAttempt++
      void ensureRemoteHubConnection()
    }, delay)
  })
}

function closeRemoteHub({ disable = false } = {}) {
  remoteConnectionGeneration++
  if (remoteReconnectTimer) { clearTimeout(remoteReconnectTimer); remoteReconnectTimer = null }
  remoteReconnectAttempt = 0
  const cancelConnect = remoteConnectCancel
  remoteConnectCancel = null
  if (cancelConnect) cancelConnect(new Error('Remote control changed during connection'))
  const ws = remoteWs
  remoteWs = null
  remoteConnectPromise = null
  remoteAuthenticated = false
  remoteConnectedAt = null
  if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close() } catch { /* ignore */ } }
  if (disable) {
    remoteControlEnabled = false
    remoteConfig = null
    remoteLastError = null
  }
}

const REMOTE_STATE_KEYS = [
  'remoteControlEnabled',
  'remoteDisclosureVersion',
  'remoteDisclosureAcceptedAt',
  'remoteMigrationPending',
  'remoteHost',
  'remoteOptionalHostOrigin',
  ...REMOTE_CAPABILITY_KEYS,
]

function enabledRemoteSnapshot(state = {}) {
  return state.remoteControlEnabled === true
    && hasCurrentRemoteDisclosure(state)
    && hasRemoteCapability(state)
}

function remoteConfigFromSnapshot(state = {}) {
  if (!enabledRemoteSnapshot(state)) return null
  return {
    remoteHost: remoteHostConfig(state.remoteHost || DEFAULT_REMOTE_HOST).remoteHost,
    remoteRouteId: state.remoteRouteId,
    remoteSecret: state.remoteSecret,
    remoteDeviceId: state.remoteDeviceId,
  }
}

async function readRemoteState() {
  return await serializeMutation('remote', () => chrome.storage.local.get(REMOTE_STATE_KEYS))
}

async function writeRemoteState(operation, values, remove = []) {
  return await serializeMutation('remote', async () => {
    if (operation !== remoteControlOperationGeneration) return false
    if (Object.keys(values).length) await chrome.storage.local.set(values)
    if (remove.length) await chrome.storage.local.remove(remove)
    return operation === remoteControlOperationGeneration
  })
}

async function restoreRemoteState(operation, snapshot) {
  const values = {}
  const remove = []
  for (const key of REMOTE_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) values[key] = snapshot[key]
    else remove.push(key)
  }
  return await writeRemoteState(operation, values, remove)
}

async function currentCommittedRemotePermissionOrigins() {
  const origins = new Set()
  if (remoteControlEnabled) {
    const stored = await chrome.storage.local.get(['remoteOptionalHostOrigin', 'remoteHost'])
    const active = stored.remoteOptionalHostOrigin || optionalRemoteHostOrigin(stored.remoteHost)
    if (active) origins.add(active)
  }
  return origins
}

function currentCandidateRemotePermissionOrigins() {
  return new Set(remoteControlCandidateOrigin ? [remoteControlCandidateOrigin] : [])
}

function currentRemotePermissionProtection() {
  return {
    activeOrigin: currentCommittedRemotePermissionOrigins,
    candidateOrigin: currentCandidateRemotePermissionOrigins,
  }
}

async function cleanupSupersededRemoteOrigin(origin) {
  if (!origin) return { ok: true, pending: [], errors: [] }
  return await cleanupRemoteHostPermissions([origin], currentRemotePermissionProtection())
}

async function handleRemovedRemoteHostOrigins(origins = []) {
  const removedOrigins = new Set(origins.filter(Boolean))
  if (!removedOrigins.size) return

  // A custom-host permission can disappear after the final contains() check
  // but before the candidate capability is durably committed. Track that
  // in-flight candidate independently from remoteControlEnabled: the previous
  // mode may still be enabled during replacement, while a first-time candidate
  // intentionally remains disabled until commit.
  const candidateOrigin = remoteControlCandidateOrigin
  const candidateOperation = remoteCandidateOperation
  const previous = remoteCandidatePreviousState ? { ...remoteCandidatePreviousState } : null
  if (candidateOrigin && candidateOperation && previous && removedOrigins.has(candidateOrigin)) {
    const stillGranted = await chrome.permissions.contains({ origins: [candidateOrigin] })
    if (
      !stillGranted
      && remoteControlCandidateOrigin === candidateOrigin
      && remoteCandidateOperation === candidateOperation
    ) {
      const operation = ++remoteControlOperationGeneration
      remoteCandidateOperation = 0
      remoteControlCandidateOrigin = null
      remoteCandidatePreviousState = null
      closeRemoteHub({ disable: true })

      const previousConfig = remoteConfigFromSnapshot(previous)
      const previousOrigin = previous.remoteOptionalHostOrigin || optionalRemoteHostOrigin(previous.remoteHost)
      let canRestorePrevious = false
      if (previousConfig) {
        try {
          canRestorePrevious = await hasRemoteHostAccess(previousConfig.remoteHost)
        } catch {
          canRestorePrevious = false
        }
      }

      if (operation !== remoteControlOperationGeneration) {
        await cleanupSupersededRemoteOrigin(candidateOrigin)
        return
      }

      if (canRestorePrevious) {
        const restored = await restoreRemoteState(operation, previous)
        if (!restored || operation !== remoteControlOperationGeneration) {
          await cleanupSupersededRemoteOrigin(candidateOrigin)
          return
        }
        remoteControlEnabled = true
        const restoredConnected = await ensureRemoteHubConnection({ config: previousConfig })
        if (operation !== remoteControlOperationGeneration) {
          await cleanupSupersededRemoteOrigin(candidateOrigin)
          return
        }
        if (restoredConnected) {
          remoteLastError = 'The optional permission for the candidate Remote Host was removed. The previous Remote connection was restored.'
        }
      } else {
        const disabledPrevious = { ...previous, remoteControlEnabled: false }
        delete disabledPrevious.remoteOptionalHostOrigin
        for (const key of REMOTE_CAPABILITY_KEYS) delete disabledPrevious[key]
        const restored = await restoreRemoteState(operation, disabledPrevious)
        if (!restored || operation !== remoteControlOperationGeneration) {
          await cleanupSupersededRemoteOrigin(candidateOrigin)
          return
        }
        remoteControlEnabled = false
        remoteLastError = 'The optional permission for the candidate Remote Host was removed. Remote control was not enabled.'
        if (!anyControlModeEnabled()) await detachAllControlledTabs('remote_candidate_permission_removed')
      }

      await cleanupRemoteHostPermissions(
        [candidateOrigin, canRestorePrevious ? null : previousOrigin].filter(Boolean),
        currentRemotePermissionProtection(),
      )
      return
    }
  }

  if (!remoteControlEnabled) return
  const stored = await chrome.storage.local.get(['remoteOptionalHostOrigin', 'remoteHost'])
  const activeOrigin = stored.remoteOptionalHostOrigin || optionalRemoteHostOrigin(stored.remoteHost)
  if (!activeOrigin || !removedOrigins.has(activeOrigin)) return
  if (await chrome.permissions.contains({ origins: [activeOrigin] })) return
  await disableRemoteControl()
  remoteLastError = 'The optional permission for the active Remote Host was removed.'
}

async function enableRemoteControl(message) {
  const operation = ++remoteControlOperationGeneration
  const cancelledPriorCandidate = remoteCandidateOperation !== 0
  if (cancelledPriorCandidate) closeRemoteHub()
  remoteCandidateOperation = 0
  remoteControlCandidateOrigin = null
  remoteCandidatePreviousState = null
  let host = null
  let candidateOrigin = null
  let candidateStarted = false
  let previous = {}
  let previousConfig = null
  let previousOrigin = null

  try {
    // Snapshot the last committed state before validating untrusted message
    // fields. Malformed or incomplete requests must not clear a working mode.
    previous = await readRemoteState()
    previousConfig = remoteConfigFromSnapshot(previous)
    previousOrigin = previous.remoteOptionalHostOrigin || optionalRemoteHostOrigin(previous.remoteHost)
    if (operation !== remoteControlOperationGeneration) {
      return { connected: false, superseded: true, lastError: 'A newer Remote control request replaced this one.' }
    }

    if (message.disclosureConfirmed !== true) {
      throw new Error('Remote control requires explicit data-disclosure confirmation.')
    }
    host = remoteHostConfig(message.remoteHost || DEFAULT_REMOTE_HOST)
    candidateOrigin = host.requiresOptionalHostPermission ? host.permissionOrigin : null
    remoteControlCandidateOrigin = candidateOrigin

    if (!await hasRemoteHostAccess(host.remoteHost)) {
      throw new Error('Remote Host permission was not granted.')
    }
    if (candidateOrigin) await registerRemoteHostPermissionCandidates([candidateOrigin])
    if (!message.routeId || !message.secret || !message.remoteDeviceId) {
      throw new Error('Remote capability is incomplete.')
    }
    if (operation !== remoteControlOperationGeneration) {
      await cleanupSupersededRemoteOrigin(candidateOrigin)
      return { connected: false, superseded: true, lastError: 'A newer Remote control request replaced this one.' }
    }

    const candidate = {
      remoteHost: host.remoteHost,
      remoteRouteId: String(message.routeId),
      remoteSecret: String(message.secret),
      remoteDeviceId: String(message.remoteDeviceId),
    }
    closeRemoteHub()
    candidateStarted = true
    remoteCandidateOperation = operation
    remoteCandidatePreviousState = { ...previous }
    const connected = await ensureRemoteHubConnection({ config: candidate, reconnectOnFailure: false })
    if (operation !== remoteControlOperationGeneration) {
      await cleanupSupersededRemoteOrigin(candidateOrigin)
      return { connected: false, superseded: true, lastError: 'A newer Remote control request replaced this one.' }
    }
    if (!connected) throw new Error(remoteLastError || 'Remote Hub connection failed.')
    if (!await hasRemoteHostAccess(host.remoteHost)) {
      throw new Error('Remote Host permission was removed during connection.')
    }
    if (operation !== remoteControlOperationGeneration) {
      await cleanupSupersededRemoteOrigin(candidateOrigin)
      return { connected: false, superseded: true, lastError: 'A newer Remote control request replaced this one.' }
    }

    const committed = await writeRemoteState(operation, {
      remoteControlEnabled: true,
      remoteDisclosureVersion: REMOTE_DISCLOSURE_VERSION,
      remoteDisclosureAcceptedAt: Date.now(),
      remoteMigrationPending: false,
      remoteHost: host.remoteHost,
      remoteRouteId: candidate.remoteRouteId,
      remoteSecret: candidate.remoteSecret,
      remoteDeviceId: candidate.remoteDeviceId,
      ...(candidateOrigin ? { remoteOptionalHostOrigin: candidateOrigin } : {}),
    }, candidateOrigin ? [] : ['remoteOptionalHostOrigin'])
    if (!committed) {
      await cleanupSupersededRemoteOrigin(candidateOrigin)
      return { connected: false, superseded: true, lastError: 'A newer Remote control request replaced this one.' }
    }

    remoteControlEnabled = true
    if (candidateOrigin) await clearRemoteHostPermissionCandidates([candidateOrigin])
    if (operation !== remoteControlOperationGeneration) {
      return { connected: false, superseded: true, lastError: 'The Remote Host permission changed during commit.' }
    }
    remoteCandidateOperation = 0
    remoteControlCandidateOrigin = null
    remoteCandidatePreviousState = null
    const cleanup = await cleanupRemoteHostPermissions(
      previousOrigin && previousOrigin !== candidateOrigin ? [previousOrigin] : [],
      currentRemotePermissionProtection(),
    )
    return {
      connected: true,
      enabled: true,
      lastError: null,
      permissionCleanupPending: !cleanup.ok,
      permissionCleanupErrors: cleanup.errors,
    }
  } catch (error) {
    const lastError = error instanceof Error ? error.message : String(error)
    if (operation !== remoteControlOperationGeneration) {
      await cleanupSupersededRemoteOrigin(candidateOrigin)
      return { connected: false, superseded: true, lastError }
    }

    if (previousConfig && !candidateStarted) {
      // Validation failed before the working connection was touched. Preserve
      // it exactly; only revoke a newly granted, unused candidate permission.
      remoteControlCandidateOrigin = null
      remoteCandidatePreviousState = null
      const restoredConnected = cancelledPriorCandidate
        ? await ensureRemoteHubConnection({ config: previousConfig })
        : remoteConnected()
      const cleanup = await cleanupRemoteHostPermissions(
        candidateOrigin && candidateOrigin !== previousOrigin ? [candidateOrigin] : [],
        currentRemotePermissionProtection(),
      )
      return {
        connected: false,
        enabled: true,
        restored: true,
        restoredConnected,
        remoteHost: previousConfig.remoteHost,
        remoteDeviceId: previousConfig.remoteDeviceId,
        lastError,
        permissionCleanupPending: !cleanup.ok,
        permissionCleanupErrors: cleanup.errors,
      }
    }

    if (candidateStarted) closeRemoteHub()
    remoteCandidateOperation = 0
    remoteCandidatePreviousState = null
    if (previousConfig) {
      const restored = await restoreRemoteState(operation, previous)
      if (!restored || operation !== remoteControlOperationGeneration) {
        await cleanupSupersededRemoteOrigin(candidateOrigin)
        return { connected: false, superseded: true, lastError }
      }
      remoteControlEnabled = true
      remoteControlCandidateOrigin = null
      const restoredConnected = await ensureRemoteHubConnection({ config: previousConfig })
      const cleanup = await cleanupRemoteHostPermissions(
        candidateOrigin && candidateOrigin !== previousOrigin ? [candidateOrigin] : [],
        currentRemotePermissionProtection(),
      )
      return {
        connected: false,
        enabled: true,
        restored: true,
        restoredConnected,
        remoteHost: previousConfig.remoteHost,
        remoteDeviceId: previousConfig.remoteDeviceId,
        lastError,
        permissionCleanupPending: !cleanup.ok,
        permissionCleanupErrors: cleanup.errors,
      }
    }

    closeRemoteHub({ disable: true })
    remoteCandidateOperation = 0
    remoteControlCandidateOrigin = null
    remoteCandidatePreviousState = null
    const failureValues = {
      remoteControlEnabled: false,
      ...(host ? {
        remoteDisclosureVersion: REMOTE_DISCLOSURE_VERSION,
        remoteDisclosureAcceptedAt: Date.now(),
        remoteMigrationPending: false,
        remoteHost: host.remoteHost,
      } : {}),
    }
    const committed = await writeRemoteState(
      operation,
      failureValues,
      [...REMOTE_CAPABILITY_KEYS, 'remoteOptionalHostOrigin'],
    )
    if (!committed || operation !== remoteControlOperationGeneration) {
      await cleanupSupersededRemoteOrigin(candidateOrigin)
      return { connected: false, superseded: true, lastError }
    }
    const cleanup = await cleanupRemoteHostPermissions(
      [candidateOrigin, previousOrigin].filter(Boolean),
      currentRemotePermissionProtection(),
    )
    if (!anyControlModeEnabled()) await detachAllControlledTabs('remote_enable_failed')
    return {
      connected: false,
      enabled: false,
      lastError,
      permissionCleanupPending: !cleanup.ok,
      permissionCleanupErrors: cleanup.errors,
    }
  }
}

async function disableRemoteControl() {
  const operation = ++remoteControlOperationGeneration
  remoteCandidateOperation = 0
  remoteControlCandidateOrigin = null
  remoteCandidatePreviousState = null
  const stored = await readRemoteState()
  const origin = stored.remoteOptionalHostOrigin || optionalRemoteHostOrigin(stored.remoteHost)
  closeRemoteHub({ disable: true })
  const committed = await writeRemoteState(
    operation,
    { remoteControlEnabled: false },
    [...REMOTE_CAPABILITY_KEYS, 'remoteOptionalHostOrigin'],
  )
  if (!committed || operation !== remoteControlOperationGeneration) {
    await cleanupSupersededRemoteOrigin(origin)
    return { ok: false, superseded: true, permissionCleanupPending: false, lastError: null }
  }
  const cleanup = await cleanupRemoteHostPermissions(origin ? [origin] : [], currentRemotePermissionProtection())
  if (!anyControlModeEnabled()) await detachAllControlledTabs('remote_control_disabled')
  return {
    ok: cleanup.ok,
    superseded: false,
    permissionCleanupPending: !cleanup.ok,
    lastError: cleanup.errors.join('; ') || null,
  }
}

// Execute one rpc.request from the hub, reply with rpc.response.
async function handleHubMessage(text) {
  let msg
  try { msg = JSON.parse(text) } catch { return }
  if (msg?.type !== 'rpc.request') return
  let response
  try {
    const result = await executeRemoteApi(String(msg.method || 'GET'), String(msg.path || ''), msg.body)
    response = { type: 'rpc.response', id: msg.id, status: result.status || 200, headers: { 'content-type': 'application/json' }, body: result.body }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    response = { type: 'rpc.response', id: msg.id, status: 500, headers: { 'content-type': 'application/json' }, body: { ok: false, code: 'remote_exec_failed', error: message, message } }
  }
  try { if (remoteConnected()) remoteWs.send(JSON.stringify(response)) } catch { /* hub gone */ }
}

// ---- Remote command executor: run the CLI's /api/* semantics inside the
// extension using chrome.debugger directly (no Node relay in the loop). ----

function apiError(code, message, status = 400, retryable = false, details) {
  return {
    status,
    body: {
      ok: false,
      code,
      error: message,
      message,
      status,
      retryable,
      ...(details === undefined ? {} : { details }),
    },
  }
}

// Resolve the CLI's formal tabId to Chrome's internal numeric tab id. With no
// param, preserve the existing active-tab behavior.
async function resolveRemoteTabId(tabIdParam) {
  if (tabIdParam !== undefined && tabIdParam !== null && tabIdParam !== '') {
    const publicTabId = String(tabIdParam)
    if (!PUBLIC_TAB_ID_PATTERN.test(publicTabId)) throw new Error(`No tab matches ${publicTabId}`)
    for (const [chromeTabId, id] of publicTabIds.entries()) {
      if (id !== publicTabId) continue
      try { await chrome.tabs.get(chromeTabId); return chromeTabId } catch {
        publicTabIds.delete(chromeTabId)
        await persistState()
        break
      }
    }
    throw new Error(`No tab matches ${publicTabId}`)
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (active && isAttachableUrl(active.url)) return active.id
  for (const t of await chrome.tabs.query({})) if (isAttachableUrl(t.url)) return t.id
  throw new Error('No controllable tab found')
}

async function ensureRemoteAttached(tabId) {
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') {
    if (tab.idle) await wakeTab(tabId)
    return
  }
  await attachTab(tabId)
}

// Run a CDP command against a chrome tab, attaching on demand.
async function remoteCdp(tabId, method, params) {
  await ensureRemoteAttached(tabId)
  return await chrome.debugger.sendCommand({ tabId }, method, params || {})
}

async function executeRemoteApi(method, path, body) {
  const u = new URL(String(path || '/'), 'http://relay.local')
  const p = u.pathname
  const payload = body && typeof body === 'object' ? body : {}

  if (method === 'GET' && p === '/api/tabs') return { status: 200, body: await apiListTabs() }
  if (method === 'POST' && p === '/api/eval') return { status: 200, body: await apiEval(payload, u.searchParams) }
  if (method === 'POST' && p === '/api/wait') return await apiWait(payload)
  if (method === 'POST' && p === '/api/navigate') return { status: 200, body: await apiNavigate(payload) }
  if (method === 'POST' && p === '/api/click') return { status: 200, body: await apiClick(payload) }
  if (method === 'POST' && p === '/api/type') return { status: 200, body: await apiType(payload) }
  if (method === 'POST' && p === '/api/key') return { status: 200, body: await apiKey(payload) }
  if (method === 'POST' && p === '/api/scroll') return { status: 200, body: await apiScroll(payload) }
  if (method === 'GET' && p === '/api/snapshot') return { status: 200, body: await apiSnapshot(payload, u.searchParams) }
  if ((method === 'GET' || method === 'POST') && p === '/api/screenshot') return { status: 200, body: await apiScreenshot(payload, u.searchParams) }
  if (method === 'GET' && p === '/api/console') return { status: 200, body: await apiConsole(payload, u.searchParams) }
  if (method === 'POST' && p === '/api/console/clear') return { status: 200, body: await apiConsoleClear(payload) }
  if (method === 'GET' && p === '/api/network') return { status: 200, body: await apiNetwork(payload, u.searchParams) }
  if (method === 'POST' && p === '/api/network/clear') return { status: 200, body: await apiNetworkClear(payload) }
  if (method === 'POST' && p === '/api/download/start') {
    return { status: 200, body: { ok: true, ...await startBrowserDownload(payload) } }
  }
  if (method === 'GET' && p === '/api/downloads') {
    const result = await searchBrowserDownloads(Object.fromEntries(u.searchParams.entries()))
    const limit = boundInt(u.searchParams.get('limit'), 100, 0, 1000)
    return {
      status: 200,
      body: { ok: true, ...result, events: limit === 0 ? [] : downloadEvents.slice(-limit) },
    }
  }
  if (method === 'POST' && p === '/api/downloads/clear') {
    const cleared = downloadEvents.length
    downloadEvents = []
    return { status: 200, body: { ok: true, cleared } }
  }

  return apiError('unknown_endpoint', `Unknown or not-yet-supported remote endpoint: ${method} ${p}`, 404)
}

async function apiListTabs() {
  const list = []
  for (const t of await chrome.tabs.query({})) {
    if (!isAttachableUrl(t.url)) continue
    list.push({ id: publicTabIdFor(t.id), title: t.title || '', url: t.url || '', attached: tabs.get(t.id)?.state === 'connected' })
  }
  await persistState()
  return { ok: true, tabs: list }
}

async function apiEval(body, searchParams) {
  const expression = String(body.expression ?? '')
  if (!expression) return apiError('validation_error', 'expression is required').body
  const tabId = await resolveRemoteTabId(body.tabId ?? searchParams.get('tabId'))
  const returnByValue = body.returnByValue !== false
  const result = await remoteCdp(tabId, 'Runtime.evaluate', { expression, returnByValue, awaitPromise: true })
  return { ok: true, result: result?.result || null, exceptionDetails: result?.exceptionDetails || null }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function elementNotFound(selector) {
  return { ok: false, code: 'element_not_found', found: false, error: `Element not found: ${selector}`, message: `Element not found: ${selector}`, selector }
}

async function evalValue(tabId, expression) {
  const r = await remoteCdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true })
  return r?.result?.value
}

async function apiWait(body) {
  const options = normalizeWaitOptions(body)
  if (!options.ok) return apiError('invalid_request', options.message, 400, false, { field: options.field })

  let tabId
  try {
    tabId = await resolveRemoteTabId(options.tabId)
  } catch (error) {
    return apiError('tab_not_found', error instanceof Error ? error.message : String(error), 404)
  }

  const expression = buildWaitExpression(options.selector, options.state)
  const startedAt = Date.now()
  let attempts = 0

  while (true) {
    try {
      await chrome.tabs.get(tabId)
    } catch {
      return apiError('tab_not_found', `The target tab was closed while waiting: ${tabId}`, 404, false, { tabId })
    }

    attempts += 1
    let evaluation
    try {
      evaluation = await evalValue(tabId, expression)
    } catch (error) {
      return apiError(
        'wait_evaluation_failed',
        error instanceof Error ? error.message : String(error),
        409,
        true,
        { selector: options.selector, state: options.state },
      )
    }

    if (!evaluation || typeof evaluation !== 'object') {
      return apiError(
        'wait_evaluation_failed',
        'The page returned an invalid wait result',
        409,
        true,
        { selector: options.selector, state: options.state },
      )
    }
    if (evaluation.invalidSelector) {
      return apiError('invalid_selector', `Invalid CSS selector: ${options.selector}`, 400, false, { selector: options.selector })
    }

    const elapsedMs = Date.now() - startedAt
    if (evaluation.matched === true) {
      return {
        status: 200,
        body: {
          ok: true,
          matched: true,
          selector: options.selector,
          state: options.state,
          elapsedMs,
          attempts,
          matchCount: evaluation.matchCount ?? null,
          visibleCount: evaluation.visibleCount ?? null,
        },
      }
    }

    if (elapsedMs >= options.timeoutMs) {
      return apiError(
        'wait_timeout',
        `Timed out waiting for selector: ${options.selector}`,
        408,
        true,
        {
          selector: options.selector,
          state: options.state,
          timeoutMs: options.timeoutMs,
          elapsedMs,
          attempts,
        },
      )
    }

    await sleep(Math.min(options.pollMs, options.timeoutMs - elapsedMs))
  }
}

async function apiNavigate(body) {
  const url = String(body.url ?? '')
  if (!url) return apiError('validation_error', 'url is required').body
  const tabId = await resolveRemoteTabId(body.tabId)
  const result = await remoteCdp(tabId, 'Page.navigate', { url })
  await sleep(500)
  let title = '', finalUrl = url
  try {
    title = (await evalValue(tabId, 'document.title')) || ''
    finalUrl = (await evalValue(tabId, 'location.href')) || url
  } catch { /* non-critical */ }
  return { ok: true, url: finalUrl, title, ...result }
}

// findJs returns JSON {found, x, y, text} for the element centre in viewport coords.
function findElementJs(selector) {
  return `(function() { var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify({ found: false }); var rect = el.getBoundingClientRect(); return JSON.stringify({ found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: (el.innerText || el.textContent || '').trim().slice(0, 100) }); })()`
}

async function apiClick(body) {
  const selector = body.selector
  if (!selector || typeof selector !== 'string') return apiError('validation_error', 'selector is required').body
  const tabId = await resolveRemoteTabId(body.tabId)
  const findJs = findElementJs(selector)
  const el = JSON.parse((await evalValue(tabId, findJs)) || '{"found":false}')
  if (!el.found) return elementNotFound(selector)

  const button = body.button || 'left'
  const clickCount = body.doubleClick ? 2 : 1
  await remoteCdp(tabId, 'Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`, returnByValue: true }).catch(() => {})
  const el2 = JSON.parse((await evalValue(tabId, findJs)) || '{"found":false}')

  // CDP mouse input is ignored for background tabs. Use a normal DOM click so
  // remote agents do not have to steal focus from the user's active tab.
  const visibility = await evalValue(tabId, 'document.visibilityState')
  if (visibility === 'hidden' && button === 'left' && clickCount === 1) {
    const domClickJs = `(function() { var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`
    if (await evalValue(tabId, domClickJs)) {
      return { ok: true, clicked: true, strategy: 'dom', elementText: el2.text || el.text || '', selector }
    }
  }

  const fx = Math.round(el2.found ? el2.x : el.x)
  const fy = Math.round(el2.found ? el2.y : el.y)

  await remoteCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx, y: fy })
  await remoteCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: fx, y: fy, button, clickCount })
  await remoteCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: fx, y: fy, button, clickCount })
  return { ok: true, clicked: true, strategy: 'mouse', elementText: el2.text || el.text || '', selector }
}

async function apiType(body) {
  const text = body.text
  if (typeof text !== 'string') return apiError('validation_error', 'text is required').body
  const tabId = await resolveRemoteTabId(body.tabId)
  const selector = body.selector

  if (selector) {
    const focusJs = `(function() { var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify({ found: false }); el.focus(); return JSON.stringify({ found: true }); })()`
    const info = JSON.parse((await evalValue(tabId, focusJs)) || '{"found":false}')
    if (!info.found) return elementNotFound(selector)
  }

  if (body.clear) {
    await remoteCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 })
    await remoteCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 })
    await remoteCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' })
    await remoteCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' })
  }

  await remoteCdp(tabId, 'Input.insertText', { text })

  if (body.submit) {
    const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await remoteCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...enter })
    await remoteCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
  }
  return { ok: true, typed: true }
}

// Pragmatic key support: common named keys + modifier combos (e.g. "ctrl+a",
// "Enter", "ArrowDown"). Not the full relay key table, but covers typical use.
const NAMED_KEYS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
}
const KEY_MODIFIERS = { alt: 1, control: 2, ctrl: 2, shift: 8, meta: 4, cmd: 4, command: 4 }

function buildKeyInput(body) {
  const raw = (typeof body.combo === 'string' && body.combo.trim()) || (typeof body.key === 'string' && body.key.trim()) || ''
  if (!raw) return null
  const parts = String(raw).split('+').map((s) => s.trim()).filter(Boolean)
  const keyPart = parts[parts.length - 1] || raw
  let modifiers = 0
  for (const m of parts.slice(0, -1)) modifiers |= (KEY_MODIFIERS[m.toLowerCase()] || 0)

  const named = NAMED_KEYS[keyPart.toLowerCase()]
  if (named) {
    return { key: named.key, code: named.code, windowsVirtualKeyCode: named.vk, nativeVirtualKeyCode: named.vk, text: modifiers ? '' : (named.text || ''), modifiers }
  }
  if (keyPart.length === 1) {
    const code = /[a-zA-Z]/.test(keyPart) ? `Key${keyPart.toUpperCase()}` : /[0-9]/.test(keyPart) ? `Digit${keyPart}` : ''
    const vk = keyPart.toUpperCase().charCodeAt(0)
    return { key: keyPart, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: modifiers ? '' : keyPart, modifiers }
  }
  return null
}

async function apiKey(body) {
  const input = buildKeyInput(body)
  if (!input) return apiError('validation_error', 'key or combo is required').body
  const tabId = await resolveRemoteTabId(body.tabId)
  const base = { key: input.key, code: input.code, windowsVirtualKeyCode: input.windowsVirtualKeyCode, nativeVirtualKeyCode: input.nativeVirtualKeyCode, modifiers: input.modifiers }
  const down = input.text ? { ...base, text: input.text, unmodifiedText: input.text } : base
  await remoteCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...down })
  await remoteCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  return { ok: true, pressed: true, ...input }
}

async function apiScroll(body) {
  const tabId = await resolveRemoteTabId(body.tabId)
  const direction = body.direction || 'down'
  const amount = body.amount || 800
  const js = direction === 'bottom'
    ? 'window.scrollTo(0, document.body.scrollHeight)'
    : direction === 'top'
      ? 'window.scrollTo(0, 0)'
      : `window.scrollBy(0, ${direction === 'down' ? amount : -amount})`
  await remoteCdp(tabId, 'Runtime.evaluate', { expression: js, returnByValue: true })
  return { ok: true, scrolled: true, direction }
}

async function apiSnapshot(body, searchParams) {
  const tabId = await resolveRemoteTabId(body.tabId ?? searchParams.get('tabId'))
  const format = (body.format ?? searchParams.get('format')) || 'text'
  const maxLength = parseInt(String(body.maxLength ?? searchParams.get('maxLength') ?? '100000'), 10)

  if (format === 'html') {
    let html = (await evalValue(tabId, 'document.documentElement.outerHTML')) || ''
    const truncated = html.length > maxLength
    if (truncated) html = html.slice(0, maxLength)
    return { ok: true, url: (await evalValue(tabId, 'location.href')) || '', title: (await evalValue(tabId, 'document.title')) || '', html, truncated }
  }

  const jsWithMaxLen = `var __maxLength = ${maxLength};\n${SNAPSHOT_JS}`
  const raw = await evalValue(tabId, jsWithMaxLen)
  let snapshot = '', truncated = false
  try { const parsed = JSON.parse(raw || '{}'); snapshot = parsed.snapshot || ''; truncated = parsed.truncated || false } catch { snapshot = raw || '' }
  return { ok: true, url: (await evalValue(tabId, 'location.href')) || '', title: (await evalValue(tabId, 'document.title')) || '', snapshot, truncated }
}

function base64Bytes(d) {
  const len = String(d || '').length
  if (!len) return 0
  const pad = d.endsWith('==') ? 2 : d.endsWith('=') ? 1 : 0
  return Math.floor(len * 3 / 4) - pad
}

async function apiScreenshot(body, searchParams) {
  const tabId = await resolveRemoteTabId(body.tabId ?? searchParams.get('tabId'))
  const fullPage = body.fullPage === true || searchParams.get('fullPage') === 'true'

  if (fullPage) {
    let width = null, height = null, fallbackError = null
    try {
      const metrics = await remoteCdp(tabId, 'Page.getLayoutMetrics', {})
      const size = metrics?.cssContentSize || metrics?.contentSize || metrics?.cssLayoutViewport || metrics?.layoutViewport
      const rw = Number(size?.width), rh = Number(size?.height)
      if (Number.isFinite(rw) && Number.isFinite(rh) && rw > 0 && rh > 0) {
        width = Math.ceil(rw); height = Math.ceil(rh)
        const r = await remoteCdp(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } })
        const data = r?.data || ''
        return { ok: true, data, format: 'png', fullPage: true, strategy: 'fullPageClip', width, height, bytes: base64Bytes(data) }
      }
    } catch (err) { fallbackError = err instanceof Error ? err.message : String(err) }
    const r = await remoteCdp(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    const data = r?.data || ''
    return { ok: true, data, format: 'png', fullPage: true, strategy: 'captureBeyondViewport', width, height, bytes: base64Bytes(data), fallbackError }
  }

  const r = await remoteCdp(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const data = r?.data || ''
  return { ok: true, data, format: 'png', fullPage: false, strategy: 'viewport', bytes: base64Bytes(data) }
}

// ---- Remote console / network capture ----
// Buffer CDP Log/Runtime/Network events per attached tab (in memory, capped) so
// remote /api/console and /api/network can serve them, like the local daemon does.
const MAX_CONSOLE_ENTRIES = 1000
const MAX_NETWORK_ENTRIES = 1000
const SENSITIVE_NETWORK_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'set-cookie'])
let consoleEntries = []
let networkEntries = []
let nextConsoleEntryId = 1
let nextNetworkEntryId = 1
const consoleCaptureTabs = new Set()
const networkCaptureTabs = new Set()

function boundInt(value, dflt, min, max) {
  const n = parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, n))
}

function remoteObjectValue(obj) {
  if (!obj || typeof obj !== 'object') return ''
  if ('value' in obj) return obj.value
  if ('unserializableValue' in obj) return obj.unserializableValue
  return obj.description || obj.type || ''
}

function stringifyConsoleValue(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  try { return JSON.stringify(value) } catch { return String(value) }
}

function redactNetworkHeaders(headers = {}) {
  const redacted = {}
  if (!headers || typeof headers !== 'object') return redacted
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = SENSITIVE_NETWORK_HEADERS.has(String(name).toLowerCase()) ? '[redacted]' : value
  }
  return redacted
}

function appendConsoleEntry(entry) {
  consoleEntries.push({ id: nextConsoleEntryId++, receivedAt: new Date().toISOString(), ...entry })
  if (consoleEntries.length > MAX_CONSOLE_ENTRIES) consoleEntries = consoleEntries.slice(-MAX_CONSOLE_ENTRIES)
}

function appendNetworkEntry(entry) {
  networkEntries.push({ id: nextNetworkEntryId++, receivedAt: new Date().toISOString(), ...entry })
  if (networkEntries.length > MAX_NETWORK_ENTRIES) networkEntries = networkEntries.slice(-MAX_NETWORK_ENTRIES)
}

// Called from onDebuggerEvent for every attached tab; tabId is the chrome tab id.
function captureCdpEvent(tabId, method, params = {}) {
  const base = { tabId: publicTabIdFor(tabId) }

  if (method === 'Runtime.consoleAPICalled') {
    const args = (params.args || []).map(remoteObjectValue)
    return appendConsoleEntry({ ...base, source: 'runtime', level: params.type || 'log', text: args.map(stringifyConsoleValue).join(' '), args, stackTrace: params.stackTrace || null, timestamp: params.timestamp || null })
  }
  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails || {}
    return appendConsoleEntry({ ...base, source: 'runtime', level: 'error', text: details.exception?.description || details.text || 'Uncaught exception', exceptionDetails: details, timestamp: params.timestamp || null })
  }
  if (method === 'Log.entryAdded') {
    const entry = params.entry || {}
    return appendConsoleEntry({ ...base, source: entry.source || 'log', level: entry.level || 'info', text: entry.text || '', lineNumber: entry.lineNumber, url: entry.url || '', networkRequestId: entry.networkRequestId, timestamp: entry.timestamp || null })
  }

  if (method === 'Network.requestWillBeSent') {
    const request = params.request || {}
    return appendNetworkEntry({ ...base, requestId: params.requestId || '', type: 'request', url: request.url || params.documentURL || '', method: request.method || '', documentURL: params.documentURL || '', frameId: params.frameId || '', resourceType: params.type || '', wallTime: params.wallTime ?? null, timestamp: params.timestamp ?? null, initiator: params.initiator || null, request: { url: request.url || '', method: request.method || '', headers: redactNetworkHeaders(request.headers) } })
  }
  if (method === 'Network.responseReceived') {
    const response = params.response || {}
    return appendNetworkEntry({ ...base, requestId: params.requestId || '', type: 'response', url: response.url || '', status: response.status ?? null, statusText: response.statusText || '', mimeType: response.mimeType || '', protocol: response.protocol || '', resourceType: params.type || '', timestamp: params.timestamp ?? null, response: { url: response.url || '', status: response.status ?? null, statusText: response.statusText || '', headers: redactNetworkHeaders(response.headers), mimeType: response.mimeType || '' } })
  }
  if (method === 'Network.loadingFinished') {
    return appendNetworkEntry({ ...base, requestId: params.requestId || '', type: 'finished', encodedDataLength: params.encodedDataLength ?? null, timestamp: params.timestamp ?? null })
  }
  if (method === 'Network.loadingFailed') {
    return appendNetworkEntry({ ...base, requestId: params.requestId || '', type: 'failed', resourceType: params.type || '', errorText: params.errorText || '', canceled: !!params.canceled, blockedReason: params.blockedReason || '', timestamp: params.timestamp ?? null })
  }
}

async function ensureConsoleCapture(tabId) {
  if (consoleCaptureTabs.has(tabId)) return
  await ensureRemoteAttached(tabId)
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable').catch(() => {})
  await chrome.debugger.sendCommand({ tabId }, 'Log.enable').catch(() => {})
  consoleCaptureTabs.add(tabId)
}

async function ensureNetworkCapture(tabId) {
  if (networkCaptureTabs.has(tabId)) return
  await ensureRemoteAttached(tabId)
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable').catch(() => {})
  networkCaptureTabs.add(tabId)
}

function attachedTabIds() {
  const ids = []
  for (const [id, tab] of tabs.entries()) if (tab.state === 'connected') ids.push(id)
  return ids
}

async function apiConsole(body, params) {
  const tabIdParam = body.tabId ?? params.get('tabId')
  const level = body.level ?? params.get('level')
  const limit = boundInt(body.limit ?? params.get('limit'), 100, 0, MAX_CONSOLE_ENTRIES)
  const clear = String(body.clear ?? params.get('clear')) === 'true'

  if (tabIdParam !== undefined && tabIdParam !== null && tabIdParam !== '') {
    await ensureConsoleCapture(await resolveRemoteTabId(tabIdParam)).catch(() => {})
  } else {
    await Promise.all(attachedTabIds().map((id) => ensureConsoleCapture(id).catch(() => {})))
  }

  let entries = consoleEntries
  if (tabIdParam) entries = entries.filter((e) => String(e.tabId) === String(tabIdParam))
  if (level) entries = entries.filter((e) => e.level === level)
  const total = entries.length
  const selected = limit === 0 ? [] : entries.slice(-limit)
  if (clear) { const ids = new Set(selected.map((e) => e.id)); consoleEntries = consoleEntries.filter((e) => !ids.has(e.id)) }
  return { ok: true, entries: selected, count: selected.length, total, storedTotal: consoleEntries.length }
}

async function apiConsoleClear(body) {
  const before = consoleEntries.length
  const { tabId, level } = body
  consoleEntries = consoleEntries.filter((e) => {
    if (tabId && String(e.tabId) !== String(tabId)) return true
    if (level && e.level !== level) return true
    return false
  })
  return { ok: true, cleared: before - consoleEntries.length, total: consoleEntries.length }
}

function filterNetwork(entries, f) {
  let out = entries
  if (f.tabId) out = out.filter((e) => String(e.tabId) === String(f.tabId))
  if (f.type) out = out.filter((e) => e.type === f.type)
  if (f.method) out = out.filter((e) => String(e.method || e.request?.method || '').toUpperCase() === String(f.method).toUpperCase())
  if (f.status) out = out.filter((e) => Number(e.status ?? e.response?.status) === Number(f.status))
  if (f.requestId) out = out.filter((e) => e.requestId === f.requestId)
  if (f.url) out = out.filter((e) => String(e.url || e.request?.url || e.response?.url || '').includes(f.url))
  return out
}

async function apiNetwork(body, params) {
  const f = {
    tabId: body.tabId ?? params.get('tabId') ?? undefined,
    type: body.type ?? params.get('type') ?? undefined,
    method: body.method ?? params.get('method') ?? undefined,
    status: body.status ?? params.get('status') ?? undefined,
    requestId: body.requestId ?? params.get('requestId') ?? undefined,
    url: body.url ?? params.get('url') ?? undefined,
  }
  const limit = boundInt(body.limit ?? params.get('limit'), 100, 0, MAX_NETWORK_ENTRIES)
  const clear = String(body.clear ?? params.get('clear')) === 'true'

  if (f.tabId) await ensureNetworkCapture(await resolveRemoteTabId(f.tabId)).catch(() => {})
  else await Promise.all(attachedTabIds().map((id) => ensureNetworkCapture(id).catch(() => {})))

  const matched = filterNetwork(networkEntries, f)
  const selected = limit === 0 ? [] : matched.slice(-limit)
  if (clear) { const ids = new Set(selected.map((e) => e.id)); networkEntries = networkEntries.filter((e) => !ids.has(e.id)) }
  return { ok: true, entries: selected, count: selected.length, total: matched.length, storedTotal: networkEntries.length }
}

async function apiNetworkClear(body) {
  const before = networkEntries.length
  const f = { tabId: body.tabId, type: body.type, method: body.method, status: body.status, requestId: body.requestId, url: body.url }
  if (Object.values(f).some((v) => v !== undefined && v !== null && v !== '')) {
    const ids = new Set(filterNetwork(networkEntries, f).map((e) => e.id))
    networkEntries = networkEntries.filter((e) => !ids.has(e.id))
  } else {
    networkEntries = []
  }
  return { ok: true, cleared: before - networkEntries.length, total: networkEntries.length }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'relayCheck') {
    const { url } = msg
    fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) })
      .then(async (res) => {
        const contentType = String(res.headers.get('content-type') || '')
        let json = null
        if (contentType.includes('application/json')) {
          try { json = await res.json() } catch { json = null }
        }
        sendResponse({ status: res.status, ok: res.ok, contentType, json })
      })
      .catch((err) => sendResponse({ status: 0, ok: false, error: String(err) }))
    return true
  }

  if (msg?.type === 'getStatus') {
    ;(async () => {
      await initPromise
      const port = await getRelayPort()
      const enabled = localControlEnabled
      const connected = enabled && relayWs?.readyState === WebSocket.OPEN
      const connecting = !connected && (
        enabled && (relayConnectPromise !== null ||
        relayWs?.readyState === WebSocket.CONNECTING ||
        reconnectTimer !== null)
      )
      let attachedCount = 0
      for (const t of tabs.values()) if (t.state === 'connected') attachedCount++
      const { version } = chrome.runtime.getManifest()
      const consent = await chrome.storage.local.get(['localConsentVersion', 'localConsentAcceptedAt', 'localMigrationPending'])
      sendResponse({
        enabled,
        consentRequired: !enabled,
        migrationPending: !!consent.localMigrationPending,
        connected,
        connecting,
        port,
        attachedCount,
        lastError: lastConnectError,
        version,
        daemonVersion: localBridgeCompatibility?.peerVersion || null,
        compatibility: localBridgeCompatibility,
      })
    })()
    return true
  }

  if (msg?.type === 'reconnect') {
    ;(async () => {
      const result = await connectOrToggle()
      sendResponse(result)
    })()
    return true
  }

  if (msg?.type === 'enableLocalControl') {
    ;(async () => sendResponse(await enableLocalControl()))()
    return true
  }

  if (msg?.type === 'disableLocalControl') {
    ;(async () => {
      await disableLocalControl()
      sendResponse({ ok: true })
    })()
    return true
  }

  if (msg?.type === 'downloadsPermissionChanged') {
    ;(async () => {
      const enabled = await refreshDownloadEventListeners()
      await announceLocalBridge().catch(() => false)
      sendResponse({ enabled })
    })()
    return true
  }

  if (msg?.type === 'registerRemoteHostPermissionCandidate') {
    ;(async () => {
      try {
        const host = remoteHostConfig(msg.remoteHost || DEFAULT_REMOTE_HOST)
        if (!host.requiresOptionalHostPermission) {
          sendResponse({ ok: true, origin: null })
          return
        }
        if (!await hasRemoteHostAccess(host.remoteHost)) {
          throw new Error('Remote Host permission was not granted.')
        }
        await registerRemoteHostPermissionCandidates([host.permissionOrigin])
        sendResponse({ ok: true, origin: host.permissionOrigin })
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })()
    return true
  }

  if (msg?.type === 'enableRemoteControl') {
    ;(async () => sendResponse(await enableRemoteControl(msg)))()
    return true
  }

  if (msg?.type === 'disableRemoteControl') {
    ;(async () => sendResponse(await disableRemoteControl()))()
    return true
  }

  if (msg?.type === 'retryRemoteHostPermissionCleanup') {
    ;(async () => {
      const cleanup = await cleanupRemoteHostPermissions([], currentRemotePermissionProtection())
      sendResponse({ ok: cleanup.ok, pending: cleanup.pending, lastError: cleanup.errors.join('; ') || null })
    })()
    return true
  }

  if (msg?.type === 'getRemoteControlStatus') {
    ;(async () => {
      await initPromise
      if (remoteControlEnabled && !remoteConnected()) await ensureRemoteHubConnection().catch(() => {})
      sendResponse(remoteStatusPayload())
    })()
    return true
  }

  return false
})

const initPromise = initializeExtensionState()

initPromise.then((consent) => {
  if (consent.localEnabled) {
    ensureRelayConnection().then(() => {
      reconnectAttempt = 0
      return recoverRelaySession()
    }).catch(() => { scheduleReconnect() })
  }
  if (consent.remoteEnabled) void ensureRemoteHubConnection().catch(() => {})
})

async function whenReady(fn) {
  await initPromise
  return fn()
}

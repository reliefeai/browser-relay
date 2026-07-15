// Browser Relay Extension — Universal CDP agent bridge
// Core logic adapted from openclaw auto-attach fork, stripped of gateway handshake

import { SNAPSHOT_JS } from './snapshot.js'
import { buildWaitExpression, normalizeWaitOptions } from './wait.js'

const DEFAULT_PORT = 18795
const DEFAULT_REMOTE_HOST = 'https://relay.linso.ai'
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
    setBadge(tabId, relayWs?.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
/** @type {WebSocket|null} */
let remoteWs = null
/** @type {Promise<void>|null} */
let remoteConnectPromise = null
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
    await chrome.storage.session.set({ persistedTabs: entries, nextSession })
  } catch {
    // chrome.storage.session may not be available in all contexts
  }
}

async function rehydrateState() {
  try {
    const stored = await chrome.storage.session.get(['persistedTabs', 'nextSession'])
    if (stored.nextSession) nextSession = Math.max(nextSession, stored.nextSession)
    const entries = stored.persistedTabs || []
    for (const entry of entries) {
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
        setBadge(entry.tabId, 'off')
      }
    }
  } catch {
    // Ignore rehydration errors
  }
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
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

    // The npm package ships the relay and this extension together: a version
    // mismatch means the unpacked extension files on disk were updated by an
    // npm upgrade while Chrome kept the old code in memory. Reload once per
    // relay version to pick up the new files — the guard prevents a reload
    // loop when the extension is loaded from elsewhere (e.g. a dev checkout).
    const myVersion = chrome.runtime.getManifest().version
    if (relayInfo?.version && relayInfo.version !== myVersion) {
      const stored = await chrome.storage.local.get('reloadedForRelayVersion')
      if (stored.reloadedForRelayVersion !== relayInfo.version) {
        await chrome.storage.local.set({ reloadedForRelayVersion: relayInfo.version })
        chrome.runtime.reload()
        throw new Error('Reloading extension to pick up new version')
      }
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws

    ws.onmessage = (event) => {
      if (ws !== relayWs) return
      void whenReady(() => onRelayMessage(String(event.data || '')))
    }

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = () => { clearTimeout(t); reject(new Error('WebSocket connect failed')) }
      ws.onclose = (ev) => { clearTimeout(t); reject(new Error(`WebSocket closed (${ev.code})`)) }
    })

    ws.onclose = () => { if (ws !== relayWs) return; onRelayClosed('closed') }
    ws.onerror = () => { if (ws !== relayWs) return; onRelayClosed('error') }
  })()

  try {
    await relayConnectPromise
    reconnectAttempt = 0
    lastConnectError = null
  } catch (err) {
    lastConnectError = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    relayConnectPromise = null
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
  scheduleReconnect()
}

function scheduleReconnect() {
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
      sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.attachedToTarget', params: { sessionId: tab.sessionId, targetInfo: { ...info?.targetInfo, attached: true }, waitingForDebugger: false } } })
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
  if (!chrome.downloads?.download) {
    throw new Error('chrome.downloads API unavailable. Reload the extension after granting downloads permission.')
  }
  const options = downloadOptionsFromParams(params)
  const id = await chrome.downloads.download(options)
  return { id, options }
}

async function searchBrowserDownloads(params = {}) {
  if (!chrome.downloads?.search) {
    throw new Error('chrome.downloads API unavailable. Reload the extension after granting downloads permission.')
  }

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

  const sid = nextSession++
  const sessionId = `br-tab-${sid}`

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
      sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false } } })
    } catch { /* local relay down — fine for remote mode */ }
  }

  setBadge(tabId, 'on')
  await persistState()
  return { sessionId, targetId }
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
    try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.attachedToTarget', params: { sessionId: tab.sessionId, targetInfo: { ...info?.targetInfo, attached: true }, waitingForDebugger: false } } }) } catch { /* relay may be down */ }
  } catch { /* keep previous targetId */ }
  tab.idle = false
  tab.lastActivity = Date.now()
  setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
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
  cancelReconnect()
  try {
    await ensureRelayConnection()
    await recoverRelaySession()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('Connect failed:', message)
    // Popup surfaces lastConnectError + install hint; no need to open options.
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  if (method === 'BrowserRelay.download') return await startBrowserDownload(params)
  if (method === 'BrowserRelay.searchDownloads') return await searchBrowserDownloads(params)

  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined

  // Target.createTarget spins up its own fresh tab, so it needs no existing
  // attached tab. Handle it before the guard below so it works from a cold start
  // (zero attached tabs) — otherwise the relay could never open the first tab.
  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise((r) => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
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
    sendToRelay({ method: 'forwardCDPEvent', params: { sessionId: source.sessionId || tab.sessionId, method, params } })
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

    if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
      reattachPending.delete(tabId)
      setBadge(tabId, 'error')
      void chrome.action.setTitle({ tabId, title: 'Browser Relay: relay disconnected during re-attach' })
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
  if (!tabs.has(tabId)) return
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
  const tab = tabs.get(removedTabId)
  if (!tab) return
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
  if (tabs.has(tabId)) return
  if (!isAttachableUrl(tab.url)) return
  if (tabOperationLocks.has(tabId)) return
  if (reattachPending.has(tabId)) return
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return

  tabOperationLocks.add(tabId)
  try { await attachTab(tabId) } catch (err) {
    console.warn(`Auto-attach tab ${tabId} on update failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally { tabOperationLocks.delete(tabId) }
}))

chrome.debugger.onEvent.addListener((...args) => void whenReady(() => onDebuggerEvent(...args)))
chrome.debugger.onDetach.addListener((...args) => void whenReady(() => onDebuggerDetach(...args)))

if (chrome.downloads) {
  chrome.downloads.onCreated.addListener((item) => void whenReady(() => forwardDownloadEvent('BrowserRelay.downloadCreated', { item })))
  chrome.downloads.onChanged.addListener((delta) => void whenReady(() => forwardDownloadEvent('BrowserRelay.downloadChanged', { delta })))
  chrome.downloads.onErased.addListener((downloadId) => void whenReady(() => forwardDownloadEvent('BrowserRelay.downloadErased', { id: downloadId })))
}

chrome.action.onClicked.addListener(() => void whenReady(() => connectOrToggle()))

chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => void whenReady(() => {
  if (frameId !== 0) return
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected' && !tab.idle) {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}))

chrome.tabs.onActivated.addListener(({ tabId }) => void whenReady(() => {
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected' && !tab.idle) {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}))

chrome.runtime.onInstalled.addListener(() => {
  void chrome.runtime.openOptionsPage()
})

chrome.alarms.create('relay-keepalive', { periodInMinutes: 0.5 })

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'relay-keepalive') return
  await initPromise

  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected' && !tab.idle) {
      setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
    }
  }

  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    await autoAttachAllTabs()
  }

  await softDetachIdleTabs()

  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
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

function remoteConnected() {
  return !!remoteWs && remoteWs.readyState === WebSocket.OPEN
}

function remoteWsBase(host) {
  const h = String(host || DEFAULT_REMOTE_HOST).trim().replace(/\/+$/, '')
  if (h.startsWith('https://')) return `wss://${h.slice('https://'.length)}`
  if (h.startsWith('http://')) return `ws://${h.slice('http://'.length)}`
  if (h.startsWith('wss://') || h.startsWith('ws://')) return h
  return `wss://${h}`
}

async function getRemoteConfig() {
  const s = await chrome.storage.local.get(['remoteControlEnabled', 'remoteHost', 'remoteRouteId', 'remoteSecret', 'remoteDeviceId'])
  if (!s.remoteControlEnabled || !s.remoteRouteId || !s.remoteSecret) return null
  return {
    remoteHost: s.remoteHost || DEFAULT_REMOTE_HOST,
    remoteRouteId: s.remoteRouteId,
    remoteSecret: s.remoteSecret,
    remoteDeviceId: s.remoteDeviceId,
  }
}

function remoteStatusPayload() {
  return {
    enabled: !!remoteConfig,
    connected: remoteConnected(),
    deviceId: remoteConfig?.remoteDeviceId || null,
    connectedAt: remoteConnectedAt,
    lastError: remoteLastError,
  }
}

// Browsers can't set headers on WebSocket, so the secret rides in ?token=
// (the hub accepts token OR Authorization: Bearer).
function remoteHubUrl(config) {
  const base = remoteWsBase(config.remoteHost)
  return `${base}/v1/device/connect?routeId=${encodeURIComponent(config.remoteRouteId)}&token=${encodeURIComponent(config.remoteSecret)}`
}

async function ensureRemoteHubConnection() {
  const cfg = await getRemoteConfig()
  if (!cfg) { remoteConfig = null; return false }
  remoteConfig = cfg
  if (remoteConnected()) return true
  if (remoteConnectPromise) { try { await remoteConnectPromise } catch { /* fall through */ } return remoteConnected() }

  remoteConnectPromise = (async () => {
    const ws = new WebSocket(remoteHubUrl(cfg))
    remoteWs = ws
    ws.onmessage = (event) => { void whenReady(() => handleHubMessage(String(event.data || ''))) }

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Hub connect timeout')), 8000)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = () => { clearTimeout(t); reject(new Error('Hub connect failed')) }
      ws.onclose = (ev) => { clearTimeout(t); reject(new Error(`Hub closed (${ev.code})`)) }
    })

    ws.send(JSON.stringify({
      type: 'device.hello',
      version: chrome.runtime.getManifest().version,
      routeId: cfg.remoteRouteId,
      deviceName: 'Browser Relay',
      capabilities: ['tabs', 'eval', 'wait', 'snapshot', 'click', 'type', 'key', 'scroll', 'navigate', 'screenshot', 'console', 'network'],
    }))

    ws.onclose = () => { if (ws !== remoteWs) return; onRemoteHubClosed('closed') }
    ws.onerror = () => { if (ws !== remoteWs) return; onRemoteHubClosed('error') }
  })()

  try {
    await remoteConnectPromise
    remoteReconnectAttempt = 0
    remoteConnectedAt = Date.now()
    remoteLastError = null
    return true
  } catch (err) {
    remoteLastError = err instanceof Error ? err.message : String(err)
    remoteWs = null
    scheduleRemoteReconnect()
    return false
  } finally {
    remoteConnectPromise = null
  }
}

function onRemoteHubClosed(reason) {
  remoteWs = null
  remoteConnectedAt = null
  remoteLastError = `disconnected (${reason})`
  scheduleRemoteReconnect()
}

function scheduleRemoteReconnect() {
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
  if (remoteReconnectTimer) { clearTimeout(remoteReconnectTimer); remoteReconnectTimer = null }
  remoteReconnectAttempt = 0
  const ws = remoteWs
  remoteWs = null
  remoteConnectedAt = null
  if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close() } catch { /* ignore */ } }
  if (disable) { remoteConfig = null; remoteLastError = null }
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

// Resolve the CLI's tabId param (chrome tab id, or legacy CDP targetId) to a
// chrome tab id; with no param, pick the active tab, else first attachable one.
async function resolveRemoteTabId(tabIdParam) {
  if (tabIdParam !== undefined && tabIdParam !== null && tabIdParam !== '') {
    const n = Number(tabIdParam)
    if (Number.isFinite(n)) {
      try { await chrome.tabs.get(n); return n } catch { /* not a live tab id */ }
    }
    const byTarget = getTabByTargetId(String(tabIdParam))
    if (byTarget) return byTarget
    throw new Error(`No tab matches ${tabIdParam}`)
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

  return apiError('unknown_endpoint', `Unknown or not-yet-supported remote endpoint: ${method} ${p}`, 404)
}

async function apiListTabs() {
  const list = []
  for (const t of await chrome.tabs.query({})) {
    if (!isAttachableUrl(t.url)) continue
    list.push({ id: t.id, title: t.title || '', url: t.url || '', attached: tabs.get(t.id)?.state === 'connected' })
  }
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
  const base = { tabId: String(tabId) }

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
      const port = await getRelayPort()
      const connected = relayWs?.readyState === WebSocket.OPEN
      const connecting = !connected && (
        relayConnectPromise !== null ||
        relayWs?.readyState === WebSocket.CONNECTING ||
        reconnectTimer !== null
      )
      let attachedCount = 0
      for (const t of tabs.values()) if (t.state === 'connected') attachedCount++
      const { version } = chrome.runtime.getManifest()
      sendResponse({ connected, connecting, port, attachedCount, lastError: lastConnectError, version })
    })()
    return true
  }

  if (msg?.type === 'reconnect') {
    ;(async () => {
      await connectOrToggle()
      sendResponse({ ok: true, error: lastConnectError })
    })()
    return true
  }

  // options.js drives External Control through these three messages. It has
  // already written the capability to chrome.storage.local before enabling.
  if (msg?.type === 'enableRemoteControl') {
    ;(async () => {
      closeRemoteHub() // drop any stale connection (e.g. on Regenerate)
      const connected = await ensureRemoteHubConnection()
      sendResponse({ connected, lastError: remoteLastError })
    })()
    return true
  }

  if (msg?.type === 'disableRemoteControl') {
    closeRemoteHub({ disable: true })
    sendResponse({ ok: true })
    return true
  }

  if (msg?.type === 'getRemoteControlStatus') {
    ;(async () => {
      if (!remoteConnected()) await ensureRemoteHubConnection().catch(() => {})
      sendResponse(remoteStatusPayload())
    })()
    return true
  }

  return false
})

const initPromise = rehydrateState()

initPromise.then(() => {
  ensureRelayConnection().then(() => {
    reconnectAttempt = 0
    return recoverRelaySession()
  }).catch(() => { scheduleReconnect() })
  // Restore External Control on startup if the user left it enabled.
  void ensureRemoteHubConnection().catch(() => {})
})

async function whenReady(fn) {
  await initPromise
  return fn()
}

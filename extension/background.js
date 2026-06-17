// Browser Relay Extension — Universal CDP agent bridge
// Core logic adapted from openclaw auto-attach fork, stripped of gateway handshake

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
    setBadge(tabId, relayWs?.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
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
      await reannounceAttachedTabs()
      await autoAttachAllTabs()
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
  void chrome.action.setTitle({ tabId, title: 'Browser Relay: attached (click to detach)' })

  if (!opts.skipAttachedEvent) {
    sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false } } })
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
    // The relay drops all session state when a new extension socket connects —
    // re-announce existing tabs or they vanish from the relay's tab list.
    await reannounceAttachedTabs()
    await autoAttachAllTabs()
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
  const tabId = bySession?.tabId || (targetId ? getTabByTargetId(targetId) : null) || (() => { for (const [id, tab] of tabs.entries()) { if (tab.state === 'connected') return id } return null })()

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  const activeTab = tabs.get(tabId)
  if (activeTab) {
    activeTab.lastActivity = Date.now()
    if (activeTab.state === 'connected') markTabActivity(tabId)
  }
  // createTarget spins up its own fresh tab; closeTarget/activateTarget use the
  // tabs API and need no debugger — everything else must wake an idle tab first.
  const noDebuggerMethods = method === 'Target.createTarget' || method === 'Target.closeTarget' || method === 'Target.activateTarget'
  if (activeTab?.idle && !noDebuggerMethods) {
    await wakeTab(tabId)
  }

  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try { await chrome.debugger.sendCommand(debuggee, 'Runtime.disable'); await new Promise((r) => setTimeout(r, 50)) } catch { /* ignore */ }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise((r) => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
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
      await ensureRelayConnection().catch(() => { if (!reconnectTimer) scheduleReconnect() })
    }
  }
})

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

  return false
})

const initPromise = rehydrateState()

initPromise.then(() => {
  ensureRelayConnection().then(() => {
    reconnectAttempt = 0
    return reannounceAttachedTabs().then(() => autoAttachAllTabs())
  }).catch(() => { scheduleReconnect() })
})

async function whenReady(fn) {
  await initPromise
  return fn()
}

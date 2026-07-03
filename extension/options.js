const DEFAULT_IDLE_DETACH_SECONDS = 600
const IDLE_DETACH_DEFAULT_MIGRATION_KEY = 'idleDetachDefaultMigratedTo600'
const DEFAULT_REMOTE_HOST = 'https://relay.linso.ai'

const els = {
  relayPort: document.getElementById('relayPort'),
  idleDetachSeconds: document.getElementById('idleDetachSeconds'),
  save: document.getElementById('save'),
  status: document.getElementById('status'),
  remoteToggle: document.getElementById('remoteToggle'),
  remoteState: document.getElementById('remoteState'),
  remoteDetails: document.getElementById('remoteDetails'),
  remoteHost: document.getElementById('remoteHost'),
  regenerateDevice: document.getElementById('regenerateDevice'),
  regenRow: document.getElementById('regenRow'),
  regenConfirm: document.getElementById('regenConfirm'),
  regenApply: document.getElementById('regenApply'),
  regenCancel: document.getElementById('regenCancel'),
  remoteDeviceId: document.getElementById('remoteDeviceId'),
  copyRemoteDeviceId: document.getElementById('copyRemoteDeviceId'),
  remoteCommand: document.getElementById('remoteCommand'),
  copyRemoteCommand: document.getElementById('copyRemoteCommand'),
  remoteStatus: document.getElementById('remoteStatus'),
}

function relayPortValue() {
  return parseInt(els.relayPort.value, 10) || 18795
}

function normalizeRemoteHost(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '')
  return trimmed || DEFAULT_REMOTE_HOST
}

function setStatus(el, kind, message) {
  if (!message) {
    el.className = 'status'
    el.textContent = ''
    return
  }
  el.className = `status ${kind}`
  el.textContent = message
}

function setRemoteState(kind, label) {
  els.remoteState.className = `lbl is-${kind}`
  els.remoteState.textContent = label
}

// Compact capability: `br-<secret>`. The routeId is derived from the secret
// (below) instead of stored in the id, so it never appears. secret = 96-bit.
function randomBase64Url(bytes) {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  let bin = ''
  for (const b of arr) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

// SHA-256(secret) → base64url → first 16 chars. Must match remote-protocol.deriveRouteId.
async function deriveRouteId(secret) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  let bin = ''
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '').slice(0, 16)
}

async function newRemoteCapability() {
  const secret = randomBase64Url(12)
  const routeId = await deriveRouteId(secret)
  return { routeId, secret, remoteDeviceId: `br-${secret}` }
}

function commandFor(remoteDeviceId, remoteHost) {
  return `browser-relay tabs --remote-device-id ${remoteDeviceId} --remote-host ${remoteHost}`
}

function renderRemote(config = {}) {
  const host = normalizeRemoteHost(config.remoteHost)
  const enabled = !!config.remoteControlEnabled && !!config.remoteDeviceId
  els.remoteHost.value = host
  els.remoteToggle.checked = !!config.remoteControlEnabled
  els.remoteDetails.classList.toggle('hidden', !enabled)
  showRegenConfirm(false)

  if (enabled) {
    setRemoteState('on', 'On')
    els.remoteDeviceId.textContent = config.remoteDeviceId
    els.remoteCommand.textContent = commandFor(config.remoteDeviceId, host)
    return
  }

  setRemoteState('off', 'Off')
  els.remoteDeviceId.textContent = ''
  els.remoteCommand.textContent = ''
  setStatus(els.remoteStatus, '', '')
}

async function saveLocalSettings() {
  const port = relayPortValue()
  const idleRaw = els.idleDetachSeconds.value
  let idleDetachSeconds = parseInt(idleRaw, 10)
  if (!Number.isFinite(idleDetachSeconds) || idleDetachSeconds < 0) idleDetachSeconds = DEFAULT_IDLE_DETACH_SECONDS

  await chrome.storage.local.set({ relayPort: port, idleDetachSeconds, [IDLE_DETACH_DEFAULT_MIGRATION_KEY]: true })
  return { port, idleDetachSeconds }
}

els.save.addEventListener('click', async () => {
  const { port } = await saveLocalSettings()

  const url = `http://127.0.0.1:${port}/`
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) })
    if (res.ok || res.status === 200) {
      setStatus(els.status, 'ok', 'Connected to relay server. Extension will auto-attach tabs.')
    } else {
      setStatus(els.status, 'err', `Relay server responded with status ${res.status}. Check if the server is running.`)
    }
  } catch (err) {
    setStatus(els.status, 'err', `Cannot connect to relay at ${url}. Is the server running? (${err.message})`)
  }
})

// Mint a fresh capability, persist it, and ask the background to connect to the hub.
// Shared by the toggle (turning on) and the Regenerate button.
async function enableRemote() {
  await saveLocalSettings()
  const remoteHost = normalizeRemoteHost(els.remoteHost.value)
  const { routeId, secret, remoteDeviceId } = await newRemoteCapability()

  await chrome.storage.local.set({
    remoteControlEnabled: true,
    remoteHost,
    remoteRouteId: routeId,
    remoteSecret: secret,
    remoteDeviceId,
  })
  renderRemote({ remoteControlEnabled: true, remoteHost, remoteDeviceId })
  setStatus(els.remoteStatus, 'info', 'Connecting the extension to the hub…')

  try {
    const data = await chrome.runtime.sendMessage({ type: 'enableRemoteControl', remoteHost, routeId, secret, remoteDeviceId })
    if (data?.connected) {
      setRemoteState('on', 'On')
      setStatus(els.remoteStatus, 'ok', 'Remote Relay is on and connected to the hub.')
    } else {
      setRemoteState('err', 'On')
      setStatus(els.remoteStatus, 'err', `Device ID generated, but the hub isn't connected yet: ${data?.lastError || 'unknown error'}`)
    }
  } catch (err) {
    setRemoteState('err', 'On')
    setStatus(els.remoteStatus, 'err', `Device ID generated, but the extension didn't reach the hub: ${err.message}`)
  }
}

async function disableRemote() {
  try {
    await chrome.runtime.sendMessage({ type: 'disableRemoteControl' })
  } catch {
    // Background may be waking up; still clear extension-side state.
  }
  const stored = await chrome.storage.local.get(['remoteHost'])
  await chrome.storage.local.remove(['remoteRouteId', 'remoteSecret', 'remoteDeviceId'])
  await chrome.storage.local.set({ remoteControlEnabled: false })
  renderRemote({ remoteControlEnabled: false, remoteHost: stored.remoteHost || DEFAULT_REMOTE_HOST })
  setStatus(els.remoteStatus, 'info', 'Remote Relay is off. Flip it on to generate a new Device ID.')
}

els.remoteToggle.addEventListener('change', async () => {
  els.remoteToggle.disabled = true
  try {
    if (els.remoteToggle.checked) await enableRemote()
    else await disableRemote()
  } finally {
    els.remoteToggle.disabled = false
  }
})

// Inline (not a browser confirm dialog) two-step confirmation for regenerate.
function showRegenConfirm(show) {
  els.regenRow.classList.toggle('hidden', show)
  els.regenConfirm.classList.toggle('hidden', !show)
}

els.regenerateDevice.addEventListener('click', () => showRegenConfirm(true))
els.regenCancel.addEventListener('click', () => showRegenConfirm(false))
els.regenApply.addEventListener('click', async () => {
  els.regenApply.disabled = true
  try {
    await enableRemote()
    showRegenConfirm(false)
  } finally {
    els.regenApply.disabled = false
  }
})

function flashButton(button, text = 'Copied') {
  const original = button.textContent
  button.textContent = text
  setTimeout(() => { button.textContent = original }, 1200)
}

function copyText(text, button) {
  if (!text) return
  navigator.clipboard.writeText(text).then(() => {
    if (button) flashButton(button)
  }).catch(() => {})
}

els.copyRemoteDeviceId.addEventListener('click', () => copyText(els.remoteDeviceId.textContent.trim(), els.copyRemoteDeviceId))
els.remoteDeviceId.addEventListener('click', () => copyText(els.remoteDeviceId.textContent.trim(), els.copyRemoteDeviceId))
els.remoteCommand.addEventListener('click', () => copyText(els.remoteCommand.textContent.trim(), els.copyRemoteCommand))
els.copyRemoteCommand.addEventListener('click', () => copyText(els.remoteCommand.textContent.trim(), els.copyRemoteCommand))

chrome.storage.local.get([
  'relayPort',
  'idleDetachSeconds',
  IDLE_DETACH_DEFAULT_MIGRATION_KEY,
  'remoteControlEnabled',
  'remoteHost',
  'remoteDeviceId',
], async (result) => {
  if (result.relayPort) els.relayPort.value = result.relayPort

  let idleDetachSeconds = result.idleDetachSeconds
  if (Number.parseInt(String(idleDetachSeconds), 10) === 30 && !result[IDLE_DETACH_DEFAULT_MIGRATION_KEY]) {
    idleDetachSeconds = DEFAULT_IDLE_DETACH_SECONDS
    await chrome.storage.local.set({
      idleDetachSeconds,
      [IDLE_DETACH_DEFAULT_MIGRATION_KEY]: true,
    })
  }

  if (result.idleDetachSeconds !== undefined && result.idleDetachSeconds !== null) {
    els.idleDetachSeconds.value = idleDetachSeconds
  }

  renderRemote({
    remoteControlEnabled: !!result.remoteControlEnabled,
    remoteHost: result.remoteHost || DEFAULT_REMOTE_HOST,
    remoteDeviceId: result.remoteDeviceId,
  })

  if (!result.remoteControlEnabled) return

  try {
    const data = await chrome.runtime.sendMessage({ type: 'getRemoteControlStatus' })
    setRemoteState(data?.connected ? 'on' : 'err', 'On')
    setStatus(els.remoteStatus, data?.connected ? 'ok' : 'err', data?.connected ? 'Remote Relay is on and connected.' : `Remote Relay is on but disconnected: ${data?.lastError || 'not connected'}`)
  } catch {
    setRemoteState('err', 'On')
    setStatus(els.remoteStatus, 'err', 'Remote Relay is on, but the extension background is not responding yet.')
  }
})

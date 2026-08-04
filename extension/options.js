import {
  hasCurrentLocalConsent,
  hasCurrentRemoteDisclosure,
  hasRemoteCapability,
} from './consent.js'
import { DEFAULT_REMOTE_HOST, remoteHostConfig } from './remote-host.js'

const DEFAULT_IDLE_DETACH_SECONDS = 600
const IDLE_DETACH_DEFAULT_MIGRATION_KEY = 'idleDetachDefaultMigratedTo600'
const t = (key) => window.I18N.t(key)

const els = {
  relayPort: document.getElementById('relayPort'),
  idleDetachSeconds: document.getElementById('idleDetachSeconds'),
  uiLang: document.getElementById('uiLang'),
  save: document.getElementById('save'),
  status: document.getElementById('status'),
  localToggle: document.getElementById('localToggle'),
  localState: document.getElementById('localState'),
  localConsent: document.getElementById('localConsent'),
  localConsentCheck: document.getElementById('localConsentCheck'),
  localConsentApply: document.getElementById('localConsentApply'),
  localConsentCancel: document.getElementById('localConsentCancel'),
  downloadsToggle: document.getElementById('downloadsToggle'),
  downloadsStatus: document.getElementById('downloadsStatus'),
  remoteToggle: document.getElementById('remoteToggle'),
  remoteState: document.getElementById('remoteState'),
  remoteDetails: document.getElementById('remoteDetails'),
  remoteHost: document.getElementById('remoteHost'),
  remoteDisclosure: document.getElementById('remoteDisclosure'),
  remoteDisclosureCheck: document.getElementById('remoteDisclosureCheck'),
  remoteDisclosureApply: document.getElementById('remoteDisclosureApply'),
  remoteDisclosureCancel: document.getElementById('remoteDisclosureCancel'),
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
  retryRemotePermissionCleanup: document.getElementById('retryRemotePermissionCleanup'),
}

function relayPortValue() {
  return parseInt(els.relayPort.value, 10) || 18795
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

function setState(el, kind, label) {
  el.className = `lbl is-${kind}`
  el.textContent = label
}

function showLocalConsent(show) {
  els.localConsent.classList.toggle('hidden', !show)
  if (!show) els.localConsentCheck.checked = false
}

function renderLocal(enabled) {
  els.localToggle.checked = !!enabled
  setState(els.localState, enabled ? 'on' : 'off', t(enabled ? 'stateOn' : 'stateOff'))
  if (enabled) showLocalConsent(false)
}

function formatMessage(key, values = {}) {
  return Object.entries(values).reduce(
    (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
    t(key),
  )
}

function connectedLocalMessage(status) {
  const compatibility = status?.compatibility
  if (
    compatibility?.compatible !== false
    && compatibility?.versionMismatch
    && status?.version
    && status?.daemonVersion
  ) {
    return formatMessage('statusConnectedLocalVersionMismatch', {
      extensionVersion: status.version,
      daemonVersion: status.daemonVersion,
      protocolVersion: compatibility.selected || '?',
    })
  }
  return t('statusConnectedLocal')
}

async function currentLocalStatus(fallback = null) {
  try {
    return await chrome.runtime.sendMessage({ type: 'getStatus' }) || fallback
  } catch {
    return fallback
  }
}

async function saveLocalSettings() {
  const port = relayPortValue()
  let idleDetachSeconds = parseInt(els.idleDetachSeconds.value, 10)
  if (!Number.isFinite(idleDetachSeconds) || idleDetachSeconds < 0) idleDetachSeconds = DEFAULT_IDLE_DETACH_SECONDS
  await chrome.storage.local.set({ relayPort: port, idleDetachSeconds, [IDLE_DETACH_DEFAULT_MIGRATION_KEY]: true })
  return { port, idleDetachSeconds }
}

async function prepareLoopbackAccess(port) {
  setStatus(els.status, 'info', t('statusRequestingLoopback'))
  try {
    // Chrome 142+ gates loopback fetch/WebSocket access behind Local Network
    // Access. An extension service worker cannot raise that prompt by itself,
    // so probe from this visible Options document while the user is explicitly
    // enabling Local Relay. Older Chrome versions simply perform the fetch.
    const response = await fetch(`http://127.0.0.1:${port}/api/debug`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || data?.ok !== true || typeof data?.version !== 'string') {
      throw new Error(`unexpected response${response.status ? ` (HTTP ${response.status})` : ''}`)
    }
    return data
  } catch (error) {
    throw new Error(`${t('statusLoopbackDenied')} (${error instanceof Error ? error.message : String(error)})`)
  }
}

async function enableLocal() {
  if (!els.localConsentCheck.checked) {
    setStatus(els.status, 'err', t('statusConsentRequired'))
    return
  }

  els.localConsentApply.disabled = true
  try {
    const { port } = await saveLocalSettings()
    await prepareLoopbackAccess(port)
    setStatus(els.status, 'info', t('statusConnectingLocal'))
    const data = await chrome.runtime.sendMessage({ type: 'enableLocalControl' })
    if (data?.superseded) {
      const current = await currentLocalStatus(data)
      renderLocal(current?.enabled === true)
      setStatus(
        els.status,
        current?.connected ? 'ok' : 'info',
        current?.connected ? connectedLocalMessage(current) : t('statusConnectingLocal'),
      )
      return
    }
    renderLocal(data?.connected === true)
    const current = data?.connected ? await currentLocalStatus(data) : data
    setStatus(
      els.status,
      data?.connected ? 'ok' : 'err',
      data?.connected ? connectedLocalMessage(current) : `${t('statusRelayUnreachable')} (${data?.lastError || 'unknown error'})`,
    )
  } catch (error) {
    renderLocal(false)
    setStatus(els.status, 'err', `${t('statusRelayUnreachable')} (${error.message})`)
  } finally {
    els.localConsentApply.disabled = false
  }
}

async function disableLocal() {
  els.localToggle.disabled = true
  try {
    const result = await chrome.runtime.sendMessage({ type: 'disableLocalControl' })
    if (result?.superseded) {
      const current = await currentLocalStatus(result)
      renderLocal(current?.enabled === true)
      setStatus(
        els.status,
        current?.connected ? 'ok' : 'info',
        current?.connected ? connectedLocalMessage(current) : t('statusConnectingLocal'),
      )
      return
    }
    renderLocal(false)
    setStatus(els.status, 'info', t('statusLocalOff'))
  } catch (error) {
    setStatus(els.status, 'err', error.message)
  } finally {
    els.localToggle.disabled = false
  }
}

els.localToggle.addEventListener('change', async () => {
  if (els.localToggle.checked) {
    els.localToggle.checked = false
    showLocalConsent(true)
    setStatus(els.status, 'info', t('statusReviewLocalConsent'))
  } else {
    await disableLocal()
  }
})

els.localConsentApply.addEventListener('click', enableLocal)
els.localConsentCancel.addEventListener('click', async () => {
  await chrome.storage.local.set({ localOnboardingPending: false }).catch(() => {})
  showLocalConsent(false)
  setStatus(els.status, 'info', t('statusLocalOff'))
})

els.save.addEventListener('click', async () => {
  await saveLocalSettings()
  if (!els.localToggle.checked) {
    setStatus(els.status, 'info', t('statusSettingsSaved'))
    return
  }
  setStatus(els.status, 'info', t('statusConnectingLocal'))
  try {
    const data = await chrome.runtime.sendMessage({ type: 'reconnect' })
    const current = data?.ok ? await currentLocalStatus(data) : data
    setStatus(els.status, data?.ok ? 'ok' : 'err', data?.ok ? connectedLocalMessage(current) : (data?.error || t('statusRelayUnreachable')))
  } catch (error) {
    setStatus(els.status, 'err', error.message)
  }
})

async function refreshDownloadsState(message = '') {
  const enabled = await chrome.permissions.contains({ permissions: ['downloads'] })
  els.downloadsToggle.checked = enabled
  if (message) setStatus(els.downloadsStatus, enabled ? 'ok' : 'info', message)
  return enabled
}

els.downloadsToggle.addEventListener('change', async () => {
  els.downloadsToggle.disabled = true
  try {
    let enabled
    if (els.downloadsToggle.checked) {
      // Keep request() directly inside this user gesture; Chrome rejects
      // optional permission prompts initiated later by background work.
      enabled = await chrome.permissions.request({ permissions: ['downloads'] })
    } else {
      await chrome.permissions.remove({ permissions: ['downloads'] })
      enabled = false
    }
    await chrome.runtime.sendMessage({ type: 'downloadsPermissionChanged' }).catch(() => {})
    await refreshDownloadsState(enabled ? t('statusDownloadsOn') : t('statusDownloadsOff'))
  } finally {
    els.downloadsToggle.disabled = false
  }
})

// Compact capability: `br-<secret>`. routeId is derived rather than exposed.
function randomBase64Url(bytes) {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  let bin = ''
  for (const b of arr) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

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

function safeRemoteHost(value) {
  try { return remoteHostConfig(value).remoteHost } catch { return String(value || DEFAULT_REMOTE_HOST) }
}

function showRemoteDisclosure(show) {
  els.remoteDisclosure.classList.toggle('hidden', !show)
  if (!show) els.remoteDisclosureCheck.checked = false
}

function showRegenConfirm(show) {
  els.regenRow.classList.toggle('hidden', show)
  els.regenConfirm.classList.toggle('hidden', !show)
}

function renderRemote(config = {}) {
  const host = safeRemoteHost(config.remoteHost)
  const enabled = !!config.remoteControlEnabled && !!config.remoteDeviceId
  els.remoteHost.value = host
  els.remoteToggle.checked = enabled
  els.remoteDetails.classList.toggle('hidden', !enabled)
  showRegenConfirm(false)

  if (enabled) {
    setState(els.remoteState, 'on', t('stateOn'))
    els.remoteDeviceId.textContent = config.remoteDeviceId
    els.remoteCommand.textContent = commandFor(config.remoteDeviceId, host)
  } else {
    setState(els.remoteState, 'off', t('stateOff'))
    els.remoteDeviceId.textContent = ''
    els.remoteCommand.textContent = ''
  }
}

function renderPermissionCleanup(pending, error = '') {
  els.retryRemotePermissionCleanup.classList.toggle('hidden', !pending)
  if (pending) {
    setStatus(els.remoteStatus, 'err', `${t('statusPermissionCleanupPending')}${error ? ` ${error}` : ''}`)
  }
}

async function currentRemoteConfig() {
  const stored = await chrome.storage.local.get([
    'remoteControlEnabled',
    'remoteHost',
    'remoteRouteId',
    'remoteSecret',
    'remoteDeviceId',
    'remoteDisclosureVersion',
    'remoteDisclosureAcceptedAt',
  ])
  if (!stored.remoteControlEnabled || !hasCurrentRemoteDisclosure(stored) || !hasRemoteCapability(stored)) return null
  return stored
}

async function connectRemoteCapability(host, capability) {
  return await chrome.runtime.sendMessage({
    type: 'enableRemoteControl',
    disclosureConfirmed: true,
    remoteHost: host.remoteHost,
    ...capability,
  })
}

async function enableRemote() {
  let host
  try {
    host = remoteHostConfig(els.remoteHost.value)
  } catch (error) {
    setStatus(els.remoteStatus, 'err', error.message)
    return false
  }

  let hostPermissionGranted = true
  if (host.requiresOptionalHostPermission) {
    // Request the exact self-hosted origin from this click, never blanket host access.
    hostPermissionGranted = await chrome.permissions.request({ origins: [host.permissionOrigin] })
  }
  if (!hostPermissionGranted) {
    setStatus(els.remoteStatus, 'err', t('statusRemoteHostPermissionDenied'))
    return false
  }
  if (host.requiresOptionalHostPermission) {
    const registered = await chrome.runtime.sendMessage({
      type: 'registerRemoteHostPermissionCandidate',
      remoteHost: host.remoteHost,
    }).catch((error) => ({ ok: false, error: error.message }))
    if (!registered?.ok) {
      let stillGranted = true
      try {
        await chrome.permissions.remove({ origins: [host.permissionOrigin] })
        stillGranted = await chrome.permissions.contains({ origins: [host.permissionOrigin] })
        await chrome.runtime.sendMessage({ type: 'retryRemoteHostPermissionCleanup' }).catch(() => {})
      } catch { /* surface the unverified permission below */ }
      if (stillGranted) renderPermissionCleanup(true, registered?.error || '')
      setStatus(
        els.remoteStatus,
        'err',
        `${t('statusRemoteHostRegistrationFailed')} ${registered?.error || ''}`.trim(),
      )
      return false
    }
  }

  const capability = await newRemoteCapability()
  setStatus(els.remoteStatus, 'info', t('statusConnectingHub'))
  const data = await connectRemoteCapability(host, capability).catch((error) => ({ connected: false, lastError: error.message }))

  if (data?.connected) {
    renderRemote({ remoteControlEnabled: true, remoteHost: host.remoteHost, remoteDeviceId: capability.remoteDeviceId })
    showRemoteDisclosure(false)
    if (data.permissionCleanupPending) renderPermissionCleanup(true, data.permissionCleanupErrors?.join('; ') || '')
    else {
      renderPermissionCleanup(false)
      setStatus(els.remoteStatus, 'ok', t('statusRemoteConnected'))
    }
    return true
  }

  const failure = data?.lastError || 'unknown error'
  const finalConfig = await currentRemoteConfig()
  renderRemote(finalConfig || { remoteControlEnabled: false, remoteHost: host.remoteHost })
  showRemoteDisclosure(false)
  if (data?.permissionCleanupPending) {
    renderPermissionCleanup(true, data.permissionCleanupErrors?.join('; ') || '')
  } else if (finalConfig || data?.restored) {
    renderPermissionCleanup(false)
    setStatus(els.remoteStatus, 'err', `${t('statusRemoteRegenerateFailed')} ${failure}`)
  } else {
    renderPermissionCleanup(false)
    setStatus(els.remoteStatus, 'err', `${t('statusRemoteNoReach')}${failure}`)
  }
  return false
}

async function disableRemote() {
  const stored = await chrome.storage.local.get(['remoteHost'])
  const data = await chrome.runtime.sendMessage({ type: 'disableRemoteControl' }).catch((error) => ({ ok: false, permissionCleanupPending: true, lastError: error.message }))
  if (data?.superseded) {
    const current = await currentRemoteConfig()
    renderRemote(current || { remoteControlEnabled: false, remoteHost: stored.remoteHost || DEFAULT_REMOTE_HOST })
    setStatus(els.remoteStatus, 'info', current ? t('statusConnectingHub') : t('statusRemoteOff'))
    return
  }
  renderRemote({ remoteControlEnabled: false, remoteHost: stored.remoteHost || DEFAULT_REMOTE_HOST })
  showRemoteDisclosure(false)
  if (data.permissionCleanupPending) renderPermissionCleanup(true, data.lastError || '')
  else {
    renderPermissionCleanup(false)
    setStatus(els.remoteStatus, 'info', t('statusRemoteOff'))
  }
}

els.remoteToggle.addEventListener('change', async () => {
  if (els.remoteToggle.checked) {
    els.remoteToggle.checked = false
    showRemoteDisclosure(true)
    setStatus(els.remoteStatus, 'info', t('statusReviewRemoteDisclosure'))
  } else {
    els.remoteToggle.disabled = true
    try { await disableRemote() } finally { els.remoteToggle.disabled = false }
  }
})

els.remoteDisclosureApply.addEventListener('click', async () => {
  if (!els.remoteDisclosureCheck.checked) {
    setStatus(els.remoteStatus, 'err', t('statusConsentRequired'))
    return
  }
  els.remoteDisclosureApply.disabled = true
  try { await enableRemote() } finally { els.remoteDisclosureApply.disabled = false }
})

els.remoteDisclosureCancel.addEventListener('click', () => {
  showRemoteDisclosure(false)
  setStatus(els.remoteStatus, 'info', t('statusRemoteOff'))
})

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

els.retryRemotePermissionCleanup.addEventListener('click', async () => {
  els.retryRemotePermissionCleanup.disabled = true
  try {
    const result = await chrome.runtime.sendMessage({ type: 'retryRemoteHostPermissionCleanup' })
    renderPermissionCleanup(!result?.ok, result?.lastError || '')
    if (result?.ok) setStatus(els.remoteStatus, 'ok', t('statusPermissionCleanupDone'))
  } catch (error) {
    renderPermissionCleanup(true, error.message)
  } finally {
    els.retryRemotePermissionCleanup.disabled = false
  }
})

function flashButton(button, text) {
  const original = button.textContent
  button.textContent = text || t('copied')
  setTimeout(() => { button.textContent = original }, 1200)
}

function copyText(value, button) {
  if (!value) return
  navigator.clipboard.writeText(value).then(() => { if (button) flashButton(button) }).catch(() => {})
}

els.copyRemoteDeviceId.addEventListener('click', () => copyText(els.remoteDeviceId.textContent.trim(), els.copyRemoteDeviceId))
els.remoteDeviceId.addEventListener('click', () => copyText(els.remoteDeviceId.textContent.trim(), els.copyRemoteDeviceId))
els.remoteCommand.addEventListener('click', () => copyText(els.remoteCommand.textContent.trim(), els.copyRemoteCommand))
els.copyRemoteCommand.addEventListener('click', () => copyText(els.remoteCommand.textContent.trim(), els.copyRemoteCommand))

els.uiLang.addEventListener('change', async () => {
  await chrome.storage.local.set({ uiLang: els.uiLang.value })
  await initFromStorage()
})

async function initFromStorage() {
  const result = await chrome.storage.local.get([
    'relayPort',
    'idleDetachSeconds',
    IDLE_DETACH_DEFAULT_MIGRATION_KEY,
    'localControlEnabled',
    'localConsentVersion',
    'localConsentAcceptedAt',
    'localMigrationPending',
    'localOnboardingPending',
    'remoteControlEnabled',
    'remoteDisclosureVersion',
    'remoteDisclosureAcceptedAt',
    'remoteMigrationPending',
    'remoteHostPermissionCleanupOrigins',
    'remoteHost',
    'remoteRouteId',
    'remoteSecret',
    'remoteDeviceId',
    'uiLang',
  ])

  window.I18N.setLang(result.uiLang || 'auto')
  els.uiLang.value = result.uiLang || 'auto'
  window.I18N.apply()

  if (result.relayPort) els.relayPort.value = result.relayPort
  let idleDetachSeconds = result.idleDetachSeconds
  if (Number.parseInt(String(idleDetachSeconds), 10) === 30 && !result[IDLE_DETACH_DEFAULT_MIGRATION_KEY]) {
    idleDetachSeconds = DEFAULT_IDLE_DETACH_SECONDS
    await chrome.storage.local.set({ idleDetachSeconds, [IDLE_DETACH_DEFAULT_MIGRATION_KEY]: true })
  }
  if (idleDetachSeconds !== undefined && idleDetachSeconds !== null) els.idleDetachSeconds.value = idleDetachSeconds

  const localConsentCurrent = hasCurrentLocalConsent(result)
  const localEnabled = result.localControlEnabled === true && localConsentCurrent
  renderLocal(localEnabled)
  if (result.localMigrationPending) {
    showLocalConsent(true)
    setStatus(els.status, 'info', t('statusLocalMigration'))
  } else if (result.localOnboardingPending && !localConsentCurrent) {
    showLocalConsent(true)
    setStatus(els.status, 'info', t('statusReviewLocalConsent'))
  } else if (localEnabled) {
    try {
      const data = await chrome.runtime.sendMessage({ type: 'getStatus' })
      setStatus(els.status, data?.connected ? 'ok' : 'err', data?.connected ? connectedLocalMessage(data) : (data?.lastError || t('statusRelayUnreachable')))
    } catch {
      setStatus(els.status, 'err', t('statusBackgroundOffline'))
    }
  } else {
    setStatus(els.status, 'info', t('statusLocalOff'))
  }

  await refreshDownloadsState()

  const remoteEnabled = result.remoteControlEnabled === true
    && hasCurrentRemoteDisclosure(result)
    && hasRemoteCapability(result)
  renderRemote({
    remoteControlEnabled: remoteEnabled,
    remoteHost: result.remoteHost || DEFAULT_REMOTE_HOST,
    remoteDeviceId: result.remoteDeviceId,
  })
  if (result.remoteMigrationPending) {
    setStatus(els.remoteStatus, 'info', t('statusRemoteMigration'))
  } else if (remoteEnabled) {
    try {
      const data = await chrome.runtime.sendMessage({ type: 'getRemoteControlStatus' })
      setState(els.remoteState, data?.connected ? 'on' : 'err', t('stateOn'))
      setStatus(els.remoteStatus, data?.connected ? 'ok' : 'err', data?.connected ? t('statusRemoteConnectedShort') : t('statusRemoteDisconnected') + (data?.lastError || 'not connected'))
    } catch {
      setState(els.remoteState, 'err', t('stateOn'))
      setStatus(els.remoteStatus, 'err', t('statusRemoteBgOffline'))
    }
  } else if (!result.remoteMigrationPending) {
    setStatus(els.remoteStatus, 'info', t('statusRemoteOff'))
  }
  if (Array.isArray(result.remoteHostPermissionCleanupOrigins) && result.remoteHostPermissionCleanupOrigins.length) {
    renderPermissionCleanup(true)
  } else {
    els.retryRemotePermissionCleanup.classList.add('hidden')
  }
}

initFromStorage()

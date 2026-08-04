const t = (key) => window.I18N.t(key)

const els = {
  dot: document.getElementById('dot'),
  label: document.getElementById('label'),
  meta: document.getElementById('meta'),
  reconnect: document.getElementById('reconnect'),
  options: document.getElementById('options'),
  install: document.getElementById('install'),
  version: document.getElementById('version'),
  docs: document.getElementById('docs'),
  cmd1: document.getElementById('cmd1'),
  cmd2: document.getElementById('cmd2'),
}

let lastState = null

function render(state) {
  lastState = state
  const { enabled, connected, connecting, port, attachedCount, lastError, version, migrationPending } = state
  const host = `127.0.0.1:${port}`

  if (!enabled) {
    els.dot.className = 'dot off'
    els.label.textContent = t('popupPermissionRequired')
    els.meta.textContent = t(migrationPending ? 'popupMigrationRequired' : 'popupPermissionHint')
    els.install.classList.remove('show')
    els.reconnect.textContent = t('popupReviewAccess')
  } else if (connected) {
    els.dot.className = 'dot on'
    els.label.textContent = t('popupConnected')
    const versionDiagnostic = state.compatibility?.versionMismatch && state.daemonVersion
      ? ` · v${version} ↔ ${t('popupDaemon')} v${state.daemonVersion}`
      : ''
    els.meta.textContent = `${host} · ${attachedCount} ${t('popupTabsAttached')}${versionDiagnostic}`
    els.install.classList.remove('show')
    els.reconnect.textContent = t('popupReattach')
  } else if (connecting) {
    els.dot.className = 'dot connecting'
    els.label.textContent = t('popupConnecting')
    els.meta.textContent = t('popupTrying') + host
    els.install.classList.remove('show')
    els.reconnect.textContent = t('popupRetry')
  } else {
    els.dot.className = 'dot err'
    els.label.textContent = t('popupNotConnected')
    els.meta.textContent = lastError || (t('popupNoRelay') + host)
    els.install.classList.add('show')
    els.reconnect.textContent = t('popupRetry')
  }

  els.version.textContent = version ? `v${version}` : ''
}

async function fetchStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'getStatus' })
    if (res) render(res)
  } catch {
    // background may be waking up
  }
}

els.reconnect.addEventListener('click', async () => {
  if (!lastState?.enabled) {
    chrome.runtime.openOptionsPage()
    return
  }
  els.dot.className = 'dot connecting'
  els.label.textContent = t('popupConnecting')
  els.meta.textContent = ''
  try { await chrome.runtime.sendMessage({ type: 'reconnect' }) } catch {}
  setTimeout(fetchStatus, 500)
  setTimeout(fetchStatus, 1500)
})

els.options.addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
})

els.docs.addEventListener('click', (e) => {
  e.preventDefault()
  chrome.tabs.create({ url: 'https://www.npmjs.com/package/@linsoai/browser-relay' })
})

function copyCmd(el) {
  navigator.clipboard.writeText(el.textContent.trim()).then(() => {
    el.classList.add('copied')
    setTimeout(() => el.classList.remove('copied'), 1200)
  }).catch(() => {})
}

els.cmd1.addEventListener('click', () => copyCmd(els.cmd1))
els.cmd2.addEventListener('click', () => copyCmd(els.cmd2))

;(async () => {
  const { uiLang } = await chrome.storage.local.get(['uiLang'])
  window.I18N.setLang(uiLang || 'auto')
  window.I18N.apply()
  fetchStatus()
})()
const pollTimer = setInterval(fetchStatus, 1500)
window.addEventListener('unload', () => clearInterval(pollTimer))

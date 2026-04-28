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

function render(state) {
  const { connected, connecting, port, attachedCount, lastError, version } = state
  const host = `127.0.0.1:${port}`

  if (connected) {
    els.dot.className = 'dot on'
    els.label.textContent = 'Connected'
    els.meta.textContent = `${host} · ${attachedCount} tab${attachedCount === 1 ? '' : 's'} attached`
    els.install.classList.remove('show')
    els.reconnect.textContent = 'Re-attach tabs'
  } else if (connecting) {
    els.dot.className = 'dot connecting'
    els.label.textContent = 'Connecting…'
    els.meta.textContent = `Trying ${host}`
    els.install.classList.remove('show')
    els.reconnect.textContent = 'Retry'
  } else {
    els.dot.className = 'dot err'
    els.label.textContent = 'Not connected'
    els.meta.textContent = lastError || `No relay server on ${host}`
    els.install.classList.add('show')
    els.reconnect.textContent = 'Retry'
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
  els.dot.className = 'dot connecting'
  els.label.textContent = 'Connecting…'
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

fetchStatus()
const pollTimer = setInterval(fetchStatus, 1500)
window.addEventListener('unload', () => clearInterval(pollTimer))

const t = (key) => window.I18N.t(key)

const els = {
  dot: document.getElementById('dot'),
  label: document.getElementById('label'),
  meta: document.getElementById('meta'),
  localToggle: document.getElementById('localToggle'),
  reconnect: document.getElementById('reconnect'),
  options: document.getElementById('options'),
  install: document.getElementById('install'),
  version: document.getElementById('version'),
  docs: document.getElementById('docs'),
  cmd1: document.getElementById('cmd1'),
  cmd2: document.getElementById('cmd2'),
}

function render(state) {
  const { enabled = true, connected, connecting, port, attachedCount, lastError, version } = state
  const host = `127.0.0.1:${port}`
  if (!els.localToggle.disabled) els.localToggle.checked = enabled

  if (!enabled) {
    els.dot.className = 'dot off'
    els.label.textContent = t('popupDisabled')
    els.meta.textContent = t('popupDisabledMeta')
    els.install.classList.remove('show')
    els.reconnect.textContent = t('popupEnable')
  } else if (connected) {
    els.dot.className = 'dot on'
    els.label.textContent = t('popupConnected')
    els.meta.textContent = `${host} · ${attachedCount} ${t('popupTabsAttached')}`
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
    const {tasks=[],claims=[]} = await chrome.runtime.sendMessage({type:'getAutomationTasks'})
    document.getElementById('sessions').hidden=claims.length===0
    const owners=new Map()
    for(const claim of claims){const group=owners.get(claim.sessionId)||{label:claim.label||claim.sessionId,count:0};group.count++;owners.set(claim.sessionId,group)}
    const list=document.getElementById('session-list');list.replaceChildren()
    for(const [sessionId,group] of owners){
      const row=document.createElement('div');row.className='session'
      const label=document.createElement('span');label.textContent=`${group.label} · ${group.count} ${t('popupTabsAttached')}`
      const stop=document.createElement('button');stop.textContent=t('popupStopSession');stop.addEventListener('click',async()=>{stop.disabled=true;await chrome.runtime.sendMessage({type:'stopAutomationSession',sessionId});await fetchStatus()})
      row.append(label,stop);list.append(row)
    }
    document.getElementById('task-controls').hidden = tasks.length === 0
    document.getElementById('task-status').textContent = `${tasks.length} ${t('popupActiveTasks')}`
  } catch {
    // background may be waking up
  }
}

els.localToggle.addEventListener('change', async () => {
  els.localToggle.disabled = true
  try {
    if (els.localToggle.checked) {
      els.dot.className = 'dot connecting'
      els.label.textContent = t('popupConnecting')
      els.meta.textContent = ''
      try { await chrome.runtime.sendMessage({ type: 'enableLocalRelay' }) } catch {}
    } else {
      try { await chrome.runtime.sendMessage({ type: 'disableLocalRelay' }) } catch {}
    }
  } finally {
    els.localToggle.disabled = false
  }
  setTimeout(fetchStatus, 300)
  setTimeout(fetchStatus, 1500)
})

els.reconnect.addEventListener('click', async () => {
  if (!els.localToggle.checked) {
    els.localToggle.checked = true
    els.localToggle.dispatchEvent(new Event('change'))
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

document.getElementById('cancel-tasks').addEventListener('click',async()=>{
  await chrome.runtime.sendMessage({type:'cancelAutomationTasks'})
  document.getElementById('task-status').textContent=t('popupCancellingTasks')
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

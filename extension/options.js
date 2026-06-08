const DEFAULT_IDLE_DETACH_SECONDS = 600
const IDLE_DETACH_DEFAULT_MIGRATION_KEY = 'idleDetachDefaultMigratedTo600'

document.getElementById('save').addEventListener('click', async () => {
  const port = parseInt(document.getElementById('relayPort').value, 10) || 18795
  const statusEl = document.getElementById('status')

  const idleRaw = document.getElementById('idleDetachSeconds').value
  let idleDetachSeconds = parseInt(idleRaw, 10)
  if (!Number.isFinite(idleDetachSeconds) || idleDetachSeconds < 0) idleDetachSeconds = DEFAULT_IDLE_DETACH_SECONDS

  await chrome.storage.local.set({ relayPort: port, idleDetachSeconds, [IDLE_DETACH_DEFAULT_MIGRATION_KEY]: true })

  // Test connection
  const url = `http://127.0.0.1:${port}/`
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) })
    if (res.ok || res.status === 200) {
      statusEl.className = 'status ok'
      statusEl.textContent = 'Connected to relay server. Extension will auto-attach tabs.'
    } else {
      statusEl.className = 'status err'
      statusEl.textContent = `Relay server responded with status ${res.status}. Check if the server is running.`
    }
  } catch (err) {
    statusEl.className = 'status err'
    statusEl.textContent = `Cannot connect to relay at ${url}. Is the server running? (${err.message})`
  }
})

// Load saved settings
chrome.storage.local.get(['relayPort', 'idleDetachSeconds', IDLE_DETACH_DEFAULT_MIGRATION_KEY], async (result) => {
  if (result.relayPort) document.getElementById('relayPort').value = result.relayPort

  let idleDetachSeconds = result.idleDetachSeconds
  if (Number.parseInt(String(idleDetachSeconds), 10) === 30 && !result[IDLE_DETACH_DEFAULT_MIGRATION_KEY]) {
    idleDetachSeconds = DEFAULT_IDLE_DETACH_SECONDS
    await chrome.storage.local.set({
      idleDetachSeconds,
      [IDLE_DETACH_DEFAULT_MIGRATION_KEY]: true,
    })
  }

  if (result.idleDetachSeconds !== undefined && result.idleDetachSeconds !== null) {
    document.getElementById('idleDetachSeconds').value = idleDetachSeconds
  }
})

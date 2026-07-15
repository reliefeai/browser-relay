export function createRemoteAuthMessageHandler({ onAuthenticated, onMessage }) {
  let authenticated = false

  return (text) => {
    let msg
    try { msg = JSON.parse(String(text || '')) } catch { return }

    if (!authenticated) {
      if (msg?.type !== 'device.authenticated') return
      authenticated = true
      onAuthenticated()
      return
    }

    if (msg?.type === 'device.authenticated') return
    onMessage(String(text || ''), msg)
  }
}

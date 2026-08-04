export const DEFAULT_REMOTE_HOST = 'https://relay.linso.ai'

const REQUIRED_REMOTE_HOSTS = new Set(['relay.linso.ai', 'localhost', '127.0.0.1'])

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase()
  return value === 'localhost' || value === '127.0.0.1'
}

export function remoteHostConfig(value = DEFAULT_REMOTE_HOST) {
  let raw = String(value || '').trim()
  if (!raw) raw = DEFAULT_REMOTE_HOST
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Remote Host must be a valid URL.')
  }

  if (!['https:', 'wss:', 'http:', 'ws:'].includes(url.protocol)) {
    throw new Error('Remote Host must use HTTPS or WSS.')
  }
  if (url.username || url.password) {
    throw new Error('Remote Host must not contain embedded credentials.')
  }
  if (url.search || url.hash) {
    throw new Error('Remote Host must not contain a query string or fragment.')
  }

  const loopback = isLoopbackHostname(url.hostname)
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  if (!secure && !loopback) {
    throw new Error('Remote Host must use HTTPS or WSS unless it is localhost or 127.0.0.1.')
  }

  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  const normalized = url.toString().replace(/\/$/, '')
  const websocketProtocol = secure ? 'wss:' : 'ws:'
  const httpProtocol = secure ? 'https:' : 'http:'
  const webSocketUrl = new URL(normalized)
  webSocketUrl.protocol = websocketProtocol
  const httpUrl = new URL(normalized)
  httpUrl.protocol = httpProtocol
  const permissionOrigin = `${httpProtocol}//${url.host}/*`

  return {
    remoteHost: normalized,
    webSocketBase: webSocketUrl.toString().replace(/\/$/, ''),
    httpBase: httpUrl.toString().replace(/\/$/, ''),
    permissionOrigin,
    loopback,
    requiresOptionalHostPermission: !REQUIRED_REMOTE_HOSTS.has(url.hostname.toLowerCase()),
  }
}

export function normalizeRemoteHost(value) {
  return remoteHostConfig(value).remoteHost
}

export function remoteWsBase(value) {
  return remoteHostConfig(value).webSocketBase
}

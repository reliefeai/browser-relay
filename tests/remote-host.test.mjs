import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRemoteHost, remoteHostConfig, remoteWsBase } from '../extension/remote-host.js'

test('remote hosts default to secure transport and normalize trailing slashes', () => {
  assert.equal(normalizeRemoteHost('relay.example.com/'), 'https://relay.example.com')
  assert.equal(remoteWsBase('https://relay.example.com/base/'), 'wss://relay.example.com/base')
  assert.equal(remoteWsBase('wss://relay.example.com'), 'wss://relay.example.com')
})

test('plaintext remote transport is allowed only on supported loopback hosts', () => {
  assert.equal(remoteWsBase('http://127.0.0.1:8787'), 'ws://127.0.0.1:8787')
  assert.equal(remoteWsBase('ws://localhost:8787'), 'ws://localhost:8787')
  assert.throws(() => remoteWsBase('http://relay.example.com'), /HTTPS or WSS unless/)
  assert.throws(() => remoteWsBase('ws://10.0.0.5:8787'), /HTTPS or WSS unless/)
})

test('remote hosts reject credentials, query strings, fragments, and unknown schemes', () => {
  assert.throws(() => normalizeRemoteHost('https://user:pass@example.com'), /credentials/)
  assert.throws(() => normalizeRemoteHost('https://example.com?token=secret'), /query string/)
  assert.throws(() => normalizeRemoteHost('https://example.com/#secret'), /fragment/)
  assert.throws(() => normalizeRemoteHost('ftp://example.com'), /HTTPS or WSS/)
})

test('custom secure hosts expose an exact optional permission origin', () => {
  const custom = remoteHostConfig('wss://hub.example.com:9443/base')
  assert.equal(custom.permissionOrigin, 'https://hub.example.com:9443/*')
  assert.equal(custom.requiresOptionalHostPermission, true)

  const hosted = remoteHostConfig('https://relay.linso.ai')
  assert.equal(hosted.requiresOptionalHostPermission, false)
})

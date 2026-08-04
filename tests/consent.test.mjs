import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LOCAL_CONSENT_VERSION,
  REMOTE_DISCLOSURE_VERSION,
  buildConsentMigration,
  hasCurrentLocalConsent,
  hasCurrentRemoteDisclosure,
} from '../extension/consent.js'

const accepted = {
  localConsentVersion: LOCAL_CONSENT_VERSION,
  localConsentAcceptedAt: 1,
  remoteDisclosureVersion: REMOTE_DISCLOSURE_VERSION,
  remoteDisclosureAcceptedAt: 2,
}

test('fresh installs and legacy upgrades are denied by default', () => {
  const fresh = buildConsentMigration({}, { reason: 'install' })
  assert.equal(fresh.localEnabled, false)
  assert.equal(fresh.remoteEnabled, false)
  assert.deepEqual(fresh.updates, {
    localControlEnabled: false,
    localMigrationPending: false,
    remoteControlEnabled: false,
    remoteMigrationPending: false,
  })

  const legacy = buildConsentMigration({
    localControlEnabled: true,
    remoteControlEnabled: true,
    remoteRouteId: 'route',
    remoteSecret: 'secret',
    remoteDeviceId: 'br-secret',
  }, { reason: 'update' })
  assert.equal(legacy.localEnabled, false)
  assert.equal(legacy.remoteEnabled, false)
  assert.equal(legacy.updates.localMigrationPending, true)
  assert.equal(legacy.updates.remoteMigrationPending, true)
  assert.deepEqual(legacy.remove, ['remoteRouteId', 'remoteSecret', 'remoteDeviceId'])
})

test('current consent preserves explicitly enabled controls', () => {
  const plan = buildConsentMigration({
    ...accepted,
    localControlEnabled: true,
    localMigrationPending: true,
    remoteControlEnabled: true,
    remoteRouteId: 'route',
    remoteSecret: 'secret',
    remoteDeviceId: 'br-secret',
  })
  assert.equal(plan.localEnabled, true)
  assert.equal(plan.remoteEnabled, true)
  assert.deepEqual(plan.updates, { localMigrationPending: false })
  assert.deepEqual(plan.remove, [])
})

test('consent versions require a recorded explicit acceptance', () => {
  assert.equal(hasCurrentLocalConsent({ localConsentVersion: LOCAL_CONSENT_VERSION }), false)
  assert.equal(hasCurrentRemoteDisclosure({ remoteDisclosureVersion: REMOTE_DISCLOSURE_VERSION }), false)
  assert.equal(hasCurrentLocalConsent(accepted), true)
  assert.equal(hasCurrentRemoteDisclosure(accepted), true)
})

test('missing remote capability disables reconnect without revoking current disclosure', () => {
  const plan = buildConsentMigration({
    ...accepted,
    remoteControlEnabled: true,
  })
  assert.equal(plan.remoteEnabled, false)
  assert.equal(plan.updates.remoteControlEnabled, false)
  assert.deepEqual(plan.remove, [])
})

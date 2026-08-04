export const LOCAL_CONSENT_VERSION = 1
export const REMOTE_DISCLOSURE_VERSION = 1

export const REMOTE_CAPABILITY_KEYS = [
  'remoteRouteId',
  'remoteSecret',
  'remoteDeviceId',
]

function acceptedAt(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0
}

export function hasCurrentLocalConsent(state = {}) {
  return state.localConsentVersion === LOCAL_CONSENT_VERSION
    && acceptedAt(state.localConsentAcceptedAt)
}

export function hasCurrentRemoteDisclosure(state = {}) {
  return state.remoteDisclosureVersion === REMOTE_DISCLOSURE_VERSION
    && acceptedAt(state.remoteDisclosureAcceptedAt)
}

export function hasRemoteCapability(state = {}) {
  return REMOTE_CAPABILITY_KEYS.every((key) => typeof state[key] === 'string' && state[key].length > 0)
}

// Computes a deny-by-default migration without touching Chrome APIs so the
// install/update/startup semantics can be tested outside the service worker.
export function buildConsentMigration(state = {}, { reason = 'startup' } = {}) {
  const localConsentCurrent = hasCurrentLocalConsent(state)
  const remoteDisclosureCurrent = hasCurrentRemoteDisclosure(state)
  const remoteCapabilityCurrent = hasRemoteCapability(state)
  const updates = {}
  const remove = []

  if (!localConsentCurrent) {
    updates.localControlEnabled = false
    updates.localMigrationPending = reason !== 'install'
  } else if (state.localMigrationPending) {
    updates.localMigrationPending = false
  }

  if (!remoteDisclosureCurrent || !remoteCapabilityCurrent) {
    updates.remoteControlEnabled = false
  }
  if (!remoteDisclosureCurrent) {
    const hadLegacyRemote = state.remoteControlEnabled === true || hasRemoteCapability(state)
    updates.remoteMigrationPending = reason !== 'install' && hadLegacyRemote
    remove.push(...REMOTE_CAPABILITY_KEYS)
  } else if (state.remoteMigrationPending) {
    updates.remoteMigrationPending = false
  }

  return {
    localEnabled: state.localControlEnabled === true && localConsentCurrent,
    remoteEnabled: state.remoteControlEnabled === true
      && remoteDisclosureCurrent
      && remoteCapabilityCurrent,
    localConsentCurrent,
    remoteDisclosureCurrent,
    updates,
    remove,
  }
}

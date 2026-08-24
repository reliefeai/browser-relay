export function normalizeDialog(params = {}, context = {}) {
  return {
    type: String(params.type || 'alert'),
    message: String(params.message || ''),
    url: String(params.url || context.url || ''),
    defaultPrompt: typeof params.defaultPrompt === 'string' ? params.defaultPrompt : '',
    hasBrowserHandler: params.hasBrowserHandler === true,
    openedAt: Number.isFinite(context.openedAt) ? context.openedAt : Date.now(),
    ...(context.tabId ? { tabId: String(context.tabId) } : {}),
  }
}

export function dialogBlockedMessage(dialog) {
  const type = dialog?.type || 'JavaScript'
  return `Page is blocked by an open ${type} dialog. Inspect it with dialog status, then explicitly accept or dismiss it.`
}

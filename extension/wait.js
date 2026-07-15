export const WAIT_STATES = ["attached", "visible"];
export const WAIT_DEFAULT_TIMEOUT_MS = 5_000;
export const WAIT_DEFAULT_POLL_MS = 100;
export const WAIT_MIN_TIMEOUT_MS = 1;
export const WAIT_MAX_TIMEOUT_MS = 20_000;
export const WAIT_MIN_POLL_MS = 50;
export const WAIT_MAX_POLL_MS = 1_000;

function boundedInteger(value, fallback, min, max, field) {
  if (value === undefined) return { ok: true, value: fallback };
  if (!Number.isInteger(value) || value < min || value > max) {
    return { ok: false, field, message: `${field} must be an integer between ${min} and ${max}` };
  }
  return { ok: true, value };
}

export function normalizeWaitOptions(input = {}) {
  const selector = input.selector;
  if (typeof selector !== "string" || !selector.trim()) {
    return { ok: false, field: "selector", message: "selector is required" };
  }

  const state = input.state ?? "visible";
  if (!WAIT_STATES.includes(state)) {
    return {
      ok: false,
      field: "state",
      message: `state must be one of: ${WAIT_STATES.join(", ")}`,
    };
  }

  const timeout = boundedInteger(
    input.timeoutMs,
    WAIT_DEFAULT_TIMEOUT_MS,
    WAIT_MIN_TIMEOUT_MS,
    WAIT_MAX_TIMEOUT_MS,
    "timeoutMs",
  );
  if (!timeout.ok) return timeout;

  const poll = boundedInteger(
    input.pollMs,
    WAIT_DEFAULT_POLL_MS,
    WAIT_MIN_POLL_MS,
    WAIT_MAX_POLL_MS,
    "pollMs",
  );
  if (!poll.ok) return poll;

  return {
    ok: true,
    selector,
    state,
    timeoutMs: timeout.value,
    pollMs: poll.value,
    tabId: input.tabId,
  };
}

export function buildWaitExpression(selector, state) {
  return `(() => {
    const __browserRelayWait = true;
    try {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const isVisible = (element) => {
        if (!element || !element.isConnected) return false;
        const rect = element.getBoundingClientRect();
        if (!(rect.width > 0 || rect.height > 0 || element.getClientRects().length > 0)) return false;
        for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number.parseFloat(style.opacity) === 0) return false;
        }
        return true;
      };
      const visibleCount = nodes.filter(isVisible).length;
      return {
        matched: ${JSON.stringify(state)} === 'attached' ? nodes.length > 0 : visibleCount > 0,
        matchCount: nodes.length,
        visibleCount,
      };
    } catch (error) {
      return {
        matched: false,
        invalidSelector: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  })()`;
}

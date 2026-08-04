import { createHash, timingSafeEqual } from "node:crypto";

export const DEFAULT_REMOTE_HOST = "https://relay.linso.ai";
export const REMOTE_DEVICE_ID_PREFIX = "br";
export const REMOTE_RPC_TIMEOUT_MS = 30_000;

function isLoopbackRemoteHost(hostname) {
  const value = String(hostname || "").toLowerCase();
  return value === "localhost" || value === "127.0.0.1";
}

export function normalizeRemoteHost(host = DEFAULT_REMOTE_HOST) {
  let value = String(host || DEFAULT_REMOTE_HOST).trim();
  if (!value) value = DEFAULT_REMOTE_HOST;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Remote host must be a valid URL");
  }
  if (!["https:", "wss:", "http:", "ws:"].includes(url.protocol)) {
    throw new Error("Remote host must use HTTPS or WSS");
  }
  if (url.username || url.password) throw new Error("Remote host must not contain embedded credentials");
  if (url.search || url.hash) throw new Error("Remote host must not contain a query string or fragment");
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  if (!secure && !isLoopbackRemoteHost(url.hostname)) {
    throw new Error("Remote host must use HTTPS or WSS unless it is localhost or 127.0.0.1");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export function remoteHttpBase(host) {
  const normalized = normalizeRemoteHost(host);
  if (normalized.startsWith("ws://")) return `http://${normalized.slice("ws://".length)}`;
  if (normalized.startsWith("wss://")) return `https://${normalized.slice("wss://".length)}`;
  return normalized;
}

export function remoteWsBase(host) {
  const normalized = normalizeRemoteHost(host);
  if (normalized.startsWith("http://")) return `ws://${normalized.slice("http://".length)}`;
  if (normalized.startsWith("https://")) return `wss://${normalized.slice("https://".length)}`;
  return normalized;
}

// routeId is derived from the secret (SHA-256 → base64url, first 16 chars) instead
// of being stored in the id, so the whole capability is just `br-<secret>`. The
// extension derives it identically with SubtleCrypto — keep the two in lockstep.
export function deriveRouteId(secret) {
  const b64 = createHash("sha256").update(String(secret)).digest("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 16);
}

export function parseRemoteDeviceId(remoteDeviceId) {
  const raw = String(remoteDeviceId || "").trim();
  const m = /^br-([A-Za-z0-9_-]{16,})$/.exec(raw);
  if (!m) throw new Error("Invalid remote device id. Expected br-<secret>.");
  const secret = m[1];
  return { version: REMOTE_DEVICE_ID_PREFIX, routeId: deriveRouteId(secret), secret, remoteDeviceId: raw };
}

export function buildRemoteDeviceId(routeId, secret) {
  // routeId is derived from the secret now; the arg is kept only for the legacy
  // daemon caller in relay-server.js. The id carries just the secret.
  return `br-${secret}`;
}

export function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function bearerToken(headers = {}) {
  const auth = headers.authorization || headers.Authorization || "";
  const value = Array.isArray(auth) ? auth[0] : auth;
  const match = /^Bearer\s+(.+)$/i.exec(String(value || ""));
  return match ? match[1].trim() : "";
}

export function errorPayload(code, message, { status = 500, retryable = false, details } = {}) {
  const payload = { ok: false, code, error: message, message, status, retryable };
  if (details !== undefined) payload.details = details;
  return payload;
}

export function jsonHeaders(extra = {}) {
  return { "Content-Type": "application/json", ...extra };
}

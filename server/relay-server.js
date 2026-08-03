#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { SNAPSHOT_JS } from "./snapshot.js";
import { buildWaitExpression, normalizeWaitOptions } from "../extension/wait.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const __pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const RELAY_HOST = process.env.BROWSER_RELAY_HOST || "127.0.0.1";
const RELAY_PORT = parseInt(process.env.BROWSER_RELAY_PORT || "18795", 10);
const RELAY_VERSION = JSON.parse(readFileSync(join(__pkgDir, "package.json"), "utf-8")).version;
const PING_INTERVAL_MS = 5_000;
const COMMAND_TIMEOUT_MS = 30_000;
const EXTENSION_GRACE_MS = 20_000;
const MAX_BODY_SIZE = 64 * 1024; // 64KB
const MAX_CONSOLE_ENTRIES = 1_000;
const MAX_DOWNLOAD_ENTRIES = 1_000;
const MAX_NETWORK_ENTRIES = 1_000;

const serverStartTime = Date.now();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(event, level, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, event, level, ...data }));
}

const LOG = {
  info: (event, data) => log(event, "info", data),
  warn: (event, data) => log(event, "warn", data),
  error: (event, data) => log(event, "error", data),
};

class ApiError extends Error {
  constructor(status, code, message, { retryable = false, details = undefined } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Extension WebSocket state
// ---------------------------------------------------------------------------
let extensionWs = null;
let extensionConnectedSince = null;
let extensionRemoteAddress = null;
let extensionProtocolError = null;

const PUBLIC_TAB_ID_PATTERN = /^t_[A-Za-z0-9_-]{10}$/;
const connectedTargets = new Map(); // sessionId -> { sessionId, tabId, targetId, targetInfo }
let nextExtensionId = 1;
const pendingCommands = new Map();
let nextConsoleEntryId = 1;
let consoleEntries = [];
const consoleEnabledSessions = new Set();
let nextNetworkEntryId = 1;
let networkEntries = [];
const networkEnabledSessions = new Set();
let nextDownloadEntryId = 1;
let downloadEntries = [];

let pingTimer = null;
let graceTimer = null;
const reconnectWaiters = new Set();

function extensionConnected() {
  return extensionWs?.readyState === WebSocket.OPEN;
}

function flushReconnectWaiters(connected) {
  for (const waiter of reconnectWaiters) waiter(connected);
  reconnectWaiters.clear();
}

function clearGraceTimer() {
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
}

function scheduleGraceCleanup() {
  clearGraceTimer();
  graceTimer = setTimeout(() => {
    graceTimer = null;
    if (!extensionConnected()) { connectedTargets.clear(); flushReconnectWaiters(false); }
  }, EXTENSION_GRACE_MS);
}

function waitForExtension(timeoutMs = 3_000) {
  if (extensionConnected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const waiter = (connected) => { if (settled) return; settled = true; clearTimeout(timer); reconnectWaiters.delete(waiter); resolve(connected); };
    const timer = setTimeout(() => waiter(false), timeoutMs);
    reconnectWaiters.add(waiter);
  });
}

// ---------------------------------------------------------------------------
// Send CDP command to extension
// ---------------------------------------------------------------------------
function sendToExtension(method, params, sessionId) {
  const ws = extensionWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new ApiError(503, "extension_not_connected", "Extension not connected", { retryable: true }));
  }
  const id = nextExtensionId++;
  const payload = { id, method: "forwardCDPCommand", params: { method, params, ...(sessionId ? { sessionId } : {}) } };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new ApiError(504, "cdp_timeout", `CDP command timeout: ${method}`, { retryable: true, details: { method } }));
    }, COMMAND_TIMEOUT_MS);
    pendingCommands.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
      timer,
    });
    try { ws.send(JSON.stringify(payload)); }
    catch (err) { clearTimeout(timer); pendingCommands.delete(id); reject(err instanceof Error ? err : new Error(String(err))); }
  });
}

// ---------------------------------------------------------------------------
// Resolve target
// ---------------------------------------------------------------------------
function resolveSession(tabId) {
  if (extensionProtocolError) {
    throw new ApiError(409, "extension_upgrade_required", extensionProtocolError);
  }
  if (tabId) {
    for (const t of connectedTargets.values()) { if (t.tabId === tabId) return t.sessionId; }
    throw new ApiError(404, "tab_not_found", `No attached tab with id: ${tabId}`, { details: { tabId } });
  }
  let last = null;
  for (const t of connectedTargets.values()) last = t;
  if (!last) throw new ApiError(409, "no_attached_tabs", "No attached tabs. Install the Browser Relay extension and open a tab.", { retryable: true });
  return last.sessionId;
}

function resolveTab(tabId) {
  return resolveSession(tabId);
}

// Wait (briefly) for the extension's Target.attachedToTarget event to register
// a freshly created tab, so callers can see it in /api/tabs and target it with
// tab-close / eval etc. right after a cold-start navigate. Falls back to the
// regular tab_not_found error on timeout.
async function resolveAwaitTab(tabId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return resolveSession(tabId);
    } catch (err) {
      const isMissing = err instanceof ApiError && err.code === "tab_not_found";
      if (!isMissing || Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function targetForSession(sessionId) {
  return connectedTargets.get(sessionId) || null;
}

function remoteObjectValue(obj) {
  if (!obj || typeof obj !== "object") return "";
  if ("value" in obj) return obj.value;
  if ("unserializableValue" in obj) return obj.unserializableValue;
  return obj.description || obj.type || "";
}

function stringifyConsoleValue(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

function appendConsoleEntry(entry) {
  consoleEntries.push({ id: nextConsoleEntryId++, receivedAt: new Date().toISOString(), ...entry });
  if (consoleEntries.length > MAX_CONSOLE_ENTRIES) {
    consoleEntries = consoleEntries.slice(-MAX_CONSOLE_ENTRIES);
  }
}

function appendConsoleEvent(sessionId, method, params = {}, eventTabId = "") {
  const target = targetForSession(sessionId);
  const base = {
    sessionId: sessionId || "",
    tabId: target?.tabId || (PUBLIC_TAB_ID_PATTERN.test(eventTabId) ? eventTabId : ""),
    url: target?.targetInfo?.url || "",
    title: target?.targetInfo?.title || "",
  };

  if (method === "Runtime.consoleAPICalled") {
    const args = (params.args || []).map(remoteObjectValue);
    appendConsoleEntry({
      ...base,
      source: "runtime",
      level: params.type || "log",
      text: args.map(stringifyConsoleValue).join(" "),
      args,
      stackTrace: params.stackTrace || null,
      timestamp: params.timestamp || null,
    });
    return;
  }

  if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails || {};
    appendConsoleEntry({
      ...base,
      source: "runtime",
      level: "error",
      text: details.exception?.description || details.text || "Uncaught exception",
      exceptionDetails: details,
      timestamp: params.timestamp || null,
    });
    return;
  }

  if (method === "Log.entryAdded") {
    const entry = params.entry || {};
    appendConsoleEntry({
      ...base,
      source: entry.source || "log",
      level: entry.level || "info",
      text: entry.text || "",
      lineNumber: entry.lineNumber,
      url: entry.url || base.url,
      networkRequestId: entry.networkRequestId,
      timestamp: entry.timestamp || null,
    });
  }
}

const SENSITIVE_NETWORK_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
]);

function redactNetworkHeaders(headers = {}) {
  const redacted = {};
  if (!headers || typeof headers !== "object") return redacted;
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = SENSITIVE_NETWORK_HEADERS.has(String(name).toLowerCase()) ? "[redacted]" : value;
  }
  return redacted;
}

function appendNetworkEntry(entry) {
  networkEntries.push({ id: nextNetworkEntryId++, receivedAt: new Date().toISOString(), ...entry });
  if (networkEntries.length > MAX_NETWORK_ENTRIES) {
    networkEntries = networkEntries.slice(-MAX_NETWORK_ENTRIES);
  }
}

function appendNetworkEvent(sessionId, method, params = {}, eventTabId = "") {
  const target = targetForSession(sessionId);
  const base = {
    sessionId: sessionId || "",
    tabId: target?.tabId || (PUBLIC_TAB_ID_PATTERN.test(eventTabId) ? eventTabId : ""),
    pageUrl: target?.targetInfo?.url || "",
    title: target?.targetInfo?.title || "",
    requestId: params.requestId || "",
    timestamp: params.timestamp ?? null,
  };

  if (method === "Network.requestWillBeSent") {
    const request = params.request || {};
    appendNetworkEntry({
      ...base,
      type: "request",
      url: request.url || params.documentURL || "",
      method: request.method || "",
      documentURL: params.documentURL || "",
      frameId: params.frameId || "",
      resourceType: params.type || "",
      wallTime: params.wallTime ?? null,
      initiator: params.initiator || null,
      request: {
        url: request.url || "",
        method: request.method || "",
        headers: redactNetworkHeaders(request.headers),
      },
    });
    return;
  }

  if (method === "Network.responseReceived") {
    const response = params.response || {};
    appendNetworkEntry({
      ...base,
      type: "response",
      url: response.url || "",
      status: response.status ?? null,
      statusText: response.statusText || "",
      mimeType: response.mimeType || "",
      protocol: response.protocol || "",
      remoteIPAddress: response.remoteIPAddress || "",
      remotePort: response.remotePort ?? null,
      fromDiskCache: !!response.fromDiskCache,
      fromServiceWorker: !!response.fromServiceWorker,
      resourceType: params.type || "",
      response: {
        url: response.url || "",
        status: response.status ?? null,
        statusText: response.statusText || "",
        headers: redactNetworkHeaders(response.headers),
        mimeType: response.mimeType || "",
      },
    });
    return;
  }

  if (method === "Network.loadingFinished") {
    appendNetworkEntry({
      ...base,
      type: "finished",
      encodedDataLength: params.encodedDataLength ?? null,
    });
    return;
  }

  if (method === "Network.loadingFailed") {
    appendNetworkEntry({
      ...base,
      type: "failed",
      resourceType: params.type || "",
      errorText: params.errorText || "",
      canceled: !!params.canceled,
      blockedReason: params.blockedReason || "",
    });
  }
}

async function enableConsoleCapture(sessionId) {
  if (!sessionId || consoleEnabledSessions.has(sessionId)) return;
  consoleEnabledSessions.add(sessionId);
  try { await sendToExtension("Runtime.enable", {}, sessionId); }
  catch (err) {
    consoleEnabledSessions.delete(sessionId);
    throw err;
  }
  await sendToExtension("Log.enable", {}, sessionId).catch(() => {});
}

async function enableNetworkCapture(sessionId) {
  if (!sessionId || networkEnabledSessions.has(sessionId)) return;
  networkEnabledSessions.add(sessionId);
  try { await sendToExtension("Network.enable", {}, sessionId); }
  catch (err) {
    networkEnabledSessions.delete(sessionId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Handle extension messages
// ---------------------------------------------------------------------------
function appendDownloadEvent(type, params = {}) {
  const entry = {
    eventId: nextDownloadEntryId++,
    receivedAt: new Date().toISOString(),
    type,
    ...params,
  };
  if (params.id !== undefined && entry.downloadId === undefined) {
    entry.downloadId = params.id;
  }
  downloadEntries.push(entry);
  if (downloadEntries.length > MAX_DOWNLOAD_ENTRIES) {
    downloadEntries = downloadEntries.slice(-MAX_DOWNLOAD_ENTRIES);
  }
}

function onExtensionMessage(data) {
  let msg;
  try { msg = JSON.parse(typeof data === "string" ? data : data.toString()); } catch { return; }

  if (msg?.method === "pong") return;

  if (typeof msg?.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
    const pending = pendingCommands.get(msg.id);
    if (!pending) return;
    pendingCommands.delete(msg.id);
    if (msg.error) pending.reject(new Error(String(msg.error)));
    else pending.resolve(msg.result);
    return;
  }

  if (msg?.method === "forwardCDPEvent") {
    const cdpMethod = msg.params?.method;
    const cdpParams = msg.params?.params;
    const eventSessionId = msg.params?.sessionId;
    const eventTabId = msg.params?.tabId;

    if (eventSessionId && (
      cdpMethod === "Runtime.consoleAPICalled" ||
      cdpMethod === "Runtime.exceptionThrown" ||
      cdpMethod === "Log.entryAdded"
    )) {
      appendConsoleEvent(eventSessionId, cdpMethod, cdpParams, eventTabId);
    }

    if (eventSessionId && (
      cdpMethod === "Network.requestWillBeSent" ||
      cdpMethod === "Network.responseReceived" ||
      cdpMethod === "Network.loadingFinished" ||
      cdpMethod === "Network.loadingFailed"
    )) {
      appendNetworkEvent(eventSessionId, cdpMethod, cdpParams, eventTabId);
    }

    if (cdpMethod === "BrowserRelay.downloadCreated") {
      appendDownloadEvent("created", cdpParams);
      return;
    }
    if (cdpMethod === "BrowserRelay.downloadChanged") {
      appendDownloadEvent("changed", cdpParams);
      return;
    }
    if (cdpMethod === "BrowserRelay.downloadErased") {
      appendDownloadEvent("erased", cdpParams);
      return;
    }

    if (cdpMethod === "Target.attachedToTarget") {
      const { sessionId, tabId, targetInfo } = cdpParams || {};
      if (sessionId && PUBLIC_TAB_ID_PATTERN.test(tabId) && targetInfo?.targetId && (targetInfo?.type ?? "page") === "page") {
        const duplicate = [...connectedTargets.values()].find((target) => target.tabId === tabId && target.sessionId !== sessionId);
        if (duplicate) {
          LOG.warn("target.attach.duplicate_tab_id", { tabId, sessionId });
          return;
        }
        connectedTargets.set(sessionId, { sessionId, tabId, targetId: targetInfo.targetId, targetInfo });
        void enableConsoleCapture(sessionId).catch((err) => LOG.warn("console.enable.failed", { sessionId, error: err.message || String(err) }));
        void enableNetworkCapture(sessionId).catch((err) => LOG.warn("network.enable.failed", { sessionId, error: err.message || String(err) }));
      } else if (sessionId && targetInfo?.targetId && (targetInfo?.type ?? "page") === "page" && !PUBLIC_TAB_ID_PATTERN.test(eventTabId)) {
        extensionProtocolError = "The Browser Relay extension is too old for short tab IDs. Reload the extension and try again.";
        LOG.warn("target.attach.invalid_tab_id", { sessionId });
      }
    } else if (cdpMethod === "Target.detachedFromTarget") {
      const { sessionId, targetId } = cdpParams || {};
      if (sessionId) { connectedTargets.delete(sessionId); consoleEnabledSessions.delete(sessionId); networkEnabledSessions.delete(sessionId); }
      else if (targetId) { for (const [sid, t] of connectedTargets) { if (t.targetId === targetId) { connectedTargets.delete(sid); consoleEnabledSessions.delete(sid); networkEnabledSessions.delete(sid); } } }
    } else if (cdpMethod === "Target.targetInfoChanged") {
      const info = cdpParams?.targetInfo;
      if (info?.targetId) { for (const [sid, t] of connectedTargets) { if (t.targetId === info.targetId) { connectedTargets.set(sid, { ...t, targetInfo: { ...t.targetInfo, ...info } }); } } }
    } else if (cdpMethod === "Target.targetDestroyed" || cdpMethod === "Target.targetCrashed") {
      const targetId = cdpParams?.targetId;
      if (targetId) { for (const [sid, t] of connectedTargets) { if (t.targetId === targetId) { connectedTargets.delete(sid); consoleEnabledSessions.delete(sid); networkEnabledSessions.delete(sid); } } }
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function defaultErrorCode(status, message) {
  if (status === 400) return "bad_request";
  if (status === 404) return String(message).startsWith("Unknown API endpoint:") ? "endpoint_not_found" : "not_found";
  if (status === 503) return "service_unavailable";
  return "internal_error";
}

function errorResponse(res, status, message, options = {}) {
  const code = options.code || defaultErrorCode(status, message);
  const body = {
    ok: false,
    error: message,
    message,
    code,
    status,
    retryable: options.retryable === true,
  };
  if (options.details !== undefined) body.details = options.details;
  jsonResponse(res, status, body);
}

function writeError(res, err) {
  if (err instanceof ApiError) {
    return errorResponse(res, err.status, err.message, {
      code: err.code,
      retryable: err.retryable,
      details: err.details,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(res, 500, message, { code: "internal_error" });
}

function validationError(res, message, field) {
  return errorResponse(res, 400, message, {
    code: "invalid_request",
    details: field ? { field } : undefined,
  });
}

function elementNotFound(selector) {
  return {
    ok: false,
    error: `Element not found: ${selector}`,
    message: `Element not found: ${selector}`,
    code: "element_not_found",
    status: 200,
    retryable: false,
    details: { selector },
  };
}

async function readBody(req) {
  const chunks = []; let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > MAX_BODY_SIZE) throw new ApiError(413, "request_body_too_large", "Request body too large (max 64KB)");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new ApiError(400, "invalid_json", "Invalid JSON in request body"); }
}

async function ensureExtension() {
  if (extensionConnected()) return;
  const reconnected = await waitForExtension(3_000);
  if (!reconnected || !extensionConnected()) {
    throw new ApiError(503, "extension_not_connected", "Extension not connected. Is the browser running with the extension?", { retryable: true });
  }
}

const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  del: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

function modifierMaskFrom(body, comboParts = []) {
  let modifiers = Number.isInteger(body.modifiers) ? body.modifiers : 0;
  const names = new Set(comboParts.map((part) => part.toLowerCase()));
  if (body.alt === true || names.has("alt") || names.has("option")) modifiers |= 1;
  if (body.ctrl === true || body.control === true || names.has("ctrl") || names.has("control")) modifiers |= 2;
  if (body.meta === true || body.cmd === true || body.command === true || names.has("meta") || names.has("cmd") || names.has("command")) modifiers |= 4;
  if (body.shift === true || names.has("shift")) modifiers |= 8;
  return modifiers;
}

function keyDefinition(rawKey, modifiers, explicitText) {
  const raw = String(rawKey || "").trim();
  if (!raw) return null;
  const named = NAMED_KEYS[raw.toLowerCase()];
  if (named) return { ...named, text: explicitText ?? named.text ?? "" };

  if (raw.length === 1) {
    const upper = raw.toUpperCase();
    const hasCommandModifier = (modifiers & 1) || (modifiers & 2) || (modifiers & 4);
    if (/^[A-Z]$/i.test(raw)) {
      const key = hasCommandModifier && !(modifiers & 8) ? raw.toLowerCase() : raw;
      return {
        key,
        code: `Key${upper}`,
        windowsVirtualKeyCode: upper.charCodeAt(0),
        text: explicitText ?? (hasCommandModifier ? "" : raw),
      };
    }
    if (/^\d$/.test(raw)) {
      return {
        key: raw,
        code: `Digit${raw}`,
        windowsVirtualKeyCode: raw.charCodeAt(0),
        text: explicitText ?? (hasCommandModifier ? "" : raw),
      };
    }
    return {
      key: raw,
      code: raw === " " ? "Space" : "",
      windowsVirtualKeyCode: raw.charCodeAt(0),
      text: explicitText ?? (hasCommandModifier ? "" : raw),
    };
  }

  return { key: raw, code: raw, windowsVirtualKeyCode: 0, text: explicitText ?? "" };
}

function normalizeKeyInput(body) {
  let rawCombo = "";
  if (typeof body.combo === "string" && body.combo.trim()) rawCombo = body.combo;
  else if (typeof body.key === "string" && body.key.trim()) rawCombo = body.key;
  if (!rawCombo) return null;
  const parts = rawCombo.split("+").map((part) => part.trim()).filter(Boolean);
  const keyPart = parts.length ? parts[parts.length - 1] : rawCombo;
  const modifiers = modifierMaskFrom(body, parts.slice(0, -1));
  const explicitText = typeof body.text === "string" ? body.text : undefined;
  const definition = keyDefinition(keyPart, modifiers, explicitText);
  if (!definition) return null;
  return {
    key: definition.key,
    code: body.code || definition.code || definition.key,
    windowsVirtualKeyCode: body.windowsVirtualKeyCode || definition.windowsVirtualKeyCode || 0,
    nativeVirtualKeyCode: body.nativeVirtualKeyCode || body.windowsVirtualKeyCode || definition.windowsVirtualKeyCode || 0,
    text: definition.text || "",
    modifiers,
  };
}

async function dispatchKeyPress(sessionId, input) {
  const base = {
    key: input.key,
    code: input.code,
    windowsVirtualKeyCode: input.windowsVirtualKeyCode,
    nativeVirtualKeyCode: input.nativeVirtualKeyCode,
    modifiers: input.modifiers,
  };
  const down = input.text ? { ...base, text: input.text, unmodifiedText: input.text } : base;
  await sendToExtension("Input.dispatchKeyEvent", { type: "keyDown", ...down }, sessionId);
  await sendToExtension("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
}

// ---------------------------------------------------------------------------
// API route handlers
// ---------------------------------------------------------------------------

async function handleTabs(_req, res) {
  if (extensionProtocolError) {
    throw new ApiError(409, "extension_upgrade_required", extensionProtocolError);
  }
  const tabs = [];
  for (const t of connectedTargets.values()) {
    tabs.push({ id: t.tabId, title: t.targetInfo?.title || "", url: t.targetInfo?.url || "" });
  }
  jsonResponse(res, 200, { ok: true, tabs });
}

async function handleConsole(req, res) {
  await ensureExtension();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const tabId = url.searchParams.get("tabId") || undefined;
  const level = url.searchParams.get("level") || undefined;
  const clear = url.searchParams.get("clear") === "true";
  const limit = boundedNumber(url.searchParams.get("limit"), 100, 0, 1_000);

  if (tabId) {
    await enableConsoleCapture(resolveTab(tabId)).catch(() => {});
  } else {
    await Promise.all([...connectedTargets.keys()].map((sessionId) => enableConsoleCapture(sessionId).catch(() => {})));
  }

  let entries = consoleEntries;
  if (tabId) entries = entries.filter((entry) => entry.tabId === tabId);
  if (level) entries = entries.filter((entry) => entry.level === level);
  const matchedTotal = entries.length;
  const selected = limit === 0 ? [] : entries.slice(-limit);

  if (clear) {
    const ids = new Set(selected.map((entry) => entry.id));
    consoleEntries = consoleEntries.filter((entry) => !ids.has(entry.id));
  }

  jsonResponse(res, 200, { ok: true, entries: selected, count: selected.length, total: matchedTotal, storedTotal: consoleEntries.length });
}

async function handleConsoleClear(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const tabId = body.tabId;
  const level = body.level;
  const before = consoleEntries.length;
  consoleEntries = consoleEntries.filter((entry) => {
    if (tabId && entry.tabId !== tabId) return true;
    if (level && entry.level !== level) return true;
    return false;
  });
  jsonResponse(res, 200, { ok: true, cleared: before - consoleEntries.length, total: consoleEntries.length });
}

function filteredNetworkEntries(filters) {
  let entries = networkEntries;
  if (filters.tabId) entries = entries.filter((entry) => entry.tabId === filters.tabId);
  if (filters.type) entries = entries.filter((entry) => entry.type === filters.type);
  if (filters.method) entries = entries.filter((entry) => String(entry.method || entry.request?.method || "").toUpperCase() === String(filters.method).toUpperCase());
  if (filters.status) entries = entries.filter((entry) => Number(entry.status ?? entry.response?.status) === Number(filters.status));
  if (filters.requestId) entries = entries.filter((entry) => entry.requestId === filters.requestId);
  if (filters.url) entries = entries.filter((entry) => String(entry.url || entry.request?.url || entry.response?.url || "").includes(filters.url));
  return entries;
}

async function handleNetwork(req, res) {
  await ensureExtension();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  await Promise.all([...connectedTargets.keys()].map((sessionId) => enableNetworkCapture(sessionId).catch(() => {})));

  const filters = {
    tabId: url.searchParams.get("tabId") || undefined,
    type: url.searchParams.get("type") || undefined,
    method: url.searchParams.get("method") || undefined,
    status: url.searchParams.get("status") || undefined,
    requestId: url.searchParams.get("requestId") || undefined,
    url: url.searchParams.get("url") || undefined,
  };
  const clear = url.searchParams.get("clear") === "true";
  const limit = boundedNumber(url.searchParams.get("limit"), 100, 0, MAX_NETWORK_ENTRIES);
  const matched = filteredNetworkEntries(filters);
  const selected = limit === 0 ? [] : matched.slice(-limit);

  if (clear) {
    const ids = new Set(selected.map((entry) => entry.id));
    networkEntries = networkEntries.filter((entry) => !ids.has(entry.id));
  }

  jsonResponse(res, 200, { ok: true, entries: selected, count: selected.length, total: matched.length, storedTotal: networkEntries.length });
}

async function handleNetworkClear(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const filters = {
    tabId: body.tabId,
    type: body.type,
    method: body.method,
    status: body.status,
    requestId: body.requestId,
    url: body.url,
  };
  const before = networkEntries.length;
  if (Object.values(filters).some((value) => value !== undefined && value !== null && value !== "")) {
    const ids = new Set(filteredNetworkEntries(filters).map((entry) => entry.id));
    networkEntries = networkEntries.filter((entry) => !ids.has(entry.id));
  } else {
    networkEntries = [];
  }
  jsonResponse(res, 200, { ok: true, cleared: before - networkEntries.length, total: networkEntries.length });
}

async function handleNavigate(req, res) {
  const body = await readBody(req);
  const url = body.url;
  if (!url || typeof url !== "string") return validationError(res, "url is required", "url");
  await ensureExtension();
  let sessionId;
  let navigatedTabId = "";
  try {
    sessionId = resolveTab(body.tabId);
    navigatedTabId = connectedTargets.get(sessionId)?.tabId || "";
  } catch (err) {
    // Cold start: nothing is attached to navigate. When the caller didn't target
    // a specific tab, open a fresh blank tab and navigate that instead of failing.
    if (err instanceof ApiError && err.code === "no_attached_tabs" && !body.tabId) {
      const created = await sendToExtension("Target.createTarget", { url: "about:blank" });
      navigatedTabId = created?.tabId || "";
      // The extension registers the fresh tab via Target.attachedToTarget; wait
      // briefly so it is visible in /api/tabs and targetable right after this call.
      sessionId = await resolveAwaitTab(navigatedTabId);
    } else {
      throw err;
    }
  }
  const result = await sendToExtension("Page.navigate", { url }, sessionId);
  await new Promise((r) => setTimeout(r, 500));
  let title = "", finalUrl = url;
  try {
    const titleResult = await sendToExtension("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId);
    title = titleResult?.result?.value || "";
    const urlResult = await sendToExtension("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId);
    finalUrl = urlResult?.result?.value || url;
  } catch { /* non-critical */ }
  jsonResponse(res, 200, { ok: true, url: finalUrl, title, tabId: navigatedTabId, ...result });
}

async function handleEval(req, res) {
  const body = await readBody(req);
  const expression = body.expression;
  if (!expression || typeof expression !== "string") return validationError(res, "expression is required", "expression");
  await ensureExtension();
  const sessionId = resolveTab(body.tabId);
  const returnByValue = body.returnByValue !== false;
  const result = await sendToExtension("Runtime.evaluate", { expression, returnByValue, awaitPromise: true }, sessionId);
  jsonResponse(res, 200, { ok: true, result: result?.result || null, exceptionDetails: result?.exceptionDetails || null });
}

async function handleSnapshot(req, res) {
  await ensureExtension();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const tabId = url.searchParams.get("tabId") || undefined;
  const format = url.searchParams.get("format") || "text";
  const maxLength = parseInt(url.searchParams.get("maxLength") || "100000", 10);
  const sessionId = resolveTab(tabId);

  if (format === "html") {
    const result = await sendToExtension("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true }, sessionId);
    let html = result?.result?.value || "";
    const truncated = html.length > maxLength;
    if (truncated) html = html.slice(0, maxLength);
    const titleResult = await sendToExtension("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId);
    const urlResult = await sendToExtension("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId);
    return jsonResponse(res, 200, { ok: true, url: urlResult?.result?.value || "", title: titleResult?.result?.value || "", html, truncated });
  }

  const jsWithMaxLen = `var __maxLength = ${maxLength};\n${SNAPSHOT_JS}`;
  const result = await sendToExtension("Runtime.evaluate", { expression: jsWithMaxLen, returnByValue: true, awaitPromise: false }, sessionId);
  let snapshot = "", truncated = false;
  try {
    const parsed = JSON.parse(result?.result?.value || "{}");
    snapshot = parsed.snapshot || ""; truncated = parsed.truncated || false;
  } catch { snapshot = result?.result?.value || ""; }
  const titleResult = await sendToExtension("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId);
  const urlResult = await sendToExtension("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId);
  jsonResponse(res, 200, { ok: true, url: urlResult?.result?.value || "", title: titleResult?.result?.value || "", snapshot, truncated });
}

async function handleWait(req, res) {
  const body = await readBody(req);
  const options = normalizeWaitOptions(body);
  if (!options.ok) {
    throw new ApiError(400, "invalid_request", options.message, {
      details: { field: options.field },
    });
  }

  await ensureExtension();
  const sessionId = resolveTab(options.tabId);
  const expression = buildWaitExpression(options.selector, options.state);
  const startedAt = Date.now();
  let attempts = 0;

  while (true) {
    if (!connectedTargets.has(sessionId)) {
      throw new ApiError(404, "tab_not_found", "The target tab was detached while waiting", {
        details: { tabId: options.tabId ?? null },
      });
    }

    attempts += 1;
    let result;
    try {
      result = await sendToExtension("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: false,
      }, sessionId);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(409, "wait_evaluation_failed", error instanceof Error ? error.message : String(error), {
        retryable: true,
        details: { selector: options.selector, state: options.state },
      });
    }

    if (result?.exceptionDetails) {
      throw new ApiError(409, "wait_evaluation_failed", "The page could not evaluate the wait condition", {
        retryable: true,
        details: { selector: options.selector, state: options.state },
      });
    }

    const evaluation = result?.result?.value;
    if (!evaluation || typeof evaluation !== "object") {
      throw new ApiError(409, "wait_evaluation_failed", "The page returned an invalid wait result", {
        retryable: true,
        details: { selector: options.selector, state: options.state },
      });
    }
    if (evaluation.invalidSelector) {
      throw new ApiError(400, "invalid_selector", `Invalid CSS selector: ${options.selector}`, {
        details: { selector: options.selector },
      });
    }

    const elapsedMs = Date.now() - startedAt;
    if (evaluation.matched === true) {
      return jsonResponse(res, 200, {
        ok: true,
        matched: true,
        selector: options.selector,
        state: options.state,
        elapsedMs,
        attempts,
        matchCount: evaluation.matchCount ?? null,
        visibleCount: evaluation.visibleCount ?? null,
      });
    }

    if (elapsedMs >= options.timeoutMs) {
      throw new ApiError(408, "wait_timeout", `Timed out waiting for selector: ${options.selector}`, {
        retryable: true,
        details: {
          selector: options.selector,
          state: options.state,
          timeoutMs: options.timeoutMs,
          elapsedMs,
          attempts,
        },
      });
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(options.pollMs, options.timeoutMs - elapsedMs)));
  }
}

async function handleClick(req, res) {
  const body = await readBody(req);
  const selector = body.selector;
  if (!selector || typeof selector !== "string") return validationError(res, "selector is required", "selector");
  await ensureExtension();
  const sessionId = resolveTab(body.tabId);

  const findJs = `(function() { var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify({ found: false }); var rect = el.getBoundingClientRect(); return JSON.stringify({ found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: (el.innerText || el.textContent || '').trim().slice(0, 100) }); })()`;
  const findResult = await sendToExtension("Runtime.evaluate", { expression: findJs, returnByValue: true }, sessionId);
  const elInfo = JSON.parse(findResult?.result?.value || '{\"found\":false}');
  if (!elInfo.found) return jsonResponse(res, 200, elementNotFound(selector));

  const button = body.button || "left";
  const clickCount = body.doubleClick ? 2 : 1;

  await sendToExtension("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`, returnByValue: true }, sessionId).catch(() => {});

  const findResult2 = await sendToExtension("Runtime.evaluate", { expression: findJs, returnByValue: true }, sessionId);
  const elInfo2 = JSON.parse(findResult2?.result?.value || '{\"found\":false}');

  // Chrome ignores CDP mouse input for background tabs. A normal DOM click
  // preserves the shared-browser workflow without forcing the tab forward.
  // Foreground tabs still receive trusted mouse events below.
  const visibilityResult = await sendToExtension("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, sessionId);
  const visibility = visibilityResult?.result?.value;
  if (visibility === "hidden" && button === "left" && clickCount === 1) {
    const domClickJs = `(function() { var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`;
    const domClickResult = await sendToExtension("Runtime.evaluate", { expression: domClickJs, returnByValue: true }, sessionId);
    if (domClickResult?.result?.value) {
      return jsonResponse(res, 200, { ok: true, clicked: true, strategy: "dom", elementText: elInfo2.text || elInfo.text || "", selector });
    }
  }

  const fx = Math.round(elInfo2.found ? elInfo2.x : elInfo.x);
  const fy = Math.round(elInfo2.found ? elInfo2.y : elInfo.y);

  await sendToExtension("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx, y: fy }, sessionId);
  await sendToExtension("Input.dispatchMouseEvent", { type: "mousePressed", x: fx, y: fy, button, clickCount }, sessionId);
  await sendToExtension("Input.dispatchMouseEvent", { type: "mouseReleased", x: fx, y: fy, button, clickCount }, sessionId);

  jsonResponse(res, 200, { ok: true, clicked: true, strategy: "mouse", elementText: elInfo2.text || elInfo.text || "", selector });
}

async function handleType(req, res) {
  const body = await readBody(req);
  const text = body.text;
  if (typeof text !== "string") return validationError(res, "text is required", "text");
  await ensureExtension();
  const sessionId = resolveTab(body.tabId);
  const selector = body.selector;
  const submit = body.submit || false;
  const clear = body.clear || false;

  if (selector) {
    const focusJs = `(function() { var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify({ found: false }); el.focus(); return JSON.stringify({ found: true }); })()`;
    const focusResult = await sendToExtension("Runtime.evaluate", { expression: focusJs, returnByValue: true }, sessionId);
    const info = JSON.parse(focusResult?.result?.value || '{\"found\":false}');
    if (!info.found) return jsonResponse(res, 200, elementNotFound(selector));
  }

  if (clear) {
    await sendToExtension("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 }, sessionId);
    await sendToExtension("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 }, sessionId);
    await sendToExtension("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" }, sessionId);
    await sendToExtension("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" }, sessionId);
  }

  await sendToExtension("Input.insertText", { text }, sessionId);

  if (submit) {
    await sendToExtension("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
    await sendToExtension("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
  }

  jsonResponse(res, 200, { ok: true, typed: true });
}

async function handleKey(req, res) {
  const body = await readBody(req);
  const input = normalizeKeyInput(body);
  if (!input) return validationError(res, "key or combo is required", "key");
  await ensureExtension();
  const sessionId = resolveTab(body.tabId);
  await dispatchKeyPress(sessionId, input);
  jsonResponse(res, 200, { ok: true, pressed: true, ...input });
}

async function handleScreenshot(req, res) {
  await ensureExtension();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const body = req.method === "POST" ? await readBody(req) : {};
  const tabId = body.tabId || url.searchParams.get("tabId") || undefined;
  const fullPage = body.fullPage === true || url.searchParams.get("fullPage") === "true";
  const sessionId = resolveTab(tabId);
  let fallbackError = null;

  if (fullPage) {
    let width = null;
    let height = null;
    try {
      const metrics = await sendToExtension("Page.getLayoutMetrics", {}, sessionId);
      const size = metrics?.cssContentSize || metrics?.contentSize || metrics?.cssLayoutViewport || metrics?.layoutViewport;
      const rawWidth = Number(size?.width);
      const rawHeight = Number(size?.height);
      if (Number.isFinite(rawWidth) && Number.isFinite(rawHeight) && rawWidth > 0 && rawHeight > 0) {
        width = Math.ceil(rawWidth);
        height = Math.ceil(rawHeight);
        const result = await sendToExtension("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        }, sessionId);
        const data = result?.data || "";
        return jsonResponse(res, 200, { ok: true, data, format: "png", fullPage: true, strategy: "fullPageClip", width, height, bytes: Buffer.byteLength(data, "base64") });
      }
    } catch (err) {
      fallbackError = err instanceof Error ? err.message : String(err);
    }

    const result = await sendToExtension("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
    const data = result?.data || "";
    return jsonResponse(res, 200, { ok: true, data, format: "png", fullPage: true, strategy: "captureBeyondViewport", width, height, bytes: Buffer.byteLength(data, "base64"), fallbackError });
  }

  const result = await sendToExtension("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  const data = result?.data || "";
  jsonResponse(res, 200, { ok: true, data, format: "png", fullPage: false, strategy: "viewport", bytes: Buffer.byteLength(data, "base64") });
}

async function handleScroll(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const sessionId = resolveTab(body.tabId);
  const direction = body.direction || "down";
  const amount = body.amount || 800;
  const js = direction === "bottom"
    ? "window.scrollTo(0, document.body.scrollHeight)"
    : direction === "top"
    ? "window.scrollTo(0, 0)"
    : `window.scrollBy(0, ${direction === "down" ? amount : -amount})`;
  await sendToExtension("Runtime.evaluate", { expression: js, returnByValue: true }, sessionId);
  jsonResponse(res, 200, { ok: true, scrolled: true, direction });
}

async function handleTabCreate(req, res) {
  const body = await readBody(req);
  const url = typeof body?.url === "string" && body.url.trim() ? body.url.trim() : "about:blank";
  await ensureExtension();
  const created = await sendToExtension("Target.createTarget", { url });
  jsonResponse(res, 200, { ok: true, tabId: created?.tabId || null, targetId: created?.targetId || null, url });
}

async function handleTabClose(req, res) {
  const body = await readBody(req);
  const tabId = typeof body?.tabId === "string" ? body.tabId.trim() : "";
  if (!tabId) {
    return validationError(res, "tabId is required — closing must target an explicit tab", "tabId");
  }
  await ensureExtension();
  // Closing is destructive, so unlike navigate it never falls back to the
  // "last attached tab": only the explicitly requested tab may be closed.
  const sessionId = resolveTab(tabId);
  await sendToExtension("Target.closeTarget", {}, sessionId);
  jsonResponse(res, 200, { ok: true, closed: true, tabId });
}

async function handleDownload(req, res) {
  const body = await readBody(req);
  const selector = body.selector;
  if (!selector || typeof selector !== "string") return validationError(res, "selector is required (e.g. 'img[src=...]' or 'a[href=...]')", "selector");
  await ensureExtension();
  const sessionId = resolveTab(body.tabId);
  const result = await sendToExtension("Runtime.evaluate", {
    expression: `(function() { var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { found: false }; var url = el.src || el.href || ''; var tag = el.tagName; return { found: true, url, tag }; })()`,
    returnByValue: true,
  }, sessionId);
  const data = result?.result?.value || { found: false };
  if (!data.found) return jsonResponse(res, 200, elementNotFound(selector));
  jsonResponse(res, 200, { ok: true, ...data });
}

async function handleDownloadStart(req, res) {
  const body = await readBody(req);
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) return validationError(res, "url is required", "url");
  await ensureExtension();

  const options = { url };
  if (typeof body.filename === "string" && body.filename.trim()) options.filename = body.filename;
  if (body.saveAs === true) options.saveAs = true;
  if (typeof body.conflictAction === "string" && body.conflictAction.trim()) options.conflictAction = body.conflictAction;

  const result = await sendToExtension("BrowserRelay.download", options);
  jsonResponse(res, 200, { ok: true, downloadId: result?.id, ...result });
}

function downloadEventId(entry) {
  return entry.downloadId ?? entry.item?.id ?? entry.delta?.id ?? entry.id;
}

async function handleDownloads(req, res) {
  await ensureExtension();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const limit = boundedNumber(url.searchParams.get("limit"), 100, 1, 1000);
  const query = { limit };
  for (const name of ["id", "state", "url", "filename", "query"]) {
    const value = url.searchParams.get(name);
    if (value) query[name] = value;
  }

  const result = await sendToExtension("BrowserRelay.searchDownloads", query);
  let events = downloadEntries.slice(-limit);
  if (query.id) {
    const id = Number(query.id);
    events = events.filter((entry) => Number(downloadEventId(entry)) === id);
  }

  jsonResponse(res, 200, { ok: true, downloads: result?.downloads || [], events });
}

async function handleDownloadsClear(_req, res) {
  const cleared = downloadEntries.length;
  downloadEntries = [];
  jsonResponse(res, 200, { ok: true, cleared });
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const startTime = Date.now();
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (path !== "/extension/status") {
    LOG.info("http.request", { method: req.method, path, remote: req.socket.remoteAddress || "unknown" });
  }

  // Health probe
  if (req.method === "HEAD" && path === "/") { res.writeHead(200); res.end(); return; }
  if (req.method === "GET" && path === "/") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("OK"); return; }

  // CORS for chrome-extension:// origins
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": origin || "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "86400" });
    res.end(); return;
  }

  // /extension/status
  if (path === "/extension/status") { jsonResponse(res, 200, { connected: extensionConnected() }); return; }

  // /json/version and /json/list
  if (path === "/json/version" || path === "/json/version/") {
    const payload = { Browser: "BrowserRelay/custom", "Protocol-Version": "1.3" };
    if (extensionConnected() || connectedTargets.size > 0) {
      payload.webSocketDebuggerUrl = `ws://${RELAY_HOST}:${RELAY_PORT}/cdp`;
    }
    return jsonResponse(res, 200, payload);
  }
  if (path === "/json" || path === "/json/" || path === "/json/list" || path === "/json/list/") {
    const list = [];
    for (const t of connectedTargets.values()) {
      list.push({ id: t.targetId, type: t.targetInfo?.type || "page", title: t.targetInfo?.title || "", url: t.targetInfo?.url || "" });
    }
    return jsonResponse(res, 200, list);
  }

  // All /api/* routes
  if (path.startsWith("/api/")) {
    if (req.method === "GET" && path === "/api/debug") {
      const tabCount = connectedTargets.size;
      const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
      return jsonResponse(res, 200, { ok: true, version: RELAY_VERSION, host: RELAY_HOST, port: RELAY_PORT, connected: extensionConnected(), tabCount, uptimeSeconds });
    }

    const routeMap = {
      "GET /api/tabs": handleTabs,
      "GET /api/console": handleConsole,
      "POST /api/console/clear": handleConsoleClear,
      "GET /api/network": handleNetwork,
      "POST /api/network/clear": handleNetworkClear,
      "POST /api/navigate": handleNavigate,
      "POST /api/eval": handleEval,
      "POST /api/wait": handleWait,
      "GET /api/snapshot": handleSnapshot,
      "POST /api/click": handleClick,
      "POST /api/type": handleType,
      "POST /api/key": handleKey,
      "GET /api/screenshot": handleScreenshot,
      "POST /api/screenshot": handleScreenshot,
      "POST /api/scroll": handleScroll,
      "POST /api/tab-create": handleTabCreate,
      "POST /api/tab-close": handleTabClose,
      "POST /api/download": handleDownload,
      "POST /api/download/start": handleDownloadStart,
      "GET /api/downloads": handleDownloads,
      "POST /api/downloads/clear": handleDownloadsClear,
    };

    const routeKey = `${req.method} ${path}`;
    let handler = routeMap[routeKey];
    if (!handler) {
      handler = routeMap[`${req.method} ${path.replace(/\/$/, "")}`];
    }

    if (handler) {
      try { await handler(req, res); }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof ApiError ? err.status : 500;
        LOG.error("api.error", { path, status, error: message });
        writeError(res, err);
      }
      return;
    }

    return errorResponse(res, 404, `Unknown API endpoint: ${path}`);
  }

  errorResponse(res, 404, "Not found");
});

// ---------------------------------------------------------------------------
// WebSocket upgrade
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname !== "/extension") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy(); return;
  }

  // Reject if extension already connected
  if (extensionWs && extensionWs.readyState === WebSocket.OPEN) {
    socket.write("HTTP/1.1 409 Conflict\r\n\r\nExtension already connected");
    socket.destroy(); return;
  }

  if (extensionWs && extensionWs.readyState !== WebSocket.OPEN) {
    try { extensionWs.terminate(); } catch { /* ignore */ }
    extensionWs = null;
  }

  wss.handleUpgrade(req, socket, head, (ws) => { wss.emit("connection", ws, req); });
});

wss.on("connection", (ws, req) => {
  const remote = req?.socket?.remoteAddress || "unknown";
  extensionRemoteAddress = remote;
  extensionConnectedSince = new Date().toISOString();
  LOG.info("extension.connect", { remote, since: extensionConnectedSince });
  extensionWs = ws;
  extensionProtocolError = null;
  connectedTargets.clear();
  clearGraceTimer();
  flushReconnectWaiters(true);

  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: "ping" })); }, PING_INTERVAL_MS);

  ws.on("message", (data) => { if (extensionWs !== ws) return; onExtensionMessage(data); });

  ws.on("close", (code, reason) => {
    LOG.info("extension.disconnect", { code, reason: reason ? String(reason) : "none" });
    extensionConnectedSince = null; extensionRemoteAddress = null;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (extensionWs !== ws) return;
    extensionWs = null;
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new ApiError(503, "extension_disconnected", "Extension disconnected", { retryable: true }));
      pendingCommands.delete(id);
    }
    scheduleGraceCleanup();
  });

  ws.on("error", () => {});
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(RELAY_PORT, RELAY_HOST, () => {
  LOG.info("server.start", { version: RELAY_VERSION, host: RELAY_HOST, port: RELAY_PORT, wsPath: "/extension", httpApiPath: "/api/", healthPath: "/" });
  console.log(`\n========================================`);
  console.log(`Browser Relay v${RELAY_VERSION}`);
  console.log(`========================================`);
  console.log(`Listening:     ${RELAY_HOST}:${RELAY_PORT}`);
  console.log(`Extension WS:  ws://${RELAY_HOST}:${RELAY_PORT}/extension`);
  console.log(`HTTP API:      http://${RELAY_HOST}:${RELAY_PORT}/api/`);
  console.log(`Health probe:  http://${RELAY_HOST}:${RELAY_PORT}/ (HEAD or GET)`);
  console.log(`========================================`);
  console.log(`\nInstall the Browser Relay extension and point it at:`);
  console.log(`  ws://127.0.0.1:${RELAY_PORT}/extension`);
  console.log(`\nWaiting for extension connection...\n`);
});

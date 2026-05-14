#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { SNAPSHOT_JS } from "./snapshot.js";

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

// ---------------------------------------------------------------------------
// Extension WebSocket state
// ---------------------------------------------------------------------------
let extensionWs = null;
let extensionConnectedSince = null;
let extensionRemoteAddress = null;

const connectedTargets = new Map(); // sessionId -> { tabId, targetId, targetInfo }
let nextExtensionId = 1;
const pendingCommands = new Map();

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
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Extension not connected"));
  const id = nextExtensionId++;
  const payload = { id, method: "forwardCDPCommand", params: { method, params, ...(sessionId ? { sessionId } : {}) } };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingCommands.delete(id); reject(new Error(`CDP command timeout: ${method}`)); }, COMMAND_TIMEOUT_MS);
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
function resolveSession(targetId) {
  if (targetId) {
    for (const t of connectedTargets.values()) { if (t.targetId === targetId) return t.sessionId; }
    throw new Error(`No attached tab with targetId: ${targetId}`);
  }
  let last = null;
  for (const t of connectedTargets.values()) last = t;
  if (!last) throw new Error("No attached tabs. Install the Browser Relay extension and open a tab.");
  return last.sessionId;
}

function resolveTab(tabId) {
  return resolveSession(tabId);
}

function positiveNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Handle extension messages
// ---------------------------------------------------------------------------
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

    if (cdpMethod === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = cdpParams || {};
      if (sessionId && targetInfo?.targetId && (targetInfo?.type ?? "page") === "page") {
        connectedTargets.set(sessionId, { sessionId, targetId: targetInfo.targetId, targetInfo });
      }
    } else if (cdpMethod === "Target.detachedFromTarget") {
      const { sessionId, targetId } = cdpParams || {};
      if (sessionId) connectedTargets.delete(sessionId);
      else if (targetId) { for (const [sid, t] of connectedTargets) { if (t.targetId === targetId) connectedTargets.delete(sid); } }
    } else if (cdpMethod === "Target.targetInfoChanged") {
      const info = cdpParams?.targetInfo;
      if (info?.targetId) { for (const [sid, t] of connectedTargets) { if (t.targetId === info.targetId) { connectedTargets.set(sid, { ...t, targetInfo: { ...t.targetInfo, ...info } }); } } }
    } else if (cdpMethod === "Target.targetDestroyed" || cdpMethod === "Target.targetCrashed") {
      const targetId = cdpParams?.targetId;
      if (targetId) { for (const [sid, t] of connectedTargets) { if (t.targetId === targetId) connectedTargets.delete(sid); } }
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
function errorResponse(res, status, message) { jsonResponse(res, status, { ok: false, error: message }); }

async function readBody(req) {
  const chunks = []; let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > MAX_BODY_SIZE) throw new Error("Request body too large (max 64KB)");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new Error("Invalid JSON in request body"); }
}

async function ensureExtension() {
  if (extensionConnected()) return;
  const reconnected = await waitForExtension(3_000);
  if (!reconnected || !extensionConnected()) { throw new Error("Extension not connected. Is the browser running with the extension?"); }
}

// ---------------------------------------------------------------------------
// API route handlers
// ---------------------------------------------------------------------------

async function handleTabs(_req, res) {
  const tabs = [];
  for (const t of connectedTargets.values()) {
    tabs.push({ id: t.targetId, sessionId: t.sessionId, title: t.targetInfo?.title || "", url: t.targetInfo?.url || "" });
  }
  jsonResponse(res, 200, { ok: true, tabs });
}

async function handleNavigate(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const url = body.url;
  if (!url || typeof url !== "string") return errorResponse(res, 400, "url is required");
  const sessionId = resolveTab(body.tabId);
  const result = await sendToExtension("Page.navigate", { url }, sessionId);
  await new Promise((r) => setTimeout(r, 500));
  let title = "", finalUrl = url;
  try {
    const titleResult = await sendToExtension("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId);
    title = titleResult?.result?.value || "";
    const urlResult = await sendToExtension("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId);
    finalUrl = urlResult?.result?.value || url;
  } catch { /* non-critical */ }
  jsonResponse(res, 200, { ok: true, url: finalUrl, title, ...result });
}

async function handleEval(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const expression = body.expression;
  if (!expression || typeof expression !== "string") return errorResponse(res, 400, "expression is required");
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

async function handleClick(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const selector = body.selector;
  if (!selector || typeof selector !== "string") return errorResponse(res, 400, "selector is required");
  const sessionId = resolveTab(body.tabId);

  const findJs = `(function() { var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify({ found: false }); var rect = el.getBoundingClientRect(); return JSON.stringify({ found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: (el.innerText || el.textContent || '').trim().slice(0, 100) }); })()`;
  const findResult = await sendToExtension("Runtime.evaluate", { expression: findJs, returnByValue: true }, sessionId);
  const elInfo = JSON.parse(findResult?.result?.value || '{\"found\":false}');
  if (!elInfo.found) return jsonResponse(res, 200, { ok: false, error: `Element not found: ${selector}` });

  const button = body.button || "left";
  const clickCount = body.doubleClick ? 2 : 1;
  const x = Math.round(elInfo.x), y = Math.round(elInfo.y);

  await sendToExtension("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`, returnByValue: true }, sessionId).catch(() => {});

  const findResult2 = await sendToExtension("Runtime.evaluate", { expression: findJs, returnByValue: true }, sessionId);
  const elInfo2 = JSON.parse(findResult2?.result?.value || '{\"found\":false}');
  const fx = Math.round(elInfo2.found ? elInfo2.x : elInfo.x);
  const fy = Math.round(elInfo2.found ? elInfo2.y : elInfo.y);

  await sendToExtension("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx, y: fy }, sessionId);
  await sendToExtension("Input.dispatchMouseEvent", { type: "mousePressed", x: fx, y: fy, button, clickCount }, sessionId);
  await sendToExtension("Input.dispatchMouseEvent", { type: "mouseReleased", x: fx, y: fy, button, clickCount }, sessionId);

  jsonResponse(res, 200, { ok: true, clicked: true, elementText: elInfo2.text || elInfo.text || "", selector });
}

async function handleType(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const text = body.text;
  if (typeof text !== "string") return errorResponse(res, 400, "text is required");
  const sessionId = resolveTab(body.tabId);
  const selector = body.selector;
  const submit = body.submit || false;
  const clear = body.clear || false;

  if (selector) {
    const focusJs = `(function() { var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify({ found: false }); el.focus(); return JSON.stringify({ found: true }); })()`;
    const focusResult = await sendToExtension("Runtime.evaluate", { expression: focusJs, returnByValue: true }, sessionId);
    const info = JSON.parse(focusResult?.result?.value || '{\"found\":false}');
    if (!info.found) return jsonResponse(res, 200, { ok: false, error: `Element not found: ${selector}` });
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

async function handleScreenshot(req, res) {
  await ensureExtension();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const body = req.method === "POST" ? await readBody(req) : {};
  const tabId = body.tabId || url.searchParams.get("tabId") || undefined;
  const fullPage = body.fullPage === true || url.searchParams.get("fullPage") === "true";
  const sessionId = resolveTab(tabId);

  let strategy = fullPage ? "fullPageClip" : "viewport";
  let width = null;
  let height = null;
  let fallbackError = null;
  let result = null;

  if (fullPage) {
    try {
      const metrics = await sendToExtension("Page.getLayoutMetrics", {}, sessionId);
      const size = metrics?.cssContentSize || metrics?.contentSize || {};
      width = Math.ceil(positiveNumber(size.width, 0, 1, Number.MAX_SAFE_INTEGER));
      height = Math.ceil(positiveNumber(size.height, 0, 1, Number.MAX_SAFE_INTEGER));
      if (!width || !height) throw new Error("Page.getLayoutMetrics returned no content size");
      result = await sendToExtension("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      }, sessionId);
    } catch (err) {
      fallbackError = err instanceof Error ? err.message : String(err);
      strategy = "captureBeyondViewportFallback";
      result = await sendToExtension("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true }, sessionId);
    }
  } else {
    result = await sendToExtension("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true }, sessionId);
  }

  const data = result?.data || "";
  jsonResponse(res, 200, { ok: true, data, format: "png", fullPage, strategy, width, height, bytes: Buffer.byteLength(data, "base64"), fallbackError });
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

async function handleDownload(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const selector = body.selector;
  if (!selector || typeof selector !== "string") return errorResponse(res, 400, "selector is required (e.g. 'img[src=...]' or 'a[href=...]')");
  const sessionId = resolveTab(body.tabId);
  const result = await sendToExtension("Runtime.evaluate", {
    expression: `(function() { var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { found: false }; var url = el.src || el.href || ''; var tag = el.tagName; return { found: true, url, tag }; })()`,
    returnByValue: true,
  }, sessionId);
  jsonResponse(res, 200, { ok: true, ...result?.result?.value });
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
      "POST /api/navigate": handleNavigate,
      "POST /api/eval": handleEval,
      "GET /api/snapshot": handleSnapshot,
      "POST /api/click": handleClick,
      "POST /api/type": handleType,
      "GET /api/screenshot": handleScreenshot,
      "POST /api/screenshot": handleScreenshot,
      "POST /api/scroll": handleScroll,
      "POST /api/download": handleDownload,
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
        LOG.error("api.error", { path, error: message });
        errorResponse(res, 500, message);
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
    for (const [id, pending] of pendingCommands) { clearTimeout(pending.timer); pending.reject(new Error("Extension disconnected")); pendingCommands.delete(id); }
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

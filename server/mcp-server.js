#!/usr/bin/env node
/**
 * MCP stdio server for browser-relay (no-auth).
 *
 * Exposes high-level browser tools over the Model Context Protocol.
 * Each tool maps to an HTTP call to the relay-server.
 *
 * Works with any MCP-compatible agent (Claude Code, Claude Desktop,
 * Cursor, Windsurf, etc.)
 *
 * Usage:
 *   BROWSER_RELAY_URL=http://127.0.0.1:18795 node mcp-server.js
 */
import { readFileSync } from "node:fs";
import { DEFAULT_REMOTE_HOST, parseRemoteDeviceId, remoteHttpBase } from "./remote-protocol.js";

const RELAY_URL = (process.env.BROWSER_RELAY_URL || "http://127.0.0.1:18795").replace(/\/$/, "");
const RELAY_PORT = parseInt(new URL(RELAY_URL).port || "18795", 10);
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;

// ---------------------------------------------------------------------------
// HTTP client to relay
// ---------------------------------------------------------------------------
function remoteContextFromEnv() {
  const remoteDeviceId = process.env.BROWSER_RELAY_REMOTE_DEVICE_ID;
  if (!remoteDeviceId) return null;
  try {
    const parsed = parseRemoteDeviceId(remoteDeviceId);
    const host = process.env.BROWSER_RELAY_REMOTE_HOST || DEFAULT_REMOTE_HOST;
    return { ...parsed, host: remoteHttpBase(host) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw relayToolError(errorPayload("invalid_remote_device_id", message, { status: 400 }));
  }
}

async function remoteRelayRequest(ctx, method, path, body) {
  const requestBody = {
    routeId: ctx.routeId,
    id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    method,
    path,
    headers: {},
    body: body === undefined ? null : body,
  };

  let res;
  try {
    res = await fetch(`${ctx.host}/v1/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.secret}` },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `Cannot reach Browser Relay Hub at ${ctx.host}: ${detail}`;
    throw relayToolError(errorPayload("remote_hub_unreachable", message, { status: 0, retryable: true }));
  }

  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const payload = data && typeof data === "object"
      ? data
      : errorPayload("remote_http_error", `HTTP ${res.status}`, { status: res.status });
    throw relayToolError(payload);
  }
  if (data?.ok === false) throw relayToolError(data);
  return data;
}

async function relayRequest(method, path, body) {
  const remoteContext = remoteContextFromEnv();
  if (remoteContext) return remoteRelayRequest(remoteContext, method, path, body);
  const url = `${RELAY_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  const opts = { method, headers };
  if (body !== undefined && method !== "GET") opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `Cannot reach Browser Relay at ${RELAY_URL}: ${detail}`;
    throw relayToolError(errorPayload("relay_unreachable", message, { status: 0, retryable: true }));
  }

  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }

  if (!res.ok) {
    const payload = data && typeof data === "object"
      ? data
      : errorPayload("http_error", `HTTP ${res.status}`, { status: res.status });
    throw relayToolError(payload);
  }
  if (data?.ok === false) throw relayToolError(data);
  return data;
}

async function relayGet(path) { return relayRequest("GET", path); }
async function relayPost(path, body) { return relayRequest("POST", path, body); }

function addQueryParam(params, name, value) {
  if (value !== undefined && value !== null && value !== "") params.set(name, String(value));
}

function errorPayload(code, message, options = {}) {
  return {
    ok: false,
    code,
    error: message,
    message,
    status: options.status ?? 500,
    retryable: options.retryable === true,
  };
}

function relayToolError(payload) {
  const message = payload?.message || payload?.error || "Browser Relay request failed";
  const err = new Error(payload?.code ? `${payload.code}: ${message}` : message);
  err.payload = payload;
  return err;
}

function toolErrorPayload(err) {
  if (err?.payload) return err.payload;
  const message = err instanceof Error ? err.message : String(err);
  return errorPayload("mcp_tool_error", message);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "browser_tabs",
    description: "List all browser tabs currently attached via the Browser Relay extension. Returns tab IDs, titles, and URLs. Call this first to discover available tabs.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => relayGet("/api/tabs"),
  },
  {
    name: "browser_navigate",
    description: "Navigate a browser tab to a URL. If no tabId is provided, uses the most recently attached tab.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional, defaults to most recent)" },
      },
      required: ["url"],
    },
    handler: async (args) => relayPost("/api/navigate", args),
  },
  {
    name: "browser_console",
    description: "Read captured console.log/warn/error, page exceptions, and browser log entries from attached tabs. Use this to diagnose page behavior after interactions.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional)" },
        level: { type: "string", description: "Filter by level, e.g. log, warning, error" },
        limit: { type: "number", description: "Maximum entries to return (default: 100)" },
        clear: { type: "boolean", description: "Clear returned entries after reading" },
      },
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      if (args.tabId) params.set("tabId", args.tabId);
      if (args.level) params.set("level", args.level);
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      if (args.clear) params.set("clear", "true");
      const qs = params.toString();
      return relayGet(`/api/console${qs ? "?" + qs : ""}`);
    },
  },
  {
    name: "browser_network",
    description: "Read captured Network.* request/response/finished/failed entries from attached tabs. Sensitive headers such as Authorization, Cookie, and Set-Cookie are redacted. Use this to diagnose failed requests after page actions.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional)" },
        type: { type: "string", enum: ["request", "response", "finished", "failed"], description: "Network entry type" },
        method: { type: "string", description: "Filter by request method, e.g. GET or POST" },
        status: { type: "number", description: "Filter by HTTP response status" },
        requestId: { type: "string", description: "Filter by CDP request id" },
        url: { type: "string", description: "Filter by URL substring" },
        limit: { type: "number", description: "Maximum entries to return (default: 100)" },
        clear: { type: "boolean", description: "Clear matched entries" },
      },
    },
    handler: async (args) => {
      if (args.clear) {
        return relayPost("/api/network/clear", {
          tabId: args.tabId,
          type: args.type,
          method: args.method,
          status: args.status,
          requestId: args.requestId,
          url: args.url,
        });
      }
      const params = new URLSearchParams();
      addQueryParam(params, "tabId", args.tabId);
      addQueryParam(params, "type", args.type);
      addQueryParam(params, "method", args.method);
      addQueryParam(params, "status", args.status);
      addQueryParam(params, "requestId", args.requestId);
      addQueryParam(params, "url", args.url);
      addQueryParam(params, "limit", args.limit);
      const qs = params.toString();
      return relayGet(`/api/network${qs ? "?" + qs : ""}`);
    },
  },
  {
    name: "browser_snapshot",
    description: "Get a text representation of the page. Returns annotated text with clickable elements (links, buttons, inputs) marked for easy reference. Use this to understand what is on the page before interacting.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional)" },
        format: { type: "string", enum: ["text", "html"], description: "Output format (default: text)" },
        maxLength: { type: "number", description: "Max output length (default: 100000)" },
      },
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      if (args.tabId) params.set("tabId", args.tabId);
      if (args.format) params.set("format", args.format);
      if (args.maxLength) params.set("maxLength", String(args.maxLength));
      const qs = params.toString();
      return relayGet(`/api/snapshot${qs ? "?" + qs : ""}`);
    },
  },
  {
    name: "browser_dialog_status",
    description: "Inspect the native JavaScript dialog currently blocking a tab. Returns its type, message, URL, and default prompt without accepting or dismissing it.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional)" },
      },
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      addQueryParam(params, "tabId", args.tabId);
      const qs = params.toString();
      return relayGet(`/api/dialog/status${qs ? "?" + qs : ""}`);
    },
  },
  {
    name: "browser_dialog_accept",
    description: "Explicitly accept the native JavaScript dialog blocking a tab. For a prompt dialog, promptText supplies the response. This tool never runs automatically.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional)" },
        promptText: { type: "string", description: "Text to submit to a prompt dialog (optional)" },
      },
    },
    handler: async (args) => relayPost("/api/dialog/accept", args),
  },
  {
    name: "browser_dialog_dismiss",
    description: "Explicitly cancel or dismiss the native JavaScript dialog blocking a tab. This tool never runs automatically.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional)" },
      },
    },
    handler: async (args) => relayPost("/api/dialog/dismiss", args),
  },
  {
    name: "browser_wait",
    description: "Wait for a CSS selector to be attached to the DOM or become visible. Use this after navigation or an action instead of fixed sleeps.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to wait for" },
        state: { type: "string", enum: ["attached", "visible"], description: "Condition to wait for (default: visible)" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 20000, description: "Timeout in milliseconds (default: 5000)" },
        pollMs: { type: "integer", minimum: 50, maximum: 1000, description: "Polling interval in milliseconds (default: 100)" },
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional, defaults to most recent)" },
      },
      required: ["selector"],
    },
    handler: async (args) => relayPost("/api/wait", args),
  },
  {
    name: "browser_click",
    description: "Click an element on the page by CSS selector. Scrolls the element into view first. Returns the text of the clicked element.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the element to click (e.g. 'button.submit', 'a[href=\"...\"]')" },
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional)" },
        doubleClick: { type: "boolean", description: "Double-click instead of single click" },
      },
      required: ["selector"],
    },
    handler: async (args) => relayPost("/api/click", args),
  },
  {
    name: "browser_type",
    description: "Type text into an input field. Optionally focus an element by CSS selector first. Can clear the field and/or press Enter to submit.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type" },
        selector: { type: "string", description: "CSS selector to focus before typing (optional)" },
        submit: { type: "boolean", description: "Press Enter after typing" },
        clear: { type: "boolean", description: "Clear the field before typing" },
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional)" },
      },
      required: ["text"],
    },
    handler: async (args) => relayPost("/api/type", args),
  },
  {
    name: "browser_key",
    description: "Press a key or keyboard shortcut in the active page using real Chrome keyboard events. Use for Enter, Escape, Tab, Arrow keys, or shortcuts like Control+L.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Single key to press, e.g. Enter, Escape, ArrowDown, a" },
        combo: { type: "string", description: "Shortcut combo, e.g. Control+L, Shift+Tab, Meta+K" },
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional)" },
        ctrl: { type: "boolean", description: "Hold Control while pressing key" },
        alt: { type: "boolean", description: "Hold Alt/Option while pressing key" },
        shift: { type: "boolean", description: "Hold Shift while pressing key" },
        meta: { type: "boolean", description: "Hold Meta/Command/Windows while pressing key" },
        text: { type: "string", description: "Optional text generated by this key event" },
      },
    },
    handler: async (args) => relayPost("/api/key", args),
  },
  {
    name: "browser_scroll",
    description: "Scroll the page in a direction (up, down, top, bottom).",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "top", "bottom"], description: "Scroll direction" },
        amount: { type: "number", description: "Pixels to scroll (default: 800)" },
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional)" },
      },
      required: ["direction"],
    },
    handler: async (args) => relayPost("/api/scroll", args),
  },
  {
    name: "browser_screenshot",
    description: "Capture a PNG screenshot of the page. Returns base64-encoded image data. Use to visually inspect the current page state.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional)" },
        fullPage: { type: "boolean", description: "Capture the full scrollable page" },
      },
    },
    handler: async (args) => relayPost("/api/screenshot", args || {}),
  },
  {
    name: "browser_eval",
    description: "Evaluate a JavaScript expression in the page context. The escape hatch for any operation not covered by other tools. Returns the evaluation result.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JavaScript expression to evaluate" },
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional)" },
      },
      required: ["expression"],
    },
    handler: async (args) => relayPost("/api/eval", args),
  },
  {
    name: "browser_download",
    description: "Get the URL of an image, link, or media element on the page for downloading.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to find the element (e.g. 'img', 'a.download-link')" },
        tabId: { type: "string", description: "Tab ID from browser_tabs (optional)" },
      },
      required: ["selector"],
    },
    handler: async (args) => relayPost("/api/download", args),
  },
  {
    name: "browser_download_start",
    description: "Start a real Chrome download from a URL using the browser profile's download manager.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to download" },
        filename: { type: "string", description: "Optional relative filename/path suggested to Chrome" },
        saveAs: { type: "boolean", description: "Ask Chrome to show the save-as dialog" },
        conflictAction: { type: "string", enum: ["uniquify", "overwrite", "prompt"], description: "How Chrome should handle filename conflicts" },
      },
      required: ["url"],
    },
    handler: async (args) => relayPost("/api/download/start", args),
  },
  {
    name: "browser_downloads",
    description: "List Chrome downloads and recent Browser Relay download events. Use clear=true to clear captured relay events.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Filter by Chrome download id" },
        state: { type: "string", enum: ["in_progress", "interrupted", "complete"], description: "Filter by download state" },
        url: { type: "string", description: "Filter by exact URL" },
        filename: { type: "string", description: "Filter by exact filename" },
        query: { type: "string", description: "Search term passed to chrome.downloads.search" },
        limit: { type: "number", description: "Maximum downloads/events to return" },
        clear: { type: "boolean", description: "Clear relay-captured download events" },
      },
    },
    handler: async (args) => {
      if (args.clear) return relayPost("/api/downloads/clear", {});
      const params = new URLSearchParams();
      addQueryParam(params, "id", args.id);
      addQueryParam(params, "state", args.state);
      addQueryParam(params, "url", args.url);
      addQueryParam(params, "filename", args.filename);
      addQueryParam(params, "query", args.query);
      addQueryParam(params, "limit", args.limit);
      const qs = params.toString();
      return relayGet(`/api/downloads${qs ? "?" + qs : ""}`);
    },
  },
];

const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// JSON-RPC / MCP protocol over stdio
// ---------------------------------------------------------------------------
let initialized = false;

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendResult(id, result) { send({ jsonrpc: "2.0", id, result }); }
function sendError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    initialized = true;
    return sendResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "browser-relay-mcp", version: PACKAGE_VERSION },
    });
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    return sendResult(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const tool = toolMap.get(toolName);
    if (!tool) {
      return sendResult(id, { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true });
    }
    try {
      const result = await tool.handler(params?.arguments || {});
      return sendResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      return sendResult(id, { content: [{ type: "text", text: JSON.stringify(toolErrorPayload(err), null, 2) }], isError: true });
    }
  }

  if (method === "ping") return sendResult(id, {});

  if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// Stdio transport: read Content-Length framed JSON-RPC messages
// ---------------------------------------------------------------------------
let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const headerBlock = buffer.slice(0, headerEnd);
    const match = headerBlock.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;
    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);
    try {
      const msg = JSON.parse(body);
      handleMessage(msg).catch((err) => {
        console.error("MCP handler error:", err);
        if (msg.id !== undefined) sendError(msg.id, -32603, err.message || String(err));
      });
    } catch (err) {
      console.error("MCP parse error:", err);
    }
  }
});

process.stdin.on("end", () => process.exit(0));

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

const RELAY_URL = (process.env.BROWSER_RELAY_URL || "http://127.0.0.1:18795").replace(/\/$/, "");
const RELAY_PORT = parseInt(new URL(RELAY_URL).port || "18795", 10);
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;

// ---------------------------------------------------------------------------
// HTTP client to relay
// ---------------------------------------------------------------------------
async function relayRequest(method, path, body) {
  const url = `${RELAY_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  const opts = { method, headers };
  if (body !== undefined && method !== "GET") opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return await res.json();
}

async function relayGet(path) { return relayRequest("GET", path); }
async function relayPost(path, body) { return relayRequest("POST", path, body); }

function addQueryParam(params, name, value) {
  if (value !== undefined && value !== null && value !== "") params.set(name, String(value));
}

const LOCATOR_SCHEMA = {
  type: "object",
  properties: {
    selector: { type: "string", description: "CSS selector to narrow or find the element" },
    text: { type: "string", description: "Visible text to match" },
    role: { type: "string", description: "Approximate ARIA or implicit role, e.g. button, link, textbox" },
    name: { type: "string", description: "Approximate accessible name, aria-label, placeholder, title, value, or text" },
    label: { type: "string", description: "Associated label text" },
    placeholder: { type: "string", description: "Placeholder text" },
    alt: { type: "string", description: "Alt text" },
    title: { type: "string", description: "Title text" },
    testId: { type: "string", description: "Test id from data-testid, data-test-id, data-test, data-cy, or data-qa" },
    exact: { type: "boolean", description: "Require exact string match instead of substring match" },
  },
};

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
        tabId: { type: "string", description: "Tab targetId (optional, defaults to most recent)" },
      },
      required: ["url"],
    },
    handler: async (args) => relayPost("/api/navigate", args),
  },
  {
    name: "browser_frames",
    description: "List the frame tree for a browser tab. Use this before interacting with iframes; pass the returned frameId to snapshot, click, type, scroll, eval, wait, or download.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab targetId (optional)" },
      },
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      addQueryParam(params, "tabId", args.tabId);
      const qs = params.toString();
      return relayGet(`/api/frames${qs ? "?" + qs : ""}`);
    },
  },
  {
    name: "browser_snapshot",
    description: "Get a text representation of the page. Returns annotated text with clickable elements (links, buttons, inputs) marked for easy reference. Use this to understand what is on the page before interacting.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
        format: { type: "string", enum: ["text", "html"], description: "Output format (default: text)" },
        maxLength: { type: "number", description: "Max output length (default: 100000)" },
      },
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      addQueryParam(params, "tabId", args.tabId);
      addQueryParam(params, "frameId", args.frameId);
      addQueryParam(params, "format", args.format);
      addQueryParam(params, "maxLength", args.maxLength);
      const qs = params.toString();
      return relayGet(`/api/snapshot${qs ? "?" + qs : ""}`);
    },
  },
  {
    name: "browser_click",
    description: "Click an element on the page by CSS selector or locator. Scrolls the element into view first. Returns the text of the clicked element.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the element to click (e.g. 'button.submit', 'a[href=\"...\"]')" },
        locator: LOCATOR_SCHEMA,
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
        button: { type: "string", enum: ["left", "middle", "right"], description: "Mouse button (default: left)" },
        doubleClick: { type: "boolean", description: "Double-click instead of single click" },
      },
    },
    handler: async (args) => relayPost("/api/click", args),
  },
  {
    name: "browser_type",
    description: "Type text into an input field. Optionally focus an element by CSS selector or locator first. Can clear the field and/or press Enter to submit.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type" },
        selector: { type: "string", description: "CSS selector to focus before typing (optional)" },
        locator: LOCATOR_SCHEMA,
        submit: { type: "boolean", description: "Press Enter after typing" },
        clear: { type: "boolean", description: "Clear the field before typing" },
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
      },
      required: ["text"],
    },
    handler: async (args) => relayPost("/api/type", args),
  },
  {
    name: "browser_scroll",
    description: "Scroll the page in a direction (up, down, top, bottom).",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "top", "bottom"], description: "Scroll direction" },
        amount: { type: "number", description: "Pixels to scroll (default: 800)" },
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
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
        tabId: { type: "string", description: "Tab targetId (optional)" },
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
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
      },
      required: ["expression"],
    },
    handler: async (args) => relayPost("/api/eval", args),
  },
  {
    name: "browser_wait",
    description: "Wait for a selector, locator, text, URL substring/regex, or JavaScript expression to become true. Supports frameId for iframe waits.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to wait for" },
        locator: LOCATOR_SCHEMA,
        visible: { type: "boolean", description: "Require selector or locator to be visible" },
        text: { type: "string", description: "Text that must appear in document body" },
        url: { type: "string", description: "URL substring that must appear in location.href" },
        urlRegex: { type: "string", description: "Regular expression that must match location.href" },
        expression: { type: "string", description: "JavaScript expression that must evaluate truthy" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds (default: 10000, max: 120000)" },
        pollMs: { type: "number", description: "Polling interval in milliseconds (default: 250)" },
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
      },
    },
    handler: async (args) => relayPost("/api/wait", args),
  },
  {
    name: "browser_cdp",
    description: "Advanced escape hatch: send a raw Chrome DevTools Protocol command to the attached tab. Use only when high-level tools are insufficient.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "CDP method, e.g. Runtime.evaluate" },
        params: { type: "object", description: "CDP params object" },
        tabId: { type: "string", description: "Tab targetId (optional)" },
        sessionId: { type: "string", description: "Raw debugger session id (optional)" },
      },
      required: ["method"],
    },
    handler: async (args) => relayPost("/api/cdp", args),
  },
  {
    name: "browser_download",
    description: "Get the URL of an image, link, or media element on the page for downloading.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to find the element (e.g. 'img', 'a.download-link')" },
        locator: LOCATOR_SCHEMA,
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
      },
    },
    handler: async (args) => relayPost("/api/download", args),
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
      return sendResult(id, { content: [{ type: "text", text: `Error: ${err.message || err}` }], isError: true });
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

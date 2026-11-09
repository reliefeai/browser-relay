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
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createTransport } from "./sdk.js";
import { isAutomationPath, isTaskRequest } from "../extension/protocol.js";
const callContext=new AsyncLocalStorage(), calls=new Map(), ownedSessions=new Set();
const defaultSession=`mcp-${randomUUID()}`;
import { DEFAULT_REMOTE_HOST, parseRemoteDeviceId, remoteHttpBase } from "./remote-protocol.js";
import { createScriptRuntime, EXEC_DESCRIPTION } from "./script-runtime.js";

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

async function relayRequest(method, path, body, options = {}) {
  const context=callContext.getStore();
  if (context?.controller.signal.aborted) throw relayToolError(errorPayload('request_cancelled','Request cancelled',{status:409}));
  options={...options,signal:options.signal || context?.controller.signal};
  if(isAutomationPath(path.split('?')[0]) && !path.startsWith('/api/capabilities')) {
    const existing=new URL(path,'http://relay.local').searchParams.get('sessionId');
    const sessionId=body?.sessionId || existing || defaultSession;
    if(method==='GET' && !existing) path+=`${path.includes('?')?'&':'?'}sessionId=${encodeURIComponent(sessionId)}`;
    if(method==='POST')body={...body,sessionId};
    if(body?.action==='stop')ownedSessions.delete(sessionId);else ownedSessions.add(sessionId);
    if(method==='POST' && isTaskRequest(method,path.split('?')[0])) {
      body.taskId ||= `job_${randomUUID()}`;
      context?.tasks.push({id:body.taskId,sessionId});
    }
  }
  const remoteContext = remoteContextFromEnv();
  const transport = createTransport({url:RELAY_URL,remoteDeviceId:remoteContext?.remoteDeviceId || '',remoteHost:remoteContext?.host});
  try { return await transport(method,path,body,options); }
  catch (err) {
    const payload=err.payload || errorPayload('mcp_tool_error',err.message);
    if(payload.code==='transport_error') {
      payload.code=remoteContext?'remote_hub_unreachable':'relay_unreachable';
      payload.message=`Cannot reach Browser Relay${remoteContext?' Hub':''}: ${payload.message}`;
    }
    throw relayToolError(payload);
  }
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

const scriptRuntime = createScriptRuntime({request:(...args)=>callContext.exit(()=>relayRequest(...args))});
TOOLS.push(
  {name:'browser_read',description:'Read complete main-page content, preserving semantic groups, full links and actionable refs. target selects an observed subtree. When truncated, follow nextCursor with cursor to finish the same captured observation. Use screenshots if readable content is missing; do not mistake loading states for success.',inputSchema:{type:'object',properties:{tabId:{type:'string'},sessionId:{type:'string'},target:{type:'object'},cursor:{type:'string'},maxLength:{type:'integer'},diff:{type:'boolean'}},required:['tabId']},handler:args=>relayPost('/api/read',args)},
  {name:'browser_tab',description:'Create, focus, claim, release, handoff, or close a task tab. Keep new and existing tabs in the background by default; focus only when the user explicitly requests foreground operation. Another active owner must release or handoff before you operate it. close removes a tab; release only relinquishes ownership. Do not close pre-existing user tabs without authorization.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['create','focus','claim','release','handoff','close']},tabId:{type:'string'},url:{type:'string'},sessionId:{type:'string'},toSessionId:{type:'string'},label:{type:'string'}},required:['action']},handler:args=>relayPost(`/api/tabs/${args.action}`,args)},
  {name:'browser_session',description:'List tab ownership, renew a session heartbeat, or stop its pending work and release claims. Stopping does not undo actions or close user tabs; a stopped session cannot restart implicitly.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['list','heartbeat','stop']},sessionId:{type:'string'}},required:['action']},handler:args=>args.action==='list'?relayGet('/api/sessions'):relayPost('/api/sessions',args)},
  {name:'browser_observe',description:'Read current accessibility state with actionable refs, frame IDs and viewport. Use diff=true within one session to reduce unchanged output. Screenshot mode returns an image and coordinate mapping.',inputSchema:{type:'object',properties:{tabId:{type:'string'},sessionId:{type:'string'},mode:{type:'string',enum:['snapshot','read','screenshot','both']},target:{type:'object'},cursor:{type:'string'},diff:{type:'boolean'},maxLength:{type:'integer'},fullPage:{type:'boolean'}},required:['tabId']},handler:args=>relayPost('/api/observe',args)},
  {name:'browser_actions',description:'Execute a short ordered group of known browser actions on one explicit tab, then return updated state. Supported types: click, double_click, hover, move, drag, fill, type, key, scroll, wait, select, check, navigate, focus. scroll waitForChange reports text progress; background scroll uses DOM scrolling without activating the tab. Keep the user foreground unchanged; use focus or allowFocus only when the user explicitly requests foreground operation. navigate waits for document readiness; add wait for site-specific content. target is {ref}, {selector}, or {role,name,frameId?,scope?}. Optional per-action timeoutMs waits for readiness before dispatch; it never repeats dispatched input. wait also supports state=enabled. Coordinates use CSS viewport pixels, or image pixels when screenshotId is supplied. Stops at the first error. async=true returns a cancellable task.',inputSchema:{type:'object',properties:{tabId:{type:'string'},actions:{type:'array',items:{type:'object'},minItems:1,maxItems:100},observe:{type:'string',enum:['none','snapshot','read','screenshot','both']},sessionId:{type:'string'},async:{type:'boolean'},timeoutMs:{type:'integer'},maxLength:{type:'integer'}},required:['tabId','actions']},handler:args=>relayPost('/api/actions',args)},
  {name:'browser_task',description:'Get a browser task or cancel pending actions. Cancellation does not undo completed actions.',inputSchema:{type:'object',properties:{id:{type:'string'},cancel:{type:'boolean'},sessionId:{type:'string'}},required:['id']},handler:args=>args.cancel?relayPost(`/api/tasks/${encodeURIComponent(args.id)}/cancel`,{sessionId:args.sessionId}):relayGet(`/api/tasks/${encodeURIComponent(args.id)}?sessionId=${encodeURIComponent(args.sessionId||defaultSession)}`)},
  {name:'browser_exec',description:EXEC_DESCRIPTION,inputSchema:{type:'object',properties:{code:{type:'string'},sessionId:{type:'string'},timeoutMs:{type:'integer'}},required:['code']},handler:args=>scriptRuntime.execute(args)},
  {name:'browser_exec_reset',description:'Reset one persistent JavaScript session and request cancellation of its pending browser tasks. Existing tabs remain open.',inputSchema:{type:'object',properties:{sessionId:{type:'string'}}},handler:async args=>{await scriptRuntime.reset(args.sessionId);return {ok:true};}},
);
const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

function toolContent(result) {
  if(Array.isArray(result?.content)) return result;
  const observation=result?.task?.observation || result;
  const shot=observation?.screenshot || (observation?.data ? observation : null);
  if(shot?.format==='png') {
    const {data,...metadata}=shot;
    const obs=observation.screenshot ? {...observation,screenshot:metadata} : metadata;
    const value=result.task ? {...result,task:{...result.task,observation:obs}} : obs;
    return {content:[{type:'image',data,mimeType:'image/png'},{type:'text',text:JSON.stringify(value)}]};
  }
  return {content:[{type:'text',text:JSON.stringify(result)}]};
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP protocol over stdio
// ---------------------------------------------------------------------------
let initialized = false;
let transportFormat = 'framed';

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(transportFormat === 'ndjson' ? json+'\n' : `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
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
  if (method === 'notifications/cancelled') {
    const context=calls.get(params?.requestId);
    if(context) {
      context.controller.abort();
      if(context.runtimeSession!==undefined)await scriptRuntime.reset(context.runtimeSession);
      await Promise.allSettled(context.tasks.map(task=>callContext.exit(()=>relayRequest('POST',`/api/tasks/${encodeURIComponent(task.id)}/cancel`,{sessionId:task.sessionId},{timeoutMs:2500}))));
    }
    return;
  }

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
    const context={controller:new AbortController(),tasks:[],...(toolName==='browser_exec'?{runtimeSession:params?.arguments?.sessionId || 'default'}:{})};calls.set(id,context);
    try {
      const result = await callContext.run(context,()=>tool.handler(params?.arguments || {}));
      return sendResult(id, toolContent(result));
    } catch (err) {
      if (context.controller.signal.aborted) {
        const payload={...toolErrorPayload(err),code:'request_cancelled',message:'Request cancelled; completed actions were not undone',retryable:false};
        return sendResult(id,{content:[{type:'text',text:JSON.stringify(payload,null,2)}],isError:true});
      }
      return sendResult(id, { content: [{ type: "text", text: JSON.stringify(toolErrorPayload(err), null, 2) }], isError: true });
    } finally {calls.delete(id)}
  }

  if (method === "ping") return sendResult(id, {});

  if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// Stdio transport: read Content-Length framed JSON-RPC messages
// ---------------------------------------------------------------------------
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer,chunk]);
  while (true) {
    if(buffer.length > 32*1024*1024) {process.stdin.destroy();void scriptRuntime.close();return;}
    if(buffer[0]===123) {
      const end=buffer.indexOf('\n');if(end===-1)break;
      transportFormat='ndjson';
      const line=buffer.subarray(0,end).toString('utf8');buffer=buffer.subarray(end+1);
      try {const msg=JSON.parse(line);void handleMessage(msg).catch(error=>sendError(msg.id,-32603,error.message));}catch(error){sendError(null,-32700,error.message);}
      continue;
    }
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const headerBlock = buffer.subarray(0, headerEnd).toString('ascii');
    const match = headerBlock.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;
    const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8');
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

const heartbeat=setInterval(()=>{for(const sessionId of ownedSessions)void relayRequest('POST','/api/sessions',{sessionId,action:'heartbeat'},{timeoutMs:5000}).catch(()=>ownedSessions.delete(sessionId));},40000);
heartbeat.unref();
async function shutdown(){clearInterval(heartbeat);for(const context of calls.values())context.controller.abort();await scriptRuntime.close();await Promise.allSettled([...ownedSessions].map(sessionId=>relayRequest('POST','/api/sessions',{sessionId,action:'stop'},{timeoutMs:2500})));process.exit(0)}
process.stdin.on('end',shutdown);
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);

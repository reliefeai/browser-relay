#!/usr/bin/env node
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  bearerToken,
  errorPayload,
  jsonHeaders,
  REMOTE_RPC_TIMEOUT_MS,
  safeEqualString,
  sha256Hex,
} from "./remote-protocol.js";

const HUB_HOST = process.env.BROWSER_RELAY_HUB_HOST || "127.0.0.1";
const HUB_PORT = Number.parseInt(process.env.BROWSER_RELAY_HUB_PORT || "18796", 10);
const MAX_BODY_SIZE = 128 * 1024;

const devices = new Map(); // routeId -> { secretHash, ws, hello, connectedAt, lastSeen, pending }

function log(event, data = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...data }));
}

function jsonResponse(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...jsonHeaders(extraHeaders), "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) throw Object.assign(new Error("Request body too large"), { status: 413, code: "request_body_too_large" });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error("Invalid JSON in request body"), { status: 400, code: "invalid_json" }); }
}

function getDevice(routeId) {
  let device = devices.get(routeId);
  if (!device) {
    device = { secretHash: null, ws: null, hello: null, connectedAt: null, lastSeen: null, pending: new Map() };
    devices.set(routeId, device);
  }
  return device;
}

function authorizeDevice(routeId, secret) {
  if (!routeId || !secret) return { ok: false, status: 401, code: "invalid_remote_device", message: "Invalid or missing remote device credentials" };
  const device = getDevice(routeId);
  const secretHash = sha256Hex(secret);
  if (!device.secretHash) {
    device.secretHash = secretHash;
    return { ok: true, device, claimed: true };
  }
  if (!safeEqualString(device.secretHash, secretHash)) {
    return { ok: false, status: 401, code: "invalid_remote_device", message: "Invalid or revoked remote device id" };
  }
  return { ok: true, device, claimed: false };
}

function rejectUpgrade(socket, status, message) {
  const body = JSON.stringify(errorPayload(status === 401 ? "invalid_remote_device" : "upgrade_failed", message, { status }));
  socket.write(`HTTP/1.1 ${status} ${message}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  socket.destroy();
}

function clearPending(device, payload) {
  for (const [id, pending] of device.pending) {
    clearTimeout(pending.timer);
    pending.reject(payload);
    device.pending.delete(id);
  }
}

function handleDeviceMessage(routeId, device, raw) {
  let msg;
  try { msg = JSON.parse(String(raw)); }
  catch { return; }
  device.lastSeen = new Date().toISOString();

  if (msg.type === "device.hello") {
    device.hello = msg;
    return;
  }

  if (msg.type === "rpc.response" && msg.id) {
    const pending = device.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    device.pending.delete(msg.id);
    pending.resolve(msg);
  }
}

function sendRpcToDevice(device, request) {
  if (!device.ws || device.ws.readyState !== WebSocket.OPEN) {
    throw errorPayload("remote_device_offline", "Remote Browser Relay device is offline", { status: 409, retryable: true });
  }

  const id = request.id || `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const frame = {
    type: "rpc.request",
    id,
    method: request.method,
    path: request.path,
    headers: request.headers || {},
    body: request.body ?? null,
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      device.pending.delete(id);
      reject(errorPayload("remote_request_timeout", "Remote device did not respond before timeout", { status: 504, retryable: true }));
    }, REMOTE_RPC_TIMEOUT_MS);
    device.pending.set(id, { resolve, reject, timer });
    try { device.ws.send(JSON.stringify(frame)); }
    catch (err) {
      clearTimeout(timer);
      device.pending.delete(id);
      reject(errorPayload("remote_send_failed", err instanceof Error ? err.message : String(err), { status: 502, retryable: true }));
    }
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/v1/health")) {
      return jsonResponse(res, 200, { ok: true, service: "browser-relay-hub", devices: devices.size });
    }

    if (req.method === "GET" && url.pathname.startsWith("/v1/status/")) {
      const routeId = decodeURIComponent(url.pathname.slice("/v1/status/".length));
      const secret = bearerToken(req.headers);
      const auth = authorizeDevice(routeId, secret);
      if (!auth.ok) return jsonResponse(res, auth.status, errorPayload(auth.code, auth.message, { status: auth.status }));
      const device = auth.device;
      return jsonResponse(res, 200, {
        ok: true,
        routeId,
        connected: !!device.ws && device.ws.readyState === WebSocket.OPEN,
        connectedAt: device.connectedAt,
        lastSeen: device.lastSeen,
        hello: device.hello,
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/rpc") {
      const body = await readBody(req);
      const routeId = String(body.routeId || "");
      const secret = bearerToken(req.headers);
      const auth = authorizeDevice(routeId, secret);
      if (!auth.ok) return jsonResponse(res, auth.status, errorPayload(auth.code, auth.message, { status: auth.status }));
      if (!body.method || !body.path) {
        return jsonResponse(res, 400, errorPayload("invalid_request", "method and path are required", { status: 400 }));
      }

      try {
        const response = await sendRpcToDevice(auth.device, body);
        const status = Number(response.status) || 200;
        const responseBody = response.body ?? null;
        const headers = response.headers && typeof response.headers === "object" ? response.headers : {};
        if (typeof responseBody === "string") {
          res.writeHead(status, { "Content-Type": headers["content-type"] || headers["Content-Type"] || "text/plain" });
          res.end(responseBody);
        } else {
          jsonResponse(res, status, responseBody, headers);
        }
      } catch (err) {
        const payload = err && typeof err === "object" && "code" in err
          ? err
          : errorPayload("remote_rpc_failed", err instanceof Error ? err.message : String(err), { status: 502, retryable: true });
        jsonResponse(res, payload.status || 502, payload);
      }
      return;
    }

    jsonResponse(res, 404, errorPayload("endpoint_not_found", `Unknown hub endpoint: ${url.pathname}`, { status: 404 }));
  } catch (err) {
    const status = err.status || 500;
    const code = err.code || "internal_error";
    jsonResponse(res, status, errorPayload(code, err instanceof Error ? err.message : String(err), { status }));
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/v1/device/connect") return rejectUpgrade(socket, 404, "Not Found");
  const routeId = url.searchParams.get("routeId") || "";
  const secret = url.searchParams.get("token") || bearerToken(req.headers);
  const auth = authorizeDevice(routeId, secret);
  if (!auth.ok) return rejectUpgrade(socket, auth.status, "Unauthorized");

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, routeId, auth.device, auth.claimed);
  });
});

wss.on("connection", (ws, req, routeId, device, claimed) => {
  if (device.ws && device.ws.readyState === WebSocket.OPEN) {
    try { device.ws.close(4001, "superseded"); } catch {}
  }
  device.ws = ws;
  device.connectedAt = new Date().toISOString();
  device.lastSeen = device.connectedAt;
  log("device.connect", { routeId, claimed, remote: req.socket.remoteAddress || "unknown" });

  ws.on("message", (raw) => handleDeviceMessage(routeId, device, raw));
  ws.on("close", (code, reason) => {
    if (device.ws !== ws) return;
    device.ws = null;
    device.lastSeen = new Date().toISOString();
    clearPending(device, errorPayload("remote_device_offline", "Remote Browser Relay device disconnected", { status: 409, retryable: true }));
    log("device.disconnect", { routeId, code, reason: reason ? String(reason) : "" });
  });
  ws.on("error", () => {});
});

server.listen(HUB_PORT, HUB_HOST, () => {
  console.log(`Browser Relay Hub listening on http://${HUB_HOST}:${HUB_PORT}`);
  console.log(`Device WSS: ws://${HUB_HOST}:${HUB_PORT}/v1/device/connect?routeId=...`);
  console.log(`RPC:        http://${HUB_HOST}:${HUB_PORT}/v1/rpc`);
});

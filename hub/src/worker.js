const MAX_BODY_SIZE = 128 * 1024;
const RPC_TIMEOUT_MS = 30_000;

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function errorPayload(code, message, { status = 500, retryable = false, details } = {}) {
  const payload = { ok: false, code, error: message, message, status, retryable };
  if (details !== undefined) payload.details = details;
  return payload;
}

function bearerToken(headers) {
  const auth = headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1].trim() : "";
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_SIZE) {
    throw Object.assign(new Error("Request body too large"), { status: 413, code: "request_body_too_large" });
  }
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error("Invalid JSON in request body"), { status: 400, code: "invalid_json" }); }
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqualString(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function isRouteId(value) {
  return /^[A-Za-z0-9_-]{10,}$/.test(String(value || ""));
}

function isSecret(value) {
  return /^[A-Za-z0-9_-]{16,}$/.test(String(value || ""));
}

function websocketPair() {
  const pair = new WebSocketPair();
  const values = Object.values(pair);
  return { client: values[0], server: values[1] };
}

export class BrowserRelayDevice {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.deviceSocket = null;
    this.connectedAt = null;
    this.lastSeen = null;
    this.hello = null;
    this.pending = new Map();
    // In-memory only — nothing is persisted. A route exists only while its device
    // is connected (the DO stays resident on the open WS); once it drops and the DO
    // evicts, all state is gone. No storage writes → no zombie routes to clean up.
    this.secretHash = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/v1/device/connect") return this.handleDeviceConnect(request, url);
      if (url.pathname === "/v1/rpc") return this.handleRpc(request);
      if (url.pathname === "/v1/status") return this.handleStatus(request);
      return jsonResponse(errorPayload("endpoint_not_found", `Unknown device endpoint: ${url.pathname}`, { status: 404 }), 404);
    } catch (err) {
      const status = err.status || 500;
      const code = err.code || "internal_error";
      return jsonResponse(errorPayload(code, err instanceof Error ? err.message : String(err), { status }), status);
    }
  }

  // secretHash lives only in memory. The device's connect claims it (claim: true);
  // CLI rpc/status must match a live claim — no device connected means no claim,
  // which reads as "offline" rather than silently registering a credential.
  async authorize(secret, { claim = false } = {}) {
    if (!isSecret(secret)) {
      return { ok: false, status: 401, code: "invalid_remote_device", message: "Invalid or missing remote device credentials" };
    }
    const incomingHash = await sha256Hex(secret);
    if (!this.secretHash) {
      if (claim) { this.secretHash = incomingHash; return { ok: true, claimed: true }; }
      return { ok: false, status: 409, code: "remote_device_offline", message: "Remote Browser Relay device is offline", retryable: true };
    }
    if (!safeEqualString(this.secretHash, incomingHash)) {
      return { ok: false, status: 401, code: "invalid_remote_device", message: "Invalid or revoked remote device id" };
    }
    return { ok: true, claimed: false };
  }

  async handleDeviceConnect(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return jsonResponse(errorPayload("upgrade_required", "WebSocket upgrade required", { status: 426 }), 426);
    }
    const secret = url.searchParams.get("token") || bearerToken(request.headers);
    const auth = await this.authorize(secret, { claim: true });
    if (!auth.ok) return jsonResponse(errorPayload(auth.code, auth.message, { status: auth.status }), auth.status);

    if (this.deviceSocket && this.deviceSocket.readyState === WebSocket.OPEN) {
      try { this.deviceSocket.close(4001, "superseded"); } catch {}
    }

    const { client, server } = websocketPair();
    server.accept();
    this.deviceSocket = server;
    this.connectedAt = new Date().toISOString();
    this.lastSeen = this.connectedAt;

    server.addEventListener("message", (event) => this.handleDeviceMessage(event.data));
    server.addEventListener("close", () => this.handleDeviceClose(server));
    server.addEventListener("error", () => this.handleDeviceClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  handleDeviceMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); }
    catch { return; }
    this.lastSeen = new Date().toISOString();

    if (msg.type === "device.hello") {
      this.hello = msg;
      return;
    }

    if (msg.type === "rpc.response" && msg.id) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      pending.resolve(msg);
    }
  }

  handleDeviceClose(socket) {
    if (this.deviceSocket !== socket) return;
    this.deviceSocket = null;
    this.lastSeen = new Date().toISOString();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(errorPayload("remote_device_offline", "Remote Browser Relay device disconnected", { status: 409, retryable: true }));
      this.pending.delete(id);
    }
  }

  async handleRpc(request) {
    const body = await readJson(request);
    const secret = bearerToken(request.headers);
    const auth = await this.authorize(secret);
    if (!auth.ok) return jsonResponse(errorPayload(auth.code, auth.message, { status: auth.status }), auth.status);
    if (!body.method || !body.path) {
      return jsonResponse(errorPayload("invalid_request", "method and path are required", { status: 400 }), 400);
    }

    try {
      const response = await this.sendRpcToDevice(body);
      const status = Number(response.status) || 200;
      if (typeof response.body === "string") {
        return new Response(response.body, {
          status,
          headers: {
            "Content-Type": response.headers?.["content-type"] || response.headers?.["Content-Type"] || "text/plain",
            "Cache-Control": "no-store",
          },
        });
      }
      return jsonResponse(response.body ?? null, status);
    } catch (err) {
      const payload = err && typeof err === "object" && "code" in err
        ? err
        : errorPayload("remote_rpc_failed", err instanceof Error ? err.message : String(err), { status: 502, retryable: true });
      return jsonResponse(payload, payload.status || 502);
    }
  }

  sendRpcToDevice(requestBody) {
    if (!this.deviceSocket || this.deviceSocket.readyState !== WebSocket.OPEN) {
      throw errorPayload("remote_device_offline", "Remote Browser Relay device is offline", { status: 409, retryable: true });
    }

    const id = requestBody.id || `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const frame = {
      type: "rpc.request",
      id,
      method: requestBody.method,
      path: requestBody.path,
      headers: requestBody.headers || {},
      body: requestBody.body ?? null,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(errorPayload("remote_request_timeout", "Remote device did not respond before timeout", { status: 504, retryable: true }));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { this.deviceSocket.send(JSON.stringify(frame)); }
      catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(errorPayload("remote_send_failed", err instanceof Error ? err.message : String(err), { status: 502, retryable: true }));
      }
    });
  }

  async handleStatus(request) {
    const routeId = new URL(request.url).searchParams.get("routeId") || "";
    const secret = bearerToken(request.headers);
    const auth = await this.authorize(secret);
    if (!auth.ok) return jsonResponse(errorPayload(auth.code, auth.message, { status: auth.status }), auth.status);
    return jsonResponse({
      ok: true,
      routeId,
      connected: !!this.deviceSocket && this.deviceSocket.readyState === WebSocket.OPEN,
      connectedAt: this.connectedAt,
      lastSeen: this.lastSeen,
      hello: this.hello,
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/v1/health")) {
        return jsonResponse({ ok: true, service: "browser-relay-hub", host: url.host });
      }

      if (request.method === "GET" && url.pathname === "/v1/device/connect") {
        const routeId = url.searchParams.get("routeId") || "";
        if (!isRouteId(routeId)) return jsonResponse(errorPayload("invalid_remote_device", "Invalid route id", { status: 401 }), 401);
        const id = env.DEVICES.idFromName(routeId);
        return env.DEVICES.get(id).fetch(request);
      }

      if (request.method === "POST" && url.pathname === "/v1/rpc") {
        const body = await readJson(request.clone());
        const routeId = String(body.routeId || "");
        if (!isRouteId(routeId)) return jsonResponse(errorPayload("invalid_remote_device", "Invalid route id", { status: 401 }), 401);
        const id = env.DEVICES.idFromName(routeId);
        return env.DEVICES.get(id).fetch(new Request("https://device.local/v1/rpc", {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(body),
        }));
      }

      if (request.method === "GET" && url.pathname.startsWith("/v1/status/")) {
        const routeId = decodeURIComponent(url.pathname.slice("/v1/status/".length));
        if (!isRouteId(routeId)) return jsonResponse(errorPayload("invalid_remote_device", "Invalid route id", { status: 401 }), 401);
        const id = env.DEVICES.idFromName(routeId);
        return env.DEVICES.get(id).fetch(new Request(`https://device.local/v1/status?routeId=${encodeURIComponent(routeId)}`, {
          method: "GET",
          headers: request.headers,
        }));
      }

      return jsonResponse(errorPayload("endpoint_not_found", `Unknown hub endpoint: ${url.pathname}`, { status: 404 }), 404);
    } catch (err) {
      const status = err.status || 500;
      const code = err.code || "internal_error";
      return jsonResponse(errorPayload(code, err instanceof Error ? err.message : String(err), { status }), status);
    }
  },
};

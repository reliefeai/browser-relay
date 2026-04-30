#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = dirname(__dirname);
const EXTENSION_DIR = join(PKG_DIR, "extension");
const SKILL_PATH = join(PKG_DIR, "skill/SKILL.md");
const LAUNCHD_LABEL = "org.browser-relay.service";
const PLIST_PATH = join(homedir(), `Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
const SYSTEMD_UNIT = "browser-relay";
const SYSTEMD_PATH = join(homedir(), ".config/systemd/user/browser-relay.service");
const RELAY_HOST = process.env.BROWSER_RELAY_HOST || "127.0.0.1";
const RELAY_PORT = process.env.BROWSER_RELAY_PORT || "18795";
const RELAY_URL = (process.env.BROWSER_RELAY_URL || `http://${RELAY_HOST}:${RELAY_PORT}`).replace(/\/+$/, "");
const HEALTH_URL = `${RELAY_URL}/`;
const LOG_FILE = "/tmp/browser-relay.log";
const ERR_LOG_FILE = "/tmp/browser-relay.error.log";

const sys = platform();

async function run() {
  await import("./relay-server.js");
}

function ensureInstalled() {
  if (sys === "darwin" && existsSync(PLIST_PATH)) return true;
  if (sys === "linux" && existsSync(SYSTEMD_PATH)) return true;
  console.error("Background service not registered. Run: browser-relay install");
  process.exit(1);
}

async function install() {
  const mod = await import("./install.js");
  // install.js runs on import (top-level main())
  void mod;
}

async function uninstall() {
  await import("./uninstall.js");
}

function darwinDomain() {
  return `gui/${process.getuid()}`;
}

function start() {
  ensureInstalled();
  if (sys === "darwin") {
    const domain = darwinDomain();
    // Idempotent: bootout first (ignore "not found") then bootstrap.
    // `launchctl load` is legacy; bootstrap is the modern API that actually
    // works on macOS 13+.
    try { execSync(`launchctl bootout ${domain} "${PLIST_PATH}" 2>/dev/null`); } catch {}
    try { execSync(`launchctl bootstrap ${domain} "${PLIST_PATH}"`, { stdio: "inherit" }); }
    catch (e) { console.error(`launchctl bootstrap failed: ${e.message}`); process.exit(1); }
    console.log("Started. Check: browser-relay status");
  } else if (sys === "linux") {
    execSync(`systemctl --user start ${SYSTEMD_UNIT}`, { stdio: "inherit" });
    console.log("Started. Check: browser-relay status");
  } else {
    console.error(`'start' not supported on ${sys}. Run 'browser-relay' in foreground instead.`);
    process.exit(1);
  }
}

function stop() {
  if (sys === "darwin") {
    try { execSync(`launchctl bootout ${darwinDomain()} "${PLIST_PATH}"`, { stdio: "inherit" }); }
    catch { /* not loaded */ }
    console.log("Stopped.");
  } else if (sys === "linux") {
    execSync(`systemctl --user stop ${SYSTEMD_UNIT}`, { stdio: "inherit" });
    console.log("Stopped.");
  } else {
    console.error(`'stop' not supported on ${sys}.`);
    process.exit(1);
  }
}

function restart() {
  stop();
  start();
}

function status() {
  let loaded = false;
  let pid = null;
  if (sys === "darwin") {
    try {
      const out = execSync(`launchctl list | grep ${LAUNCHD_LABEL} || true`, { encoding: "utf-8" });
      if (out.trim()) {
        loaded = true;
        const [p] = out.trim().split(/\s+/);
        if (p && p !== "-") pid = p;
      }
    } catch {}
  } else if (sys === "linux") {
    try {
      const out = execSync(`systemctl --user is-active ${SYSTEMD_UNIT}`, { encoding: "utf-8" }).trim();
      loaded = out === "active";
    } catch {}
  }

  let healthy = false;
  try {
    execSync(`curl -s --max-time 2 ${HEALTH_URL} > /dev/null`, { stdio: "ignore" });
    healthy = true;
  } catch {}

  console.log(`Service:   ${loaded ? "loaded" : "not loaded"}${pid ? ` (pid ${pid})` : ""}`);
  console.log(`HTTP:      ${healthy ? "responding" : "not responding"} (${HEALTH_URL})`);
  console.log(`Extension: ${EXTENSION_DIR}`);
  console.log(`Logs:      ${LOG_FILE}`);
  process.exit(loaded && healthy ? 0 : 1);
}

function logs() {
  if (!existsSync(LOG_FILE)) {
    console.error(`No log file at ${LOG_FILE} yet. Start the service first.`);
    process.exit(1);
  }
  const child = spawn("tail", ["-f", LOG_FILE, ERR_LOG_FILE], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function path() {
  console.log(EXTENSION_DIR);
}

function skill() {
  const skillDir = join(PKG_DIR, "skill");
  console.log(`npx skills add "${skillDir}" -g`);
}

function info() {
  console.log(`Browser Relay`);
  console.log(`Extension:  ${EXTENSION_DIR}`);
  console.log(`Skill:      ${SKILL_PATH}`);
  console.log(`Health:     ${HEALTH_URL}`);
  console.log(``);
  console.log(`Load the extension:`);
  console.log(`  1. Open chrome://extensions`);
  console.log(`  2. Enable Developer mode`);
  console.log(`  3. Click "Load unpacked" and select:`);
  console.log(`     ${EXTENSION_DIR}`);
}

function help() {
  console.log(`browser-relay — universal browser control for AI agents

Usage:
  browser-relay [command]

Commands:
  (no args)   Run the relay server in foreground
  run         Same as no args
  start       Start as a background service (launchd/systemd)
  stop        Stop the background service
  restart     Restart the background service
  status      Show service + HTTP health
  logs        Tail the service logs
  path        Print the Chrome extension directory
  skill       Print the skill directory + 'npx skills' install command
  info        Show extension path + usage hints
  install     (Re)register the background service
  uninstall   Unregister the background service

Browser commands:
  tabs        List attached Chrome tabs
  snapshot    Print annotated page text
  click       Click an element by CSS selector
  type        Type text into an input or focused element
  scroll      Scroll the page
  screenshot  Save a PNG screenshot
  eval        Evaluate JavaScript in the page
  api-help    Show browser command examples

  --help,-h   Show this help
  --version   Show version

Env vars:
  BROWSER_RELAY_URL    Relay base URL (default http://127.0.0.1:18795)
  BROWSER_RELAY_HOST   Bind address (default 127.0.0.1)
  BROWSER_RELAY_PORT   HTTP + WS port (default 18795)
`);
}

async function version() {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf-8"));
  console.log(pkg.version);
}

const BOOLEAN_FLAGS = new Set([
  "base64", "clear", "double", "doubleClick", "fullPage", "json",
  "raw", "stdin", "submit",
]);

const SHORT_FLAGS = {
  j: "json",
  o: "output",
  s: "selector",
  t: "tab",
};

function camelFlag(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function parseArgs(args) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const rawName = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const name = camelFlag(rawName);
      let value;
      if (eq !== -1) {
        value = arg.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(name) || BOOLEAN_FLAGS.has(rawName)) {
        value = true;
      } else if (args[i + 1] && !args[i + 1].startsWith("-")) {
        value = args[++i];
      } else {
        value = true;
      }
      flags[name] = value;
      continue;
    }

    if (arg.startsWith("-") && arg.length === 2 && SHORT_FLAGS[arg[1]]) {
      const name = SHORT_FLAGS[arg[1]];
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
      } else if (args[i + 1]) {
        flags[name] = args[++i];
      } else {
        flags[name] = true;
      }
      continue;
    }

    positional.push(arg);
  }

  return { flags, positional };
}

function flagValue(flags, ...names) {
  for (const name of names) {
    const key = camelFlag(name);
    if (flags[key] !== undefined && flags[key] !== true) return flags[key];
  }
  return undefined;
}

function flagBool(flags, ...names) {
  return names.some((name) => {
    const value = flags[camelFlag(name)];
    return value === true || value === "true" || value === "1" || value === "yes";
  });
}

function requireValue(value, message) {
  if (value === undefined || value === null || value === "") {
    throw new Error(message);
  }
  return value;
}

function readInput(flags, positional, optionName, label) {
  if (flagBool(flags, "stdin")) return readFileSync(0, "utf-8");
  const file = flagValue(flags, "file");
  if (file) return readFileSync(file, "utf-8");
  const direct = flagValue(flags, optionName);
  if (direct !== undefined) return String(direct);
  if (positional.length) return positional.join(" ");
  throw new Error(`${label} is required`);
}

function tabIdFrom(flags) {
  return flagValue(flags, "tab", "tab-id", "tabId");
}

function addParam(params, name, value) {
  if (value !== undefined && value !== null && value !== "") params.set(name, String(value));
}

async function relayRequest(method, path, body) {
  const url = `${RELAY_URL}${path}`;
  const options = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined && method !== "GET") options.body = JSON.stringify(body);

  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot reach Browser Relay at ${RELAY_URL}. Run: browser-relay start (${detail})`);
  }

  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }

  if (!response.ok) {
    const message = data?.error || data?.message || `HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return data;
}

function printData(data, json) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (typeof data === "string") console.log(data);
  else console.log(JSON.stringify(data, null, 2));
}

function printTabs(data, json) {
  if (json) return printData(data, true);
  const tabs = data?.tabs || [];
  if (!tabs.length) {
    console.log("No attached tabs.");
    return;
  }
  for (const tab of tabs) {
    console.log(`${tab.id}\t${tab.title || "(untitled)"}\t${tab.url || ""}`);
  }
}

function ensureOk(data) {
  if (data?.ok === false) throw new Error(data.error || "Command failed");
}

async function browserApiCommand(cmd, args) {
  const { flags, positional } = parseArgs(args);
  const json = flagBool(flags, "json");

  switch (cmd) {
    case "debug": {
      return printData(await relayRequest("GET", "/api/debug"), true);
    }
    case "tabs":
    case "list": {
      return printTabs(await relayRequest("GET", "/api/tabs"), json);
    }
    case "navigate":
    case "go":
    case "open": {
      const url = requireValue(flagValue(flags, "url") || positional[0], "url is required");
      const data = await relayRequest("POST", "/api/navigate", { url, tabId: tabIdFrom(flags) });
      ensureOk(data);
      if (json) return printData(data, true);
      console.log(`${data.title || "(untitled)"}\n${data.url || url}`);
      return;
    }
    case "snapshot": {
      const params = new URLSearchParams();
      addParam(params, "tabId", tabIdFrom(flags));
      addParam(params, "format", flagValue(flags, "format") || "text");
      addParam(params, "maxLength", flagValue(flags, "max-length", "maxLength"));
      const qs = params.toString();
      const data = await relayRequest("GET", `/api/snapshot${qs ? `?${qs}` : ""}`);
      ensureOk(data);
      if (json) return printData(data, true);
      console.log(data.html ?? data.snapshot ?? "");
      return;
    }
    case "click": {
      const selector = requireValue(flagValue(flags, "selector") || positional.join(" "), "selector is required");
      const data = await relayRequest("POST", "/api/click", {
        selector,
        tabId: tabIdFrom(flags),
        doubleClick: flagBool(flags, "double", "double-click", "doubleClick"),
        button: flagValue(flags, "button"),
      });
      ensureOk(data);
      if (json) return printData(data, true);
      console.log(`Clicked: ${data.elementText || selector}`);
      return;
    }
    case "type": {
      const text = readInput(flags, positional, "text", "text");
      const data = await relayRequest("POST", "/api/type", {
        text,
        selector: flagValue(flags, "selector"),
        tabId: tabIdFrom(flags),
        clear: flagBool(flags, "clear"),
        submit: flagBool(flags, "submit"),
      });
      ensureOk(data);
      if (json) return printData(data, true);
      console.log("Typed.");
      return;
    }
    case "scroll": {
      const direction = flagValue(flags, "direction") || positional[0] || "down";
      const amount = flagValue(flags, "amount");
      const data = await relayRequest("POST", "/api/scroll", {
        direction,
        amount: amount === undefined ? undefined : Number(amount),
        tabId: tabIdFrom(flags),
      });
      ensureOk(data);
      if (json) return printData(data, true);
      console.log(`Scrolled: ${data.direction || direction}`);
      return;
    }
    case "screenshot": {
      const output = flagValue(flags, "output") || positional[0];
      const params = new URLSearchParams();
      addParam(params, "tabId", tabIdFrom(flags));
      if (flagBool(flags, "full-page", "fullPage")) params.set("fullPage", "true");
      const data = await relayRequest("GET", `/api/screenshot?${params.toString()}`);
      ensureOk(data);
      const buf = Buffer.from(data.data || "", "base64");
      if (json) return printData({ ...data, bytes: buf.length }, true);
      if (flagBool(flags, "base64")) {
        console.log(data.data || "");
        return;
      }
      if (flagBool(flags, "raw")) {
        process.stdout.write(buf);
        return;
      }
      if (!output) throw new Error("output file is required. Usage: browser-relay screenshot /tmp/page.png");
      writeFileSync(output, buf);
      console.log(`Saved screenshot: ${output} (${buf.length} bytes)`);
      return;
    }
    case "eval": {
      const expression = readInput(flags, positional, "expression", "expression");
      const data = await relayRequest("POST", "/api/eval", { expression, tabId: tabIdFrom(flags) });
      ensureOk(data);
      if (json) return printData(data, true);
      if (data.exceptionDetails) {
        console.error(JSON.stringify(data.exceptionDetails, null, 2));
        process.exit(1);
      }
      const result = data.result || {};
      if ("value" in result) {
        if (typeof result.value === "string") console.log(result.value);
        else console.log(JSON.stringify(result.value, null, 2));
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
      return;
    }
    case "download": {
      const selector = requireValue(flagValue(flags, "selector") || positional.join(" "), "selector is required");
      const data = await relayRequest("POST", "/api/download", { selector, tabId: tabIdFrom(flags) });
      ensureOk(data);
      if (json) return printData(data, true);
      if (!data.found) throw new Error(`Element not found: ${selector}`);
      console.log(data.url || "");
      return;
    }
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

function apiHelp() {
  console.log(`Browser operation commands:
  tabs                         List attached Chrome tabs
  debug                        Show relay diagnostics
  navigate <url> [--tab id]    Navigate an attached tab
  snapshot [--tab id]          Print annotated page text
  click <selector>             Click a CSS selector
  type <text>                  Type text into the focused element
  scroll [down|up|top|bottom]  Scroll the page
  screenshot <file.png>        Save a PNG screenshot
  eval <js>                    Evaluate JavaScript in the page
  download <selector>          Print src/href for an element

Common flags:
  --tab, -t <id>               Target tab id from 'browser-relay tabs'
  --json, -j                   Print JSON response
  --selector, -s <css>         Selector for click/type/download
  --stdin                      Read text/expression from stdin

Examples:
  browser-relay tabs
  browser-relay snapshot --tab ABC123 --max-length 20000
  browser-relay click 'button[type=submit]'
  browser-relay type 'hello world' --selector 'input[name=q]' --clear --submit
  browser-relay screenshot /tmp/page.png --full-page
  browser-relay eval --stdin < script.js
`);
}

const cmd = process.argv[2];

switch (cmd) {
  case undefined:
  case "run":
    await run();
    break;
  case "start": start(); break;
  case "stop": stop(); break;
  case "restart": restart(); break;
  case "status": status(); break;
  case "logs": logs(); break;
  case "path": path(); break;
  case "skill": skill(); break;
  case "info": info(); break;
  case "install": await install(); break;
  case "uninstall": await uninstall(); break;
  case "tabs":
  case "list":
  case "debug":
  case "navigate":
  case "go":
  case "open":
  case "snapshot":
  case "click":
  case "type":
  case "scroll":
  case "screenshot":
  case "eval":
  case "download":
    try { await browserApiCommand(cmd, process.argv.slice(3)); }
    catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); }
    break;
  case "-h":
  case "--help":
  case "help":
    help(); break;
  case "api-help":
    apiHelp(); break;
  case "-v":
  case "--version":
    await version(); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}

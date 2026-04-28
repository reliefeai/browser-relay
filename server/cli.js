#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
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
const HEALTH_URL = "http://127.0.0.1:18795/";
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
  --help,-h   Show this help
  --version   Show version

Env vars:
  BROWSER_RELAY_HOST   Bind address (default 127.0.0.1)
  BROWSER_RELAY_PORT   HTTP + WS port (default 18795)
`);
}

async function version() {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf-8"));
  console.log(pkg.version);
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
  case "-h":
  case "--help":
  case "help":
    help(); break;
  case "-v":
  case "--version":
    await version(); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}

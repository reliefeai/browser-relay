#!/usr/bin/env node
import { spawn, spawnSync, execSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { DEFAULT_REMOTE_HOST, parseRemoteDeviceId, remoteHttpBase } from "./remote-protocol.js";
import { runNpxSync } from "./npx-runner.js";
import {
  inspectWindowsTask,
  runWindowsTaskCommand,
  schtasksError,
  windowsServicePaths,
} from "./windows-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = dirname(__dirname);
const EXTENSION_DIR = join(PKG_DIR, "extension");
const SKILL_DIR = join(PKG_DIR, "skill");
const SKILL_PATH = join(SKILL_DIR, "SKILL.md");
const LAUNCHD_LABEL = "org.browser-relay.service";
const PLIST_PATH = join(homedir(), `Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
const SYSTEMD_UNIT = "browser-relay";
const SYSTEMD_PATH = join(homedir(), ".config/systemd/user/browser-relay.service");
const RELAY_HOST = process.env.BROWSER_RELAY_HOST || "127.0.0.1";
const RELAY_PORT = process.env.BROWSER_RELAY_PORT || "18795";
const RELAY_URL = (process.env.BROWSER_RELAY_URL || `http://${RELAY_HOST}:${RELAY_PORT}`).replace(/\/+$/, "");
const HEALTH_URL = `${RELAY_URL}/`;
let remoteContext = null;
const sys = platform();
const WINDOWS_SERVICE_PATHS = windowsServicePaths();
const LOG_FILE = sys === "win32" ? WINDOWS_SERVICE_PATHS.stdoutLog : "/tmp/browser-relay.log";
const ERR_LOG_FILE = sys === "win32" ? WINDOWS_SERVICE_PATHS.stderrLog : "/tmp/browser-relay.error.log";

async function run() {
  await import("./relay-server.js");
}

async function hub() {
  await import("./hub-server.js");
}

function ensureInstalled() {
  if (sys === "darwin" && existsSync(PLIST_PATH)) return true;
  if (sys === "linux" && existsSync(SYSTEMD_PATH)) return true;
  if (sys === "win32") {
    const state = inspectWindowsTask();
    if (state.checked && state.registered && state.owned) return true;
    if (state.checked && state.registered && !state.owned) {
      console.error("A task named BrowserRelay exists but is not managed by Browser Relay. Refusing to control it.");
    }
    if (!state.checked) console.error(state.error);
  }
  console.error("Background service not registered. Run: browser-relay install");
  process.exit(1);
}

async function install() {
  const mod = await import("./install.js");
  try {
    await mod.installService({ explicit: true, strict: true });
  } catch (error) {
    console.error(`Install failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function uninstall() {
  const mod = await import("./uninstall.js");
  try {
    mod.uninstallService({ explicit: true, strict: true });
  } catch (error) {
    console.error(`Uninstall failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function darwinDomain() {
  return `gui/${process.getuid()}`;
}

async function start() {
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
  } else if (sys === "win32") {
    const result = runWindowsTaskCommand("run");
    if (result.error || result.status !== 0) {
      const relay = await probeRelayDebug();
      if (!relay.ok) {
        console.error(schtasksError("Task Scheduler start", result));
        process.exitCode = 1;
        return false;
      }
      console.log("Already running. Check: browser-relay status");
      return true;
    }
    console.log("Started. Check: browser-relay status");
  } else {
    console.error(`'start' not supported on ${sys}. Run 'browser-relay' in foreground instead.`);
    process.exit(1);
  }
  return true;
}

async function stop() {
  if (sys === "darwin") {
    try { execSync(`launchctl bootout ${darwinDomain()} "${PLIST_PATH}"`, { stdio: "inherit" }); }
    catch { /* not loaded */ }
    console.log("Stopped.");
  } else if (sys === "linux") {
    execSync(`systemctl --user stop ${SYSTEMD_UNIT}`, { stdio: "inherit" });
    console.log("Stopped.");
  } else if (sys === "win32") {
    ensureInstalled();
    const result = runWindowsTaskCommand("end");
    let relay = null;
    for (let i = 0; i < 5; i++) {
      relay = await probeRelayDebug();
      if (!relay.ok) break;
      if (i < 4) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    if (relay?.ok) {
      console.error(result.error || result.status !== 0
        ? schtasksError("Task Scheduler stop", result)
        : "The scheduled task stopped, but a relay is still using the configured address. No unrelated process was terminated.");
      process.exitCode = 1;
      return false;
    }
    console.log(result.error || result.status !== 0 ? "Stopped (already inactive)." : "Stopped.");
  } else {
    console.error(`'stop' not supported on ${sys}.`);
    process.exit(1);
  }
  return true;
}

async function restart() {
  const stopped = await stop();
  if (!stopped) return false;
  return start();
}

async function fix() {
  // Diagnose current state
  try {
    const res = await fetch(`${RELAY_URL}/api/debug`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json();
      console.log(`relay: running  extension: ${data.connected ? "connected" : "not connected"}  tabs: ${data.tabCount ?? 0}`);
    }
  } catch {
    console.log("relay: not responding");
  }

  // Restart clears all stale session state
  console.log("Restarting relay server...");
  if (!await restart()) return;

  // Poll until healthy
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${RELAY_URL}/`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        console.log("Done. Extension will reconnect automatically within a few seconds.");
        return;
      }
    } catch { /* keep waiting */ }
  }
  console.error("Relay server did not come back up. Check logs: browser-relay logs");
  process.exit(1);
}

function serviceState() {
  let loaded = false;
  let pid = null;
  const supported = sys === "darwin" || sys === "linux" || sys === "win32";
  let registered = sys === "darwin"
    ? existsSync(PLIST_PATH)
    : sys === "linux"
      ? existsSync(SYSTEMD_PATH)
      : false;
  let checked = false;
  let error = null;
  let conflict = false;
  if (sys === "darwin") {
    const result = spawnSync("launchctl", ["list"], { encoding: "utf-8", timeout: 1500 });
    if (!result.error && result.status === 0) {
      checked = true;
      const line = result.stdout.split("\n").find((item) => item.trim().split(/\s+/).at(-1) === LAUNCHD_LABEL);
      if (line) {
        loaded = true;
        const [p] = line.trim().split(/\s+/);
        if (p && p !== "-") pid = p;
      }
    } else {
      error = "launchctl status is unavailable";
    }
  } else if (sys === "linux") {
    const result = spawnSync("systemctl", ["--user", "is-active", SYSTEMD_UNIT], {
      encoding: "utf-8",
      timeout: 1500,
    });
    const state = result.stdout.trim();
    if (!result.error && (result.status === 0 || ["inactive", "failed", "deactivating"].includes(state))) {
      checked = true;
      loaded = state === "active";
    } else {
      error = "systemd user status is unavailable";
    }
  } else if (sys === "win32") {
    const state = inspectWindowsTask();
    checked = state.checked;
    conflict = state.checked && state.registered && !state.owned;
    registered = state.checked && state.registered && state.owned;
    loaded = registered;
    error = state.error;
  }
  return { loaded, pid, supported, registered, checked, error, conflict };
}

async function status() {
  const { loaded, pid, registered, checked, error, conflict } = serviceState();

  let healthy = false;
  let daemonVersion = null;
  try {
    const res = await fetch(`${RELAY_URL}/api/debug`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      healthy = true;
      daemonVersion = (await res.json())?.version ?? null;
    }
  } catch {}

  const cliVersion = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf-8")).version;
  const outdated = daemonVersion && daemonVersion !== cliVersion;
  const serviceLabel = sys === "win32"
    ? !checked ? "unknown (Task Scheduler query failed)" : conflict ? "name conflict (not managed)" : registered ? "registered (Task Scheduler)" : "not registered"
    : loaded ? "loaded" : "not loaded";
  console.log(`Service:   ${serviceLabel}${pid ? ` (pid ${pid})` : ""}`);
  if (sys === "win32" && !checked && error) console.log(`Service error: ${error}`);
  console.log(`HTTP:      ${healthy ? "responding" : "not responding"} (${HEALTH_URL})`);
  console.log(`Version:   cli ${cliVersion}, daemon ${daemonVersion ?? "unknown"}${outdated ? "  ← outdated, run: browser-relay restart" : ""}`);
  console.log(`Extension: ${EXTENSION_DIR}`);
  console.log(`Logs:      ${LOG_FILE}`);
  process.exit((sys === "win32" ? registered : loaded) && healthy ? 0 : 1);
}

const AGENT_SKILL_ROOTS = [
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
  ".cursor/skills",
  ".windsurf/skills",
  ".gemini/skills",
  ".copilot/skills",
  ".config/opencode/skills",
];

const SKILL_INSTALL_AGENTS = new Set(["codex", "claude-code", "universal"]);

function inspectInstalledSkills(shippedSkill) {
  const installations = [];
  for (const root of AGENT_SKILL_ROOTS) {
    const installedPath = join(homedir(), root, "browser-relay/SKILL.md");
    if (!existsSync(installedPath)) continue;
    let statusValue = "unreadable";
    try {
      statusValue = readFileSync(installedPath, "utf-8") === shippedSkill ? "current" : "outdated";
    } catch {}
    installations.push({ path: installedPath, status: statusValue });
  }
  return installations;
}

function doctorHelp() {
  console.log(`Usage:
  browser-relay doctor [--json]

Runs read-only checks for the CLI package, Chrome extension, Agent Skill,
background service, relay HTTP endpoint, extension connection, tabs, and logs.
Warnings do not make the command fail. This command never installs or restarts anything.`);
}

function safeRelayUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "(invalid URL)";
  }
}

function relayDebugUrl(value) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("embedded credentials are not supported");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/debug`;
  url.hash = "";
  return url;
}

function doctorSummary(checks) {
  return {
    passed: checks.filter((check) => check.status === "pass").length,
    warnings: checks.filter((check) => check.status === "warn").length,
    failed: checks.filter((check) => check.status === "fail").length,
    skipped: checks.filter((check) => check.status === "skip").length,
  };
}

async function probeRelayDebug() {
  let endpoint;
  try {
    endpoint = relayDebugUrl(RELAY_URL);
  } catch (error) {
    return {
      ok: false,
      message: error?.message === "embedded credentials are not supported"
        ? "Relay URL userinfo is not supported; use a credential-free local relay URL"
        : "Relay URL is invalid",
    };
  }

  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { ok: false, message: `Relay returned HTTP ${response.status}` };
    let data;
    try {
      data = await response.json();
    } catch {
      return { ok: false, message: "Relay returned invalid JSON" };
    }
    const valid = data
      && typeof data === "object"
      && !Array.isArray(data)
      && data.ok === true
      && typeof data.connected === "boolean"
      && Number.isInteger(data.tabCount)
      && data.tabCount >= 0
      && (data.version === undefined || typeof data.version === "string");
    if (!valid) {
      return { ok: false, message: "Relay returned an invalid debug payload" };
    }
    return { ok: true, data };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return { ok: false, message: timedOut ? "Relay request timed out after 2 seconds" : "Relay is unreachable" };
  }
}

async function doctor(args = []) {
  const allowed = new Set(["--json", "-j", "--help", "-h"]);
  const json = args.includes("--json") || args.includes("-j");
  const invalid = args.find((arg) => !allowed.has(arg));
  if (invalid) {
    if (json) {
      console.log(JSON.stringify({
        ok: false,
        version: 1,
        code: "invalid_option",
        option: invalid,
        message: `Unknown doctor option: ${invalid}`,
      }, null, 2));
      process.exitCode = 2;
      return;
    }
    console.error(`Unknown doctor option: ${invalid}`);
    console.error("Usage: browser-relay doctor [--json]");
    process.exitCode = 2;
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    doctorHelp();
    return;
  }

  const checks = [];
  const add = (id, statusValue, message, details, remediation) => {
    checks.push({
      id,
      status: statusValue,
      message,
      ...(details === undefined ? {} : { details }),
      ...(remediation ? { remediation } : {}),
    });
  };

  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf-8"));
    if (!pkg?.version) throw new Error("missing version");
    const requiredNode = pkg.engines?.node ?? null;
    const minimumMajor = Number(requiredNode?.match(/^>=\s*(\d+)/)?.[1]);
    const currentMajor = Number(process.versions.node.split(".")[0]);
    const supportedNode = !Number.isFinite(minimumMajor) || currentMajor >= minimumMajor;
    add(
      "runtime",
      supportedNode ? "pass" : "fail",
      supportedNode
        ? `CLI ${pkg.version} is readable on Node ${process.version}`
        : `Node ${process.version} does not satisfy ${requiredNode}`,
      { nodeVersion: process.version, requiredNode, platform: sys, arch: process.arch },
      supportedNode ? undefined : `Upgrade Node.js to ${requiredNode}`,
    );
  } catch {
    add(
      "runtime",
      "fail",
      "Package metadata is missing or invalid",
      { platform: sys, arch: process.arch },
      "Reinstall Browser Relay with: npm install -g @linsoai/browser-relay",
    );
  }

  const manifestPath = join(EXTENSION_DIR, "manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!manifest?.manifest_version) throw new Error("invalid manifest");
    add("assets.extension", "pass", "Chrome extension manifest is readable", {
      path: EXTENSION_DIR,
      manifestPath,
      manifestVersion: manifest.manifest_version,
    });
  } catch {
    add(
      "assets.extension",
      "fail",
      "Chrome extension manifest is missing or invalid",
      { path: EXTENSION_DIR, manifestPath },
      "Reinstall Browser Relay with: npm install -g @linsoai/browser-relay",
    );
  }

  try {
    const shippedSkill = readFileSync(SKILL_PATH, "utf-8");
    const installations = inspectInstalledSkills(shippedSkill);
    const stale = installations.filter((item) => item.status !== "current");
    add(
      "assets.skill",
      stale.length ? "warn" : "pass",
      stale.length
        ? `Bundled Agent Skill is readable; ${stale.length} installed copy needs attention`
        : installations.length
          ? `Bundled Agent Skill and ${installations.length} installed copy are current`
          : "Bundled Agent Skill is readable; no global copy was detected",
      {
        path: SKILL_PATH,
        installCommand: "browser-relay skill install --agent codex",
        installAgents: [...SKILL_INSTALL_AGENTS],
        installations,
      },
      stale.length
        ? "Run browser-relay skill help, then reinstall for codex, claude-code, or universal"
        : undefined,
    );
  } catch {
    add(
      "assets.skill",
      "fail",
      "Bundled Agent Skill is missing or unreadable",
      { path: SKILL_PATH },
      "Reinstall Browser Relay with: npm install -g @linsoai/browser-relay",
    );
  }

  const customRelay = Boolean(
    process.env.BROWSER_RELAY_URL || process.env.BROWSER_RELAY_HOST || process.env.BROWSER_RELAY_PORT,
  );
  let service = null;
  if (customRelay) {
    add(
      "service.registration",
      "skip",
      "Local background service check skipped for a custom relay URL",
      { platform: sys },
    );
  } else if (sys !== "darwin" && sys !== "linux" && sys !== "win32") {
    add(
      "service.registration",
      "skip",
      `Native background service is not supported on ${sys}; foreground mode is supported`,
      { platform: sys },
    );
  } else {
    service = serviceState();
    if (sys === "win32" && service.conflict) {
      add(
        "service.registration",
        "warn",
        "A task named BrowserRelay exists but is not managed by Browser Relay",
        { registered: false, conflict: true, task: "BrowserRelay" },
        "Resolve the Task Scheduler name conflict before running browser-relay install",
      );
    } else if (sys === "win32" && service.registered) {
      add(
        "service.registration",
        "pass",
        "Background service is registered with Windows Task Scheduler",
        { registered: true, task: "BrowserRelay" },
      );
    } else if (service.loaded) {
      add(
        "service.registration",
        "pass",
        "Background service is active",
        { registered: service.registered, pid: service.pid },
      );
    } else {
      add(
        "service.registration",
        "warn",
        service.checked
          ? service.registered
            ? "Background service is registered but inactive"
            : "Background service is not registered"
          : service.error,
        { registered: service.registered },
        service.registered ? "Start it with: browser-relay start" : "Optional: register it with: browser-relay install",
      );
    }
  }

  const safeUrl = safeRelayUrl(RELAY_URL);
  const relay = await probeRelayDebug();
  if (relay.ok) {
    add("relay.http", "pass", "Relay HTTP debug endpoint is healthy", {
      url: safeUrl,
      uptimeSeconds: relay.data.uptimeSeconds ?? null,
      daemonVersion: relay.data.version ?? null,
    });
  } else {
    add(
      "relay.http",
      "fail",
      relay.message,
      { url: safeUrl },
      service?.registered
        ? "Run: browser-relay status, then browser-relay logs"
        : "Start the relay in a terminal with: browser-relay",
    );
  }

  if (relay.ok) {
    const daemonVersion = relay.data.version;
    if (pkg?.version && daemonVersion === pkg.version) {
      add("relay.version", "pass", `CLI and daemon versions match (${pkg.version})`, {
        cliVersion: pkg.version,
        daemonVersion,
      });
    } else {
      add(
        "relay.version",
        "warn",
        daemonVersion
          ? `CLI ${pkg?.version ?? "unknown"} and daemon ${daemonVersion} differ`
          : "Relay did not report its version",
        { cliVersion: pkg?.version ?? null, daemonVersion: daemonVersion ?? null },
        service?.loaded ? "Restart the background relay with: browser-relay restart" : "Restart the foreground relay process",
      );
    }

    if (relay.data.connected === true) {
      add("extension.connection", "pass", "Chrome extension is connected");
    } else {
      add(
        "extension.connection",
        "warn",
        relay.data.connected === false ? "Chrome extension is not connected" : "Relay did not report extension state",
        undefined,
        `Open Chrome and reload the unpacked extension from: ${EXTENSION_DIR}`,
      );
    }

    if (typeof relay.data.tabCount === "number" && Number.isFinite(relay.data.tabCount)) {
      const count = relay.data.tabCount;
      add(
        "tabs.attached",
        count > 0 ? "pass" : "warn",
        count > 0 ? `${count} Chrome tab${count === 1 ? " is" : "s are"} attached` : "No Chrome tabs are attached",
        { count },
        count > 0 ? undefined : "Open a normal Chrome page, then run: browser-relay tabs",
      );
    } else {
      add(
        "tabs.attached",
        "warn",
        "Relay did not report an attached tab count",
        undefined,
        "Check attached tabs with: browser-relay tabs",
      );
    }
  } else {
    add("relay.version", "skip", "Version check skipped because relay HTTP failed");
    add("extension.connection", "skip", "Extension check skipped because relay HTTP failed");
    add("tabs.attached", "skip", "Tab check skipped because relay HTTP failed");
  }

  if (customRelay) {
    add("logs.access", "skip", "Local log check skipped for a custom relay URL");
  } else if (sys === "darwin") {
    const available = [LOG_FILE, ERR_LOG_FILE].filter((file) => existsSync(file));
    add(
      "logs.access",
      available.length ? "pass" : "warn",
      available.length ? `${available.length} local relay log file${available.length === 1 ? " is" : "s are"} available` : "Local relay logs have not been created yet",
      { files: [LOG_FILE, ERR_LOG_FILE], available },
      available.length ? undefined : "After starting the service, inspect logs with: browser-relay logs",
    );
  } else if (sys === "linux") {
    const journal = spawnSync("journalctl", ["--user", "-u", SYSTEMD_UNIT, "-n", "1", "--no-pager"], {
      encoding: "utf-8",
      timeout: 1500,
    });
    const accessible = !journal.error && journal.status === 0;
    add(
      "logs.access",
      accessible ? "pass" : "warn",
      accessible ? "Relay logs are accessible through the user journal" : "The user journal is not currently accessible",
      { command: `journalctl --user -u ${SYSTEMD_UNIT}` },
      accessible ? undefined : "If running in the foreground, inspect the current terminal output",
    );
  } else if (sys === "win32") {
    const available = [LOG_FILE, ERR_LOG_FILE].filter((file) => existsSync(file));
    add(
      "logs.access",
      available.length ? "pass" : "warn",
      available.length ? `${available.length} local relay log file${available.length === 1 ? " is" : "s are"} available` : "Local relay logs have not been created yet",
      { files: [LOG_FILE, ERR_LOG_FILE], available },
      available.length ? undefined : "After starting the service, inspect logs with: browser-relay logs",
    );
  } else {
    add("logs.access", "skip", "Relay logs are available in the foreground terminal on this platform");
  }

  const summary = doctorSummary(checks);
  const ok = summary.failed === 0;
  const recommendations = [...new Set(checks.map((check) => check.remediation).filter(Boolean))];
  const payload = {
    ok,
    version: 1,
    platform: sys,
    cliVersion: pkg?.version ?? null,
    relayUrl: safeUrl,
    checks,
    summary,
    recommendations,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log("Browser Relay doctor");
    console.log("");
    for (const check of checks) console.log(`[${check.status.toUpperCase()}] ${check.message}`);
    console.log("");
    console.log(`Doctor: ${summary.passed} passed, ${summary.warnings} warnings, ${summary.failed} failed, ${summary.skipped} skipped`);
    if (recommendations.length) {
      console.log("");
      console.log("Next steps:");
      for (const recommendation of recommendations) console.log(`  - ${recommendation}`);
    }
  }

  if (!ok) process.exitCode = 1;
}

function logs() {
  const available = [LOG_FILE, ERR_LOG_FILE].filter((file) => existsSync(file));
  if (!available.length) {
    console.error(`No service logs found at ${LOG_FILE} or ${ERR_LOG_FILE}. Start the service first.`);
    process.exit(1);
  }
  const child = sys === "win32"
    ? spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-Content -LiteralPath $args -Tail 100 -Wait",
      ...available,
    ], { stdio: "inherit", windowsHide: true })
    : spawn("tail", ["-f", LOG_FILE, ERR_LOG_FILE], { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`Could not follow service logs: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function path() {
  console.log(EXTENSION_DIR);
}

function skillTargetPath(agent) {
  if (agent === "claude-code") {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    return join(claudeHome, "skills/browser-relay/SKILL.md");
  }
  return join(homedir(), ".agents/skills/browser-relay/SKILL.md");
}

function parseSkillAgents(args) {
  const agents = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--agent" || arg === "-a") {
      const start = agents.length;
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) agents.push(args[++i]);
      if (agents.length === start) return { error: `${arg} requires at least one agent` };
      continue;
    }
    if (arg.startsWith("--agent=")) {
      const value = arg.slice("--agent=".length);
      if (!value) return { error: "--agent requires at least one agent" };
      agents.push(value);
      continue;
    }
    return { error: `Unknown skill option: ${arg}` };
  }

  const unique = [...new Set(agents)];
  const unsupported = unique.filter((agent) => !SKILL_INSTALL_AGENTS.has(agent));
  if (unsupported.length) {
    return {
      error: `Unsupported agent: ${unsupported.join(", ")}. Use codex, claude-code, or universal.`,
    };
  }
  return { agents: unique };
}

function skillInstallCommand(agents = ["codex"]) {
  return `npx --yes skills add "${SKILL_DIR}" --global --yes --copy --agent ${agents.join(" ")}`;
}

function skillHelp() {
  console.log(`Usage:
  browser-relay skill                         Print the legacy Codex install command
  browser-relay skill install --agent <name>  Install/update and verify the bundled Skill
  browser-relay skill path        Print the bundled Skill directory
  browser-relay skill help        Show this help

Supported targets: codex, claude-code, universal. Pass multiple names after
--agent to install for more than one target. "universal" installs to the
standard ~/.agents/skills directory.

The install command uses the skills CLI in global, non-interactive copy mode,
then verifies every target SKILL.md. Exit codes: 0 success, 1 install or
verification failure, 2 invalid usage.`);
}

function skill(args = []) {
  const subcommand = args[0];
  if (args.includes("--help") || args.includes("-h") || subcommand === "help") {
    skillHelp();
    return;
  }

  if (subcommand === undefined) {
    console.log(skillInstallCommand());
    return;
  }

  if (subcommand === "command") {
    const parsed = parseSkillAgents(args.slice(1));
    if (parsed.error) {
      console.error(parsed.error);
      console.error("Usage: browser-relay skill command [--agent codex|claude-code|universal]");
      process.exitCode = 2;
      return;
    }
    console.log(skillInstallCommand(parsed.agents.length ? parsed.agents : ["codex"]));
    return;
  }

  if (subcommand === "path") {
    if (args.length !== 1) {
      console.error("Usage: browser-relay skill path");
      process.exitCode = 2;
      return;
    }
    console.log(SKILL_DIR);
    return;
  }

  if (subcommand !== "install") {
    console.error(`Unknown skill command: ${subcommand}`);
    console.error("Usage: browser-relay skill [install|path|help]");
    process.exitCode = 2;
    return;
  }

  const parsed = parseSkillAgents(args.slice(1));
  if (parsed.error) {
    console.error(parsed.error);
    console.error("Usage: browser-relay skill install --agent codex|claude-code|universal");
    process.exitCode = 2;
    return;
  }
  if (!parsed.agents.length) {
    console.error("Missing required option: --agent <name>");
    console.error("Use codex, claude-code, or universal.");
    process.exitCode = 2;
    return;
  }

  console.log(`Installing bundled Agent Skill from: ${SKILL_DIR}`);
  console.log(`Targets: ${parsed.agents.join(", ")}`);
  const installed = runNpxSync([
    "--yes",
    "skills",
    "add",
    SKILL_DIR,
    "--global",
    "--yes",
    "--copy",
    "--agent",
    ...parsed.agents,
  ], {
    stdio: "inherit",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });

  if (installed.error) {
    console.error(`Could not run npx: ${installed.error.message}`);
    process.exitCode = 1;
    return;
  }
  if (installed.status !== 0) {
    if (installed.signal) console.error(`The skills command was terminated by signal ${installed.signal}.`);
    else console.error(`The skills command failed with exit code ${installed.status ?? "unknown"}.`);
    process.exitCode = 1;
    return;
  }

  let shippedSkill;
  try {
    shippedSkill = readFileSync(SKILL_PATH, "utf-8");
  } catch {
    console.error(`Bundled Skill is missing or unreadable: ${SKILL_PATH}`);
    process.exitCode = 1;
    return;
  }
  const verification = parsed.agents.map((agent) => {
    const target = skillTargetPath(agent);
    let statusValue = "missing";
    try {
      statusValue = readFileSync(target, "utf-8") === shippedSkill ? "current" : "outdated";
    } catch {}
    return { agent, path: target, status: statusValue };
  });
  const failed = verification.filter((item) => item.status !== "current");
  if (failed.length) {
    console.error("The skills command exited successfully, but target verification failed:");
    for (const item of failed) console.error(`  ${item.agent}: ${item.status} (${item.path})`);
    console.error(`Retry manually: ${skillInstallCommand(parsed.agents)}`);
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log("Verified Agent Skill:");
  for (const item of verification) console.log(`  ${item.agent}: ${item.path}`);
}

function packageInfo() {
  return JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf-8"));
}

function npmCommand() {
  return sys === "win32" ? "npm.cmd" : "npm";
}

function packageSpec(packageName, target) {
  if (!target || target === "latest") return `${packageName}@latest`;
  if (target.includes("/")) return target;
  return `${packageName}@${target}`;
}

function updateHelp() {
  console.log(`Usage:
  browser-relay update [version-or-tag]

Examples:
  browser-relay update
  browser-relay update latest
  browser-relay update 1.0.14

Installs the requested Browser Relay npm package globally, refreshes the
background service through postinstall, then prints status and follow-up hints.`);
}

async function update(args = []) {
  if (args.includes("-h") || args.includes("--help")) {
    updateHelp();
    return;
  }

  const { positional } = parseArgs(args);
  const pkg = packageInfo();
  const target = positional[0] || "latest";
  const spec = packageSpec(pkg.name, target);
  const npm = npmCommand();

  console.log(`Current: ${pkg.name}@${pkg.version}`);

  const view = spawnSync(npm, ["view", spec, "version"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (view.status === 0) {
    const latest = view.stdout.trim();
    if (latest) console.log(`Target:  ${pkg.name}@${latest}`);
  } else {
    const detail = (view.stderr || view.stdout || "").trim();
    console.log(`Target:  ${spec}`);
    if (detail) console.log(`npm view warning: ${detail.split("\n")[0]}`);
  }

  console.log(`Running: ${npm} install -g ${spec}`);
  const installed = spawnSync(npm, ["install", "-g", spec], { stdio: "inherit" });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) process.exit(installed.status ?? 1);

  console.log("");
  console.log("Update complete.");
  console.log("");
  console.log("Status:");
  const statusCmd = sys === "win32" ? "browser-relay.cmd" : "browser-relay";
  const checked = spawnSync(statusCmd, ["status"], { stdio: "inherit" });
  if (checked.error || checked.status !== 0) {
    console.log("Status check did not complete cleanly. Run: browser-relay status");
  }

  console.log("");
  console.log("Next steps:");
  console.log("  - If Chrome asks for new extension permissions, accept them.");
  console.log("  - If the extension does not reconnect, reload it at chrome://extensions.");
  console.log("  - If you installed the agent skill, run browser-relay skill help and reinstall for the active agent.");
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
  hub         Run a local Browser Relay Hub for remote-control testing
  start       Start as a background service (launchd/systemd/Task Scheduler)
  stop        Stop the background service
  restart     Restart the background service
  fix         Restart and clear stale session state (run when tabs won't connect)
  update      Update the global npm package and refresh the service
  status      Show service + HTTP health
  doctor      Check the full install → extension → tab → Skill path
  logs        Tail the service logs
  path        Print the Chrome extension directory
  skill       Install, locate, or print the Agent Skill install command
  info        Show extension path + usage hints
  install     (Re)register the background service
  uninstall   Unregister the background service

Browser commands:
  tabs        List attached Chrome tabs
  snapshot    Print annotated page text
  wait        Wait for a CSS selector to attach or become visible
  console     Print captured console, page error, and browser log entries
  network     Print captured Network.* request/response/failure entries
  click       Click an element by CSS selector
  type        Type text into an input or focused element
  key         Press a key or keyboard shortcut
  scroll      Scroll the page
  screenshot  Save a PNG screenshot
  eval        Evaluate JavaScript in the page
  download-start Start a Chrome download from a URL
  downloads      List Chrome downloads and recent download events
  api-help    Show browser command examples

  --help,-h   Show this help
  --version   Show version

Env vars:
  BROWSER_RELAY_URL                  Relay base URL (default http://127.0.0.1:18795)
  BROWSER_RELAY_HOST                 Bind address (default 127.0.0.1)
  BROWSER_RELAY_PORT                 HTTP + WS port (default 18795)
  BROWSER_RELAY_REMOTE_DEVICE_ID     Capability generated by the extension for remote control
  BROWSER_RELAY_REMOTE_HOST          Remote hub URL (default https://relay.linso.ai)
  BROWSER_RELAY_HUB_PORT             Local hub port for 'browser-relay hub' (default 18796)
`);
}

async function version() {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf-8"));
  console.log(pkg.version);
}

const BOOLEAN_FLAGS = new Set([
  "base64", "clear", "double", "doubleClick", "fullPage", "json",
  "raw", "saveAs", "stdin", "submit",
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

class RelayRequestError extends Error {
  constructor(payload, fallbackMessage) {
    super(errorMessage(payload, fallbackMessage));
    this.name = "RelayRequestError";
    this.payload = payload;
    this.code = payload?.code;
    this.status = payload?.status;
  }
}

function errorMessage(payload, fallback = "Command failed") {
  const message = payload?.message || payload?.error || fallback;
  return payload?.code ? `${payload.code}: ${message}` : String(message);
}

function fallbackErrorPayload(message, options = {}) {
  return {
    ok: false,
    code: options.code || "request_failed",
    error: message,
    message,
    status: options.status ?? 0,
    retryable: options.retryable === true,
  };
}

// ---- Remote aliases: save a short name for a long Device ID so commands read
// `--remote mymac` instead of `--remote-device-id br-<secret>`. ----
const REMOTES_PATH = join(homedir(), ".browser-relay", "remotes.json");

function readRemotes() {
  try {
    if (!existsSync(REMOTES_PATH)) return {};
    const data = JSON.parse(readFileSync(REMOTES_PATH, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch { return {}; }
}

function writeRemotes(remotes) {
  const dir = dirname(REMOTES_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (sys !== "win32") chmodSync(dir, 0o700);
  writeFileSync(REMOTES_PATH, JSON.stringify(remotes, null, 2) + "\n", { mode: 0o600 });
  if (sys !== "win32") chmodSync(REMOTES_PATH, 0o600);
}

function shortDeviceId(id) {
  return "(redacted)";
}

function publicRemotes(remotes) {
  return Object.fromEntries(Object.entries(remotes).map(([alias, entry]) => [alias, {
    maskedDeviceId: shortDeviceId(entry?.deviceId),
    host: entry?.host,
  }]));
}

function remoteCommand(args) {
  const sub = args[0];
  const { flags, positional } = parseArgs(args.slice(1));
  const remotes = readRemotes();

  if (sub === "add" || sub === "set") {
    const [alias, deviceId] = positional;
    if (!alias || !deviceId) {
      console.error("Usage: browser-relay remote add <alias> <device-id> [--remote-host <url>]");
      process.exit(1);
    }
    parseRemoteDeviceId(deviceId); // validates format, throws on bad id
    const host = remoteHttpBase(flagValue(flags, "remote-host", "remoteHost") || DEFAULT_REMOTE_HOST);
    remotes[alias] = { deviceId, host };
    writeRemotes(remotes);
    console.log(`Saved remote "${alias}" → ${host}`);
    console.log(`Use it:  browser-relay tabs --remote ${alias}`);
    return;
  }

  if (sub === "rm" || sub === "remove" || sub === "delete") {
    const alias = positional[0];
    if (!alias) { console.error("Usage: browser-relay remote rm <alias>"); process.exit(1); }
    if (!remotes[alias]) { console.error(`No remote named "${alias}"`); process.exit(1); }
    delete remotes[alias];
    writeRemotes(remotes);
    console.log(`Removed remote "${alias}"`);
    return;
  }

  if (sub === undefined || sub === "ls" || sub === "list") {
    if (flagBool(flags, "json")) return printData(publicRemotes(remotes), true);
    const names = Object.keys(remotes);
    if (!names.length) {
      console.log("No saved remotes. Add one:  browser-relay remote add <alias> <device-id>");
      return;
    }
    for (const name of names) console.log(`${name}\t${shortDeviceId(remotes[name].deviceId)}\t${remotes[name].host}`);
    return;
  }

  console.error(`Unknown "remote" subcommand: ${sub}. Try: add | ls | rm`);
  process.exit(1);
}

function remoteContextFrom(flags) {
  const input = flagValue(flags, "remote-device-id", "remoteDeviceId", "remote") || process.env.BROWSER_RELAY_REMOTE_DEVICE_ID;
  if (!input) return null;
  let host = flagValue(flags, "remote-host", "remoteHost");

  // A saved alias wins; otherwise the value must be a full `br-` capability.
  let remoteDeviceId = input;
  const entry = readRemotes()[input];
  if (entry) {
    remoteDeviceId = entry.deviceId;
    if (!host && entry.host) host = entry.host;
  } else if (!/^br-/.test(input)) {
    throw new Error(`Unknown remote alias "${input}". Save it with: browser-relay remote add ${input} <device-id>`);
  }

  const parsed = parseRemoteDeviceId(remoteDeviceId);
  host = host || process.env.BROWSER_RELAY_REMOTE_HOST || DEFAULT_REMOTE_HOST;
  return { ...parsed, host: remoteHttpBase(host) };
}

async function remoteRelayRequest(method, path, body) {
  const ctx = remoteContext;
  if (!ctx) throw new Error("remote context is not configured");
  const url = `${ctx.host}/v1/rpc`;
  const requestBody = {
    routeId: ctx.routeId,
    id: `cli_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    method,
    path,
    headers: {},
    body: body === undefined ? null : body,
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.secret}` },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `Cannot reach Browser Relay Hub at ${ctx.host}: ${detail}`;
    throw new RelayRequestError(fallbackErrorPayload(message, { code: "remote_hub_unreachable", retryable: true }), message);
  }

  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!response.ok) {
    const payload = data && typeof data === "object"
      ? data
      : fallbackErrorPayload(`HTTP ${response.status}`, { code: "remote_http_error", status: response.status });
    throw new RelayRequestError(payload, `HTTP ${response.status}`);
  }
  return data;
}

function wantsJson(args) {
  return args.includes("--json") || args.includes("-j");
}

async function relayRequest(method, path, body) {
  if (remoteContext) return remoteRelayRequest(method, path, body);
  const url = `${RELAY_URL}${path}`;
  const options = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined && method !== "GET") options.body = JSON.stringify(body);

  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `Cannot reach Browser Relay at ${RELAY_URL}. Run: browser-relay start (${detail})`;
    throw new RelayRequestError(fallbackErrorPayload(message, { code: "relay_unreachable", retryable: true }), message);
  }

  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }

  if (!response.ok) {
    const payload = data && typeof data === "object"
      ? data
      : fallbackErrorPayload(`HTTP ${response.status}`, { code: "http_error", status: response.status });
    throw new RelayRequestError(payload, `HTTP ${response.status}`);
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

function printConsole(data, json) {
  if (json) return printData(data, true);
  const entries = data?.entries || [];
  if (!entries.length) {
    console.log("No console entries.");
    return;
  }
  for (const entry of entries) {
    const time = entry.receivedAt || "";
    const level = entry.level || "log";
    const text = entry.text || "";
    const where = entry.tabId ? ` ${entry.tabId}` : "";
    console.log(`[${time}] ${level}${where} ${text}`);
  }
}

function printNetwork(data, json) {
  if (json) return printData(data, true);
  const entries = data?.entries || [];
  if (!entries.length) {
    console.log("No network entries.");
    return;
  }
  for (const entry of entries) {
    const time = entry.receivedAt || "";
    const type = entry.type || "network";
    const method = entry.method || entry.request?.method || "";
    const status = entry.status ?? entry.response?.status ?? "";
    const url = entry.url || entry.request?.url || entry.response?.url || "";
    const details = [method, status].filter((v) => v !== "").join(" ");
    console.log(`[${time}] ${type}${details ? ` ${details}` : ""} ${url}`);
  }
}

function printDownloads(data, json) {
  if (json) return printData(data, true);
  const downloads = data?.downloads || [];
  if (!downloads.length) {
    console.log("No downloads.");
  } else {
    for (const item of downloads) {
      const size = item.totalBytes ? `${item.bytesReceived || 0}/${item.totalBytes}` : `${item.bytesReceived || 0}`;
      console.log(`${item.id}\t${item.state || ""}\t${size}\t${item.filename || ""}\t${item.url || ""}`);
    }
  }
  const events = data?.events || [];
  if (events.length) {
    console.log(`Recent events: ${events.length}`);
  }
}

function ensureOk(data, json = false) {
  if (data?.ok !== false) return;
  if (json) {
    printData(data, true);
    process.exit(1);
  }
  throw new RelayRequestError(data, "Command failed");
}

function printCliError(err, args = []) {
  if (wantsJson(args) && err?.payload) {
    printData(err.payload, true);
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

async function browserApiCommand(cmd, args) {
  const { flags, positional } = parseArgs(args);
  const json = flagBool(flags, "json");
  remoteContext = remoteContextFrom(flags);

  switch (cmd) {
    case "debug": {
      return printData(await relayRequest("GET", "/api/debug"), true);
    }
    case "tabs":
    case "list": {
      return printTabs(await relayRequest("GET", "/api/tabs"), json);
    }
    case "console": {
      const params = new URLSearchParams();
      addParam(params, "tabId", tabIdFrom(flags));
      addParam(params, "level", flagValue(flags, "level"));
      addParam(params, "limit", flagValue(flags, "limit"));
      if (flagBool(flags, "clear")) params.set("clear", "true");
      const qs = params.toString();
      return printConsole(await relayRequest("GET", `/api/console${qs ? `?${qs}` : ""}`), json);
    }
    case "network": {
      if (flagBool(flags, "clear")) {
        const data = await relayRequest("POST", "/api/network/clear", {
          tabId: tabIdFrom(flags),
          type: flagValue(flags, "type"),
          method: flagValue(flags, "method"),
          status: flagValue(flags, "status"),
          requestId: flagValue(flags, "request-id", "requestId"),
          url: flagValue(flags, "url"),
        });
        ensureOk(data, json);
        if (json) return printData(data, true);
        console.log(`Cleared ${data.cleared || 0} network entries.`);
        return;
      }
      const params = new URLSearchParams();
      addParam(params, "tabId", tabIdFrom(flags));
      addParam(params, "type", flagValue(flags, "type"));
      addParam(params, "method", flagValue(flags, "method"));
      addParam(params, "status", flagValue(flags, "status"));
      addParam(params, "requestId", flagValue(flags, "request-id", "requestId"));
      addParam(params, "url", flagValue(flags, "url"));
      addParam(params, "limit", flagValue(flags, "limit"));
      const qs = params.toString();
      return printNetwork(await relayRequest("GET", `/api/network${qs ? `?${qs}` : ""}`), json);
    }
    case "navigate":
    case "go":
    case "open": {
      const url = requireValue(flagValue(flags, "url") || positional[0], "url is required");
      const data = await relayRequest("POST", "/api/navigate", { url, tabId: tabIdFrom(flags) });
      ensureOk(data, json);
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
      ensureOk(data, json);
      if (json) return printData(data, true);
      console.log(data.html ?? data.snapshot ?? "");
      return;
    }
    case "wait": {
      const selector = requireValue(flagValue(flags, "selector") || positional.join(" "), "selector is required");
      const timeoutMs = flagValue(flags, "timeout", "timeout-ms", "timeoutMs");
      const pollMs = flagValue(flags, "poll", "poll-ms", "pollMs");
      const data = await relayRequest("POST", "/api/wait", {
        selector,
        state: flagValue(flags, "state") || "visible",
        timeoutMs: timeoutMs === undefined ? undefined : Number(timeoutMs),
        pollMs: pollMs === undefined ? undefined : Number(pollMs),
        tabId: tabIdFrom(flags),
      });
      ensureOk(data, json);
      if (json) return printData(data, true);
      console.log(`Matched ${data.state}: ${data.selector} (${data.elapsedMs}ms, ${data.attempts} attempt${data.attempts === 1 ? "" : "s"})`);
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
      ensureOk(data, json);
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
      ensureOk(data, json);
      if (json) return printData(data, true);
      console.log("Typed.");
      return;
    }
    case "key": {
      const combo = requireValue(flagValue(flags, "key", "combo") || positional.join("+"), "key or combo is required");
      const data = await relayRequest("POST", "/api/key", {
        combo,
        tabId: tabIdFrom(flags),
        ctrl: flagBool(flags, "ctrl", "control"),
        alt: flagBool(flags, "alt", "option"),
        shift: flagBool(flags, "shift"),
        meta: flagBool(flags, "meta", "cmd", "command"),
        text: flagValue(flags, "text"),
      });
      ensureOk(data, json);
      if (json) return printData(data, true);
      console.log(`Pressed: ${combo}`);
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
      ensureOk(data, json);
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
      ensureOk(data, json);
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
      ensureOk(data, json);
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
      ensureOk(data, json);
      if (json) return printData(data, true);
      if (!data.found) throw new Error(`Element not found: ${selector}`);
      console.log(data.url || "");
      return;
    }
    case "download-start": {
      const url = requireValue(flagValue(flags, "url") || positional[0], "url is required");
      const data = await relayRequest("POST", "/api/download/start", {
        url,
        filename: flagValue(flags, "filename", "output"),
        saveAs: flagBool(flags, "save-as", "saveAs"),
        conflictAction: flagValue(flags, "conflict-action", "conflictAction"),
      });
      ensureOk(data, json);
      if (json) return printData(data, true);
      console.log(`Started download: ${data.downloadId ?? data.id}`);
      return;
    }
    case "downloads": {
      if (flagBool(flags, "clear")) {
        const data = await relayRequest("POST", "/api/downloads/clear", {});
        ensureOk(data, json);
        if (json) return printData(data, true);
        console.log(`Cleared ${data.cleared || 0} download events.`);
        return;
      }
      const params = new URLSearchParams();
      addParam(params, "id", flagValue(flags, "id"));
      addParam(params, "state", flagValue(flags, "state"));
      addParam(params, "url", flagValue(flags, "url"));
      addParam(params, "filename", flagValue(flags, "filename"));
      addParam(params, "query", flagValue(flags, "query"));
      addParam(params, "limit", flagValue(flags, "limit"));
      const qs = params.toString();
      return printDownloads(await relayRequest("GET", `/api/downloads${qs ? `?${qs}` : ""}`), json);
    }
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

function apiHelp() {
  console.log(`Browser operation commands:
  tabs                         List attached Chrome tabs
  debug                        Show relay diagnostics
  console [--tab id]           Print captured console/page errors
  network [--tab id]           Print captured network events
  navigate <url> [--tab id]    Navigate an attached tab
  snapshot [--tab id]          Print annotated page text
  wait <selector>              Wait for a selector (visible by default)
  click <selector>             Click a CSS selector
  type <text>                  Type text into the focused element
  key <key|combo>              Press a key or combo (Enter, Escape, Control+L)
  scroll [down|up|top|bottom]  Scroll the page
  screenshot <file.png>        Save a PNG screenshot
  eval <js>                    Evaluate JavaScript in the page
  download <selector>          Print src/href for an element
  download-start <url>         Start a Chrome download
  downloads [--limit n]        List Chrome downloads and recent events

Common flags:
  --tab, -t <id>               Target tab id from 'browser-relay tabs'
  --json, -j                   Print JSON response
  --remote-device-id <id>      Control a browser that enabled External Control in the extension
  --remote-host <url>          Remote hub URL (default https://relay.linso.ai)
  --level <level>              Filter console entries by level
  --limit <n>                  Limit console entries
  --selector, -s <css>         Selector for wait/click/type/download
  --state <attached|visible>   Wait condition (default: visible)
  --timeout <ms>               Wait timeout (default: 5000, max: 20000)
  --poll <ms>                  Wait polling interval (default: 100)
  --filename <path>            Suggested download filename/path
  --save-as                    Ask Chrome to show the save-as dialog
  --conflict-action <action>   uniquify, overwrite, or prompt
  --stdin                      Read text/expression from stdin

Examples:
  browser-relay tabs
  browser-relay console --limit 50
  browser-relay network --type response --status 500 --limit 20
  browser-relay snapshot --tab ABC123 --max-length 20000
  browser-relay wait 'button[type=submit]' --state visible --timeout 10000
  browser-relay click 'button[type=submit]'
  browser-relay type 'hello world' --selector 'input[name=q]' --clear --submit
  browser-relay key Control+L
  browser-relay download-start https://example.com/file.pdf --filename files/file.pdf
  browser-relay downloads --limit 20
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
  case "hub":
    await hub();
    break;
  case "start": await start(); break;
  case "stop": await stop(); break;
  case "restart": await restart(); break;
  case "fix": await fix(); break;
  case "update": await update(process.argv.slice(3)); break;
  case "status": await status(); break;
  case "doctor": await doctor(process.argv.slice(3)); break;
  case "logs": logs(); break;
  case "path": path(); break;
  case "skill": skill(process.argv.slice(3)); break;
  case "info": info(); break;
  case "install": await install(); break;
  case "uninstall": await uninstall(); break;
  case "remote": remoteCommand(process.argv.slice(3)); break;
  case "tabs":
  case "list":
  case "console":
  case "network":
  case "debug":
  case "navigate":
  case "go":
  case "open":
  case "snapshot":
  case "wait":
  case "click":
  case "type":
  case "key":
  case "scroll":
  case "screenshot":
  case "eval":
  case "download":
  case "download-start":
  case "downloads":
    try { await browserApiCommand(cmd, process.argv.slice(3)); }
    catch (err) { printCliError(err, process.argv.slice(3)); }
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

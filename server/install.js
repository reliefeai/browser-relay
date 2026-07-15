#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { installWindowsTask } from "./windows-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = dirname(__dirname);
const EXTENSION_DIR = join(RELAY_DIR, "extension");
const CLI_PATH = join(__dirname, "cli.js");
const WINDOWS_SERVICE_ENTRY_PATH = join(__dirname, "windows-service-entry.js");
const NODE_PATH = process.execPath;
const LAUNCHD_LABEL = "org.browser-relay.service";

function log(msg) {
  console.log(`[browser-relay] ${msg}`);
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function installDarwin() {
  const plistDst = join(homedir(), `Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);

  // Call node + cli.js directly by absolute path — avoids bin shim path
  // discovery (npm bin -g was removed in npm 9+) and launchd's minimal PATH
  // (shebang #!/usr/bin/env node can't find node outside /usr/bin).
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(NODE_PATH)}</string>
    <string>${xmlEscape(CLI_PATH)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BROWSER_RELAY_HOST</key>
    <string>127.0.0.1</string>
    <key>BROWSER_RELAY_PORT</key>
    <string>18795</string>
    <key>PATH</key>
    <string>${xmlEscape(dirname(NODE_PATH))}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/tmp/browser-relay.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/browser-relay.error.log</string>
  </dict>
</plist>`;

  mkdirSync(dirname(plistDst), { recursive: true });
  writeFileSync(plistDst, plistContent);

  // Use bootstrap/bootout — `launchctl load/unload` is the legacy API and
  // often silently fails or returns EBADEXEC on macOS 13+. bootout first for
  // idempotency; ignore "service not found" errors.
  const domain = `gui/${process.getuid()}`;
  try { execSync(`launchctl bootout ${domain} "${plistDst}" 2>/dev/null`); } catch {}
  try {
    execSync(`launchctl bootstrap ${domain} "${plistDst}"`);
    log(`Registered with launchd (node=${NODE_PATH}).`);
    return true;
  } catch (e) {
    log(`launchctl bootstrap failed: ${e.message}. Check /tmp/browser-relay.error.log`);
    return false;
  }
}

function installLinux() {
  const serviceDst = join(homedir(), ".config/systemd/user/browser-relay.service");

  // Same approach as macOS: invoke node + cli.js by absolute path so we don't
  // depend on PATH discovery or the npm bin shim.
  const serviceContent = `[Unit]
Description=Browser Relay Server
After=network.target

[Service]
ExecStart=${NODE_PATH} ${CLI_PATH}
Environment=BROWSER_RELAY_HOST=127.0.0.1
Environment=BROWSER_RELAY_PORT=18795
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;

  mkdirSync(dirname(serviceDst), { recursive: true });
  writeFileSync(serviceDst, serviceContent);

  try {
    execSync("systemctl --user daemon-reload");
    execSync("systemctl --user enable browser-relay");
    execSync("systemctl --user start browser-relay");
    log(`Registered with systemd (node=${NODE_PATH}).`);
    return true;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    log(`systemd registration skipped (${msg}). Run manually: ${NODE_PATH} ${CLI_PATH}`);
    return false;
  }
}

function installWin32() {
  const result = installWindowsTask({
    nodePath: NODE_PATH,
    serviceEntryPath: WINDOWS_SERVICE_ENTRY_PATH,
    cliPath: CLI_PATH,
  });
  log(`Registered with Windows Task Scheduler for the current user (node=${NODE_PATH}).`);
  log(`Logs: ${result.paths.stdoutLog}`);
  return true;
}

// Agents keep their own copy of the skill (installed via npx skills add).
// On upgrade, find copies that no longer match the shipped skill and remind
// the user to re-run the install command — the copies belong to the agent
// tools, so we never overwrite them ourselves.
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

function checkInstalledSkills() {
  let shipped;
  try { shipped = readFileSync(join(RELAY_DIR, "skill/SKILL.md"), "utf-8"); } catch { return; }
  const stale = [];
  for (const root of AGENT_SKILL_ROOTS) {
    const dir = join(homedir(), root, "browser-relay");
    try {
      if (readFileSync(join(dir, "SKILL.md"), "utf-8") !== shipped) stale.push(dir);
    } catch { /* skill not installed for this agent */ }
  }
  if (!stale.length) return;
  log("");
  log("⚠ Installed agent skill is out of date:");
  for (const dir of stale) log(`   ${dir}`);
  log("   Run 'browser-relay skill help', then reinstall for codex, claude-code, or universal.");
}

async function waitForRelay(expectedVersion) {
  for (let i = 0; i < 20; i++) {
    try {
      const response = await fetch("http://127.0.0.1:18795/api/debug", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const data = await response.json();
        if (data && data.version === expectedVersion && typeof data.connected === "boolean") return true;
      }
    } catch {}
    if (i < 19) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  return false;
}

export async function installService(options = {}) {
  const explicit = options.explicit === true;
  const strict = options.strict === true;
  // Only register a background service on global installs. `npm i` (local) is
  // typically a developer adding the package as a dependency — they don't want
  // a daemon hijacking their machine.
  const isGlobal = process.env.npm_config_global === "true";
  if (!explicit && !isGlobal) {
    log("Local install — skipping background service registration.");
    log(`Install globally to enable auto-start: npm install -g @linsoai/browser-relay`);
    log(`Or run manually: ${NODE_PATH} ${CLI_PATH}`);
    log("");
    log(`📦 Chrome Extension: ${EXTENSION_DIR}`);
    log(`📖 Agent Skill:      ${join(RELAY_DIR, "skill/SKILL.md")}`);
    return { installed: false, skipped: true };
  }

  log("Setting up Browser Relay...");

  const sys = platform();

  let registered = false;
  if (sys === "darwin") {
    registered = installDarwin();
  } else if (sys === "linux") {
    registered = installLinux();
  } else if (sys === "win32") {
    registered = installWin32();
  } else {
    log(`Unsupported platform: ${sys}. Run 'browser-relay' manually.`);
    if (strict) throw new Error(`Background service is not supported on ${sys}`);
    return { installed: false, skipped: true };
  }

  if (!registered) {
    if (strict) throw new Error("Background service registration failed");
  } else {
    const pkg = JSON.parse(readFileSync(join(RELAY_DIR, "package.json"), "utf-8"));
    const healthy = await waitForRelay(pkg.version);
    if (healthy) {
      log("✅ Relay is running on http://127.0.0.1:18795");
    } else {
      const message = "Relay did not become healthy with the installed version. Run: browser-relay status";
      log(`⚠️  ${message}`);
      if (strict) throw new Error(message);
    }
  }

  checkInstalledSkills();

  log("");
  log("📦 Chrome Extension:");
  log(`   ${EXTENSION_DIR}`);
  log("   Load at: chrome://extensions -> Developer mode -> Load unpacked");
  log("   Already loaded? It reloads itself on its next relay reconnect (~30s).");
  log("");
  log("📖 Agent Skill:");
  log(`   ${join(RELAY_DIR, "skill/SKILL.md")}`);
  return { installed: registered, skipped: false };
}

// Postinstall must never fail npm install — wrap everything.
const isDirect = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  try {
    await installService();
  } catch (e) {
    log(`postinstall warning: ${e instanceof Error ? e.message : String(e)}`);
    log(`Run manually: ${NODE_PATH} ${CLI_PATH}`);
  }
}

#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = dirname(__dirname);
const EXTENSION_DIR = join(RELAY_DIR, "extension");
const CLI_PATH = join(__dirname, "cli.js");
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
  } catch (e) {
    log(`launchctl bootstrap failed: ${e.message}. Check /tmp/browser-relay.error.log`);
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
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    log(`systemd registration skipped (${msg}). Run manually: ${NODE_PATH} ${CLI_PATH}`);
  }
}

function installWin32() {
  log("Windows: Run 'browser-relay' manually. To auto-start, add to startup apps.");
}

function main() {
  // Only register a background service on global installs. `npm i` (local) is
  // typically a developer adding the package as a dependency — they don't want
  // a daemon hijacking their machine.
  const isGlobal = process.env.npm_config_global === "true";
  if (!isGlobal) {
    log("Local install — skipping background service registration.");
    log(`Install globally to enable auto-start: npm install -g @linsoai/browser-relay`);
    log(`Or run manually: ${NODE_PATH} ${CLI_PATH}`);
    log("");
    log(`📦 Chrome Extension: ${EXTENSION_DIR}`);
    log(`📖 Agent Skill:      ${join(RELAY_DIR, "skill/SKILL.md")}`);
    return;
  }

  log("Setting up Browser Relay...");

  const sys = platform();

  if (sys === "darwin") {
    installDarwin();
  } else if (sys === "linux") {
    installLinux();
  } else if (sys === "win32") {
    installWin32();
  } else {
    log(`Unsupported platform: ${sys}. Run 'browser-relay' manually.`);
    return;
  }

  // Verify it's running
  for (let i = 0; i < 10; i++) {
    try {
      execSync("curl -s http://127.0.0.1:18795/ > /dev/null");
      log("✅ Relay is running on http://127.0.0.1:18795");
      break;
    } catch {
      if (i === 9) {
        log("⚠️  Relay may still be starting. Check: curl http://127.0.0.1:18795/");
      }
    }
  }

  log("");
  log("📦 Chrome Extension:");
  log(`   ${EXTENSION_DIR}`);
  log("   Load at: chrome://extensions -> Developer mode -> Load unpacked");
  log("");
  log("📖 Agent Skill:");
  log(`   ${join(RELAY_DIR, "skill/SKILL.md")}`);
}

// Postinstall must never fail npm install — wrap everything.
try {
  main();
} catch (e) {
  log(`postinstall warning: ${e instanceof Error ? e.message : String(e)}`);
  log(`Run manually: ${NODE_PATH} ${CLI_PATH}`);
}

#!/usr/bin/env node
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";

function log(msg) {
  console.log(`[browser-relay] ${msg}`);
}

const sys = platform();
const LAUNCHD_LABEL = "org.browser-relay.service";

if (sys === "darwin") {
  const plistDst = join(homedir(), `Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
  if (existsSync(plistDst)) {
    try { execSync(`launchctl bootout gui/${process.getuid()} "${plistDst}" 2>/dev/null`); } catch {}
    unlinkSync(plistDst);
    log("Removed launchd service.");
  }
}

if (sys === "linux") {
  try {
    execSync("systemctl --user stop browser-relay 2>/dev/null");
    execSync("systemctl --user disable browser-relay 2>/dev/null");
  } catch {}
  const serviceDst = join(homedir(), ".config/systemd/user/browser-relay.service");
  if (existsSync(serviceDst)) {
    unlinkSync(serviceDst);
    execSync("systemctl --user daemon-reload 2>/dev/null");
    log("Removed systemd service.");
  }
}

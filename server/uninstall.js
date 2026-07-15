#!/usr/bin/env node
import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { uninstallWindowsTask } from "./windows-service.js";

function log(msg) {
  console.log(`[browser-relay] ${msg}`);
}

const LAUNCHD_LABEL = "org.browser-relay.service";

export function uninstallService(options = {}) {
  const explicit = options.explicit === true;
  const strict = options.strict === true;
  const isGlobal = process.env.npm_config_global === "true";
  if (!explicit && !isGlobal) {
    log("Local uninstall — leaving any global background service unchanged.");
    return { removed: false, skipped: true };
  }

  const sys = platform();
  try {
    if (sys === "darwin") {
      const plistDst = join(homedir(), `Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
      if (existsSync(plistDst)) {
        try { execSync(`launchctl bootout gui/${process.getuid()} "${plistDst}" 2>/dev/null`); } catch {}
        unlinkSync(plistDst);
        log("Removed launchd service.");
      }
    } else if (sys === "linux") {
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
    } else if (sys === "win32") {
      const result = uninstallWindowsTask();
      log(result.removedTask ? "Removed Windows Task Scheduler service." : "Windows service was not registered.");
      log(`Logs were preserved at ${result.paths.logs}`);
    } else if (strict) {
      throw new Error(`Background service is not supported on ${sys}`);
    }
  } catch (error) {
    if (strict) throw error;
    log(`postuninstall warning: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { removed: true, skipped: false };
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  uninstallService();
}

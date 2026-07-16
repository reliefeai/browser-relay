import { spawnSync as defaultSpawnSync } from "node:child_process";
import { existsSync as defaultExistsSync } from "node:fs";

function outputText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
}

function firstLine(value) {
  return outputText(value).split(/\r?\n/, 1)[0].trim().slice(0, 240);
}

function probeError(command, label, result) {
  if (result?.error?.code === "ENOENT") return `${command} is unavailable (command not found)`;
  if (result?.error?.code === "ETIMEDOUT") return `${label} timed out`;
  const detail = firstLine(result?.stderr) || firstLine(result?.error?.message);
  return detail ? `${label} is unavailable: ${detail}` : `${label} is unavailable`;
}

function runProbe(spawnSyncFn, command, args) {
  try {
    return spawnSyncFn(command, args, { encoding: "utf-8", timeout: 1500 });
  } catch (error) {
    return { error, status: null, stdout: "", stderr: "" };
  }
}

export function inspectPosixServiceState({
  sys,
  plistPath,
  systemdPath,
  launchdLabel,
  systemdUnit,
  spawnSyncFn = defaultSpawnSync,
  existsSyncFn = defaultExistsSync,
}) {
  const supported = sys === "darwin" || sys === "linux";
  const registered = sys === "darwin"
    ? existsSyncFn(plistPath)
    : sys === "linux"
      ? existsSyncFn(systemdPath)
      : false;
  const state = {
    loaded: false,
    pid: null,
    supported,
    registered,
    checked: false,
    error: null,
    conflict: false,
  };

  if (sys === "darwin") {
    const result = runProbe(spawnSyncFn, "launchctl", ["list"]);
    const hasOutput = typeof result?.stdout === "string" || Buffer.isBuffer(result?.stdout);
    if (!result?.error && result?.status === 0 && hasOutput) {
      state.checked = true;
      const line = outputText(result.stdout)
        .split("\n")
        .find((item) => item.trim().split(/\s+/).at(-1) === launchdLabel);
      if (line) {
        state.loaded = true;
        const [pid] = line.trim().split(/\s+/);
        if (pid && pid !== "-") state.pid = pid;
      }
    } else if (!result?.error && result?.status === 0) {
      state.error = "launchctl status is unavailable: command returned no output";
    } else {
      state.error = probeError("launchctl", "launchctl status", result);
    }
    return state;
  }

  if (sys === "linux") {
    const result = runProbe(spawnSyncFn, "systemctl", ["--user", "is-active", systemdUnit]);
    const serviceStatus = outputText(result?.stdout).trim();
    const knownStates = new Set([
      "active",
      "activating",
      "deactivating",
      "failed",
      "inactive",
      "maintenance",
      "reloading",
      "unknown",
    ]);
    if (!result?.error && knownStates.has(serviceStatus)) {
      state.checked = true;
      state.loaded = serviceStatus === "active";
    } else {
      state.error = probeError("systemctl", "systemd user status", result);
    }
  }

  return state;
}

export function relayStartRemediation(service) {
  return service?.checked && service.registered
    ? "Run: browser-relay status, then browser-relay logs"
    : "Start the relay in a terminal with: browser-relay";
}

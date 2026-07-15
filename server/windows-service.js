import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const WINDOWS_TASK_NAME = "BrowserRelay";
export const WINDOWS_TASK_SOURCE = "https://github.com/reliefeai/browser-relay";
export const WINDOWS_TASK_OWNER = "browser-relay:service:v1";

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Task Scheduler stores Exec.Arguments as one Windows command line. Quote each
// argv value using the CommandLineToArgvW backslash rules so spaces, ampersands,
// exclamation marks, parentheses, and trailing slashes survive unchanged.
export function quoteWindowsArg(value) {
  const input = String(value);
  let output = "\"";
  let backslashes = 0;

  for (const char of input) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === "\"") {
      output += "\\".repeat(backslashes * 2 + 1) + "\"";
      backslashes = 0;
      continue;
    }
    output += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }

  return output + "\\".repeat(backslashes * 2) + "\"";
}

export function windowsServicePaths(options = {}) {
  const home = options.home || homedir();
  const localAppData = options.localAppData
    || process.env.LOCALAPPDATA?.trim()
    || join(home, "AppData", "Local");
  const root = join(localAppData, "BrowserRelay");
  const logs = join(root, "logs");
  return {
    root,
    logs,
    taskXml: join(root, "task.xml"),
    stdoutLog: join(logs, "browser-relay.log"),
    stderrLog: join(logs, "browser-relay.error.log"),
  };
}

export function windowsTaskArguments({ serviceEntryPath, cliPath, stdoutLog, stderrLog }) {
  return [
    serviceEntryPath,
    "--entry",
    cliPath,
    "--stdout-log",
    stdoutLog,
    "--stderr-log",
    stderrLog,
  ].map(quoteWindowsArg).join(" ");
}

export function windowsTaskXml({
  sid,
  nodePath,
  serviceEntryPath,
  cliPath,
  stdoutLog,
  stderrLog,
  taskName = WINDOWS_TASK_NAME,
}) {
  if (!/^S-\d-(?:\d+-)+\d+$/i.test(sid)) throw new Error("Could not determine the current Windows user SID");
  const args = windowsTaskArguments({ serviceEntryPath, cliPath, stdoutLog, stderrLog });
  const taskUri = `\\${String(taskName).replace(/^\\+/, "")}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Runs Browser Relay for the current signed-in user.</Description>
    <Source>${xmlEscape(WINDOWS_TASK_SOURCE)}</Source>
    <Documentation>${xmlEscape(WINDOWS_TASK_OWNER)}</Documentation>
    <URI>${xmlEscape(taskUri)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(sid)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(sid)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(nodePath)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(dirname(cliPath))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function decodeWindowsOutput(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  const buffer = Buffer.from(value);
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  let zeroes = 0;
  for (let i = 1; i < Math.min(buffer.length, 200); i += 2) {
    if (buffer[i] === 0) zeroes += 1;
  }
  if (zeroes > 10) return buffer.toString("utf16le");
  return buffer.toString("utf8");
}

export function invokeSchtasks(args) {
  const result = spawnSync("schtasks.exe", args, {
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 15_000,
  });
  return {
    ...result,
    stdout: decodeWindowsOutput(result.stdout),
    stderr: decodeWindowsOutput(result.stderr),
  };
}

export function schtasksError(action, result) {
  if (result?.error) return `${action}: ${result.error.message}`;
  const detail = String(result?.stderr || result?.stdout || "").trim().split(/\r?\n/)[0];
  return `${action} failed${result?.status == null ? "" : ` with exit code ${result.status}`}${detail ? `: ${detail}` : ""}`;
}

export function windowsTaskCommandArgs(command, options = {}) {
  const taskName = options.taskName || WINDOWS_TASK_NAME;
  if (command === "query") return ["/Query", "/TN", taskName, "/XML"];
  if (command === "list") return ["/Query", "/FO", "CSV", "/NH"];
  if (command === "run") return ["/Run", "/TN", taskName];
  if (command === "end") return ["/End", "/TN", taskName];
  if (command === "delete") return ["/Delete", "/TN", taskName, "/F"];
  if (command === "create") {
    if (!options.taskXml) throw new Error("taskXml is required for the create command");
    return [
      "/Create", "/XML", options.taskXml, "/TN", taskName,
      ...(options.force === true ? ["/F"] : []),
    ];
  }
  throw new Error(`Unknown Windows task command: ${command}`);
}

function normalizeTaskName(value) {
  return String(value).trim().replace(/^\\+/, "").toLowerCase();
}

export function parseWindowsTaskNames(output) {
  const names = [];
  for (const rawLine of String(output || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('"')) {
      let value = "";
      for (let i = 1; i < line.length; i++) {
        if (line[i] !== '"') {
          value += line[i];
          continue;
        }
        if (line[i + 1] === '"') {
          value += '"';
          i += 1;
          continue;
        }
        break;
      }
      names.push(value);
    } else {
      names.push(line.split(",", 1)[0]);
    }
  }
  return names;
}

export function isBrowserRelayTaskXml(xml) {
  const value = String(xml || "");
  return /<Source>\s*https:\/\/github\.com\/reliefeai\/browser-relay\s*<\/Source>/i.test(value)
    && /<Documentation>\s*browser-relay:service:v1\s*<\/Documentation>/i.test(value);
}

export function inspectWindowsTask(options = {}) {
  const runner = options.runner || invokeSchtasks;
  const result = runner(windowsTaskCommandArgs("query", options));
  if (result.error) {
    return {
      checked: false,
      registered: false,
      owned: false,
      xml: "",
      error: schtasksError("Task Scheduler query", result),
    };
  }
  if (result.status === 0) {
    const xml = String(result.stdout || "").replace(/^\uFEFF/, "");
    if (!/<Task(?:\s|>)/i.test(xml)) {
      return {
        checked: false,
        registered: true,
        owned: false,
        xml,
        error: "Task Scheduler returned an invalid XML definition for BrowserRelay",
      };
    }
    return {
      checked: true,
      registered: true,
      owned: isBrowserRelayTaskXml(xml),
      xml,
      error: null,
    };
  }

  // schtasks uses a non-zero exit for both "not found" and operational
  // failures. A successful all-task listing lets us prove absence without
  // parsing localized error text; if the name is present or listing fails, the
  // result remains an error and no mutating command is allowed.
  const listed = runner(windowsTaskCommandArgs("list", options));
  if (listed.error || listed.status !== 0) {
    return {
      checked: false,
      registered: false,
      owned: false,
      xml: "",
      error: schtasksError("Task Scheduler query", listed),
    };
  }
  const target = normalizeTaskName(options.taskName || WINDOWS_TASK_NAME);
  const nameExists = parseWindowsTaskNames(listed.stdout).some((name) => normalizeTaskName(name) === target);
  if (nameExists) {
    return {
      checked: false,
      registered: true,
      owned: false,
      xml: "",
      error: schtasksError("BrowserRelay task XML query", result),
    };
  }
  return {
    checked: true,
    registered: false,
    owned: false,
    xml: "",
    error: null,
  };
}

export function currentWindowsSid(options = {}) {
  const runner = options.runner || ((args) => {
    const result = spawnSync("whoami.exe", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    return result;
  });
  const result = runner(["/user", "/fo", "csv", "/nh"]);
  if (result.error || result.status !== 0) throw new Error(schtasksError("Windows user lookup", result));
  const sid = String(result.stdout || "").match(/S-\d-(?:\d+-)+\d+/i)?.[0];
  if (!sid) throw new Error("Could not determine the current Windows user SID");
  return sid;
}

export function runWindowsTaskCommand(command, options = {}) {
  const runner = options.runner || invokeSchtasks;
  return runner(windowsTaskCommandArgs(command, options));
}

export function installWindowsTask(options) {
  const runner = options.runner || invokeSchtasks;
  const paths = options.paths || windowsServicePaths();
  const sid = options.sid || currentWindowsSid();
  const existing = inspectWindowsTask({ ...options, runner });
  if (!existing.checked) throw new Error(existing.error);
  if (existing.registered && !existing.owned) {
    throw new Error("A task named BrowserRelay already exists but is not owned by Browser Relay; refusing to overwrite it");
  }
  mkdirSync(paths.logs, { recursive: true });
  const xml = windowsTaskXml({
    sid,
    nodePath: options.nodePath,
    serviceEntryPath: options.serviceEntryPath,
    cliPath: options.cliPath,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
    taskName: options.taskName || WINDOWS_TASK_NAME,
  });
  // Task Scheduler's native format is UTF-16. Writing it this way also keeps
  // non-ASCII Windows user and npm paths independent of the active code page.
  writeFileSync(paths.taskXml, `\uFEFF${xml}`, "utf16le");

  // Updating a running task does not replace its current process. End the old
  // instance first, then idempotently overwrite and immediately test the task.
  if (existing.registered) runner(windowsTaskCommandArgs("end", options));
  const created = runner(windowsTaskCommandArgs("create", {
    ...options,
    taskXml: paths.taskXml,
    force: existing.registered,
  }));
  if (created.error || created.status !== 0) throw new Error(schtasksError("Task Scheduler registration", created));
  const started = runner(windowsTaskCommandArgs("run", options));
  if (started.error || started.status !== 0) throw new Error(schtasksError("Task Scheduler start", started));
  return { paths, sid };
}

export function uninstallWindowsTask(options = {}) {
  const runner = options.runner || invokeSchtasks;
  const paths = options.paths || windowsServicePaths();
  const state = inspectWindowsTask({ ...options, runner });
  if (!state.checked) throw new Error(state.error);
  if (state.registered && !state.owned) {
    throw new Error("A task named BrowserRelay exists but is not owned by Browser Relay; refusing to stop or delete it");
  }
  if (state.registered) {
    runner(windowsTaskCommandArgs("end", options));
    const deleted = runner(windowsTaskCommandArgs("delete", options));
    if (deleted.error || deleted.status !== 0) throw new Error(schtasksError("Task Scheduler removal", deleted));
  }
  if (existsSync(paths.taskXml)) unlinkSync(paths.taskXml);
  return { removedTask: state.registered, paths };
}

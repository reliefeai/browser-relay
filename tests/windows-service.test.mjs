import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentWindowsSid,
  inspectWindowsTask,
  installWindowsTask,
  invokeSchtasks,
  isBrowserRelayTaskXml,
  parseWindowsTaskNames,
  quoteWindowsArg,
  runWindowsTaskCommand,
  uninstallWindowsTask,
  windowsServicePaths,
  windowsTaskCommandArgs,
  windowsTaskXml,
} from "../server/windows-service.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serviceEntryPath = join(repoRoot, "server", "windows-service-entry.js");
const cliPath = join(repoRoot, "server", "cli.js");
const testSid = "S-1-5-21-111111111-222222222-333333333-1001";

function fixture(t, name = "Browser Relay & ! (测试)", cleanup = true) {
  const root = mkdtempSync(join(tmpdir(), "browser-relay-windows-service-"));
  const localAppData = join(root, name);
  mkdirSync(localAppData, { recursive: true });
  if (cleanup) t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, localAppData, paths: windowsServicePaths({ localAppData }) };
}

function result(status = 0, stdout = "", stderr = "") {
  return { status, stdout, stderr, error: undefined };
}

function runNode(args, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("Windows task argv quoting preserves shell metacharacters and trailing slashes", () => {
  assert.equal(quoteWindowsArg("C:\\Program Files\\node.exe"), '"C:\\Program Files\\node.exe"');
  assert.equal(quoteWindowsArg("C:\\A & B\\bang!\\(x)\\"), '"C:\\A & B\\bang!\\(x)\\\\"');
  assert.equal(quoteWindowsArg('a\\"b'), '"a\\\\\\"b"');
});

test("Windows Task Scheduler XML is current-user, interactive, limited, and Unicode-safe", (t) => {
  const { paths } = fixture(t);
  const xml = windowsTaskXml({
    sid: testSid,
    nodePath: "C:\\nvm path & tools\\node.exe",
    serviceEntryPath: "C:\\包\\windows-service-entry.js",
    cliPath: "C:\\包\\cli.js",
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
  });

  assert.match(xml, new RegExp(`<UserId>${testSid}</UserId>`));
  assert.match(xml, /<Source>https:\/\/github\.com\/reliefeai\/browser-relay<\/Source>/);
  assert.match(xml, /<Documentation>browser-relay:service:v1<\/Documentation>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<LogonTrigger>[\s\S]*<UserId>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /C:\\nvm path &amp; tools\\node\.exe/);
  assert.match(xml, /C:\\包\\windows-service-entry\.js/);
  assert.doesNotMatch(xml, /HighestAvailable|SYSTEM|<Password>/i);
  assert.equal(isBrowserRelayTaskXml(xml), true);
});

test("Windows service install writes UTF-16 XML and uses only schtasks argv calls", (t) => {
  const { paths } = fixture(t);
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[0] === "/Query" && args.includes("/TN")) return result(1, "", "not found");
    if (args[0] === "/Query") return result(0, '"\\AnotherTask","N/A"\r\n');
    return result(0);
  };

  installWindowsTask({
    sid: testSid,
    nodePath: "C:\\Node & Tools\\node.exe",
    serviceEntryPath,
    cliPath,
    paths,
    runner,
  });

  assert.deepEqual(calls.map((args) => args[0]), ["/Query", "/Query", "/Create", "/Run"]);
  assert.deepEqual(calls[2], ["/Create", "/XML", paths.taskXml, "/TN", "BrowserRelay"]);
  const raw = readFileSync(paths.taskXml);
  assert.equal(raw[0], 0xff);
  assert.equal(raw[1], 0xfe);
  const xml = raw.subarray(2).toString("utf16le");
  assert.match(xml, /<Command>C:\\Node &amp; Tools\\node\.exe<\/Command>/);
  assert.match(xml, /--stdout-log/);
});

test("Windows service install fails before Run when task registration fails", (t) => {
  const { paths } = fixture(t);
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[0] === "/Query" && args.includes("/TN")) return result(1, "", "not found");
    if (args[0] === "/Query") return result(0, '"\\AnotherTask","N/A"\r\n');
    return args[0] === "/Create" ? result(5, "", "Access is denied") : result(0);
  };

  assert.throws(() => installWindowsTask({
    sid: testSid,
    nodePath: process.execPath,
    serviceEntryPath,
    cliPath,
    paths,
    runner,
  }), /registration failed with exit code 5: Access is denied/);
  assert.deepEqual(calls.map((args) => args[0]), ["/Query", "/Query", "/Create"]);
});

test("Windows service reinstall overwrites only a task carrying its ownership marker", (t) => {
  const { paths } = fixture(t);
  const ownedXml = windowsTaskXml({
    sid: testSid,
    nodePath: "C:\\old-node\\node.exe",
    serviceEntryPath: "C:\\old-package\\windows-service-entry.js",
    cliPath: "C:\\old-package\\cli.js",
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
  });
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[0] === "/Query") return result(0, ownedXml);
    return result(0);
  };

  installWindowsTask({
    sid: testSid,
    nodePath: process.execPath,
    serviceEntryPath,
    cliPath,
    paths,
    runner,
  });

  assert.deepEqual(calls.map((args) => args[0]), ["/Query", "/End", "/Create", "/Run"]);
  assert.deepEqual(calls[2], ["/Create", "/XML", paths.taskXml, "/TN", "BrowserRelay", "/F"]);
});

test("Windows task inspection and uninstall are idempotent and preserve logs", (t) => {
  const { paths } = fixture(t);
  mkdirSync(paths.logs, { recursive: true });
  writeFileSync(paths.taskXml, "task");
  writeFileSync(paths.stdoutLog, "keep me");
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[0] === "/Query") return result(0, windowsTaskXml({
      sid: testSid,
      nodePath: process.execPath,
      serviceEntryPath,
      cliPath,
      stdoutLog: paths.stdoutLog,
      stderrLog: paths.stderrLog,
    }));
    return result(0);
  };

  const state = inspectWindowsTask({ runner });
  assert.equal(state.checked, true);
  assert.equal(state.registered, true);
  assert.equal(state.owned, true);
  const removed = uninstallWindowsTask({ paths, runner });
  assert.equal(removed.removedTask, true);
  assert.deepEqual(calls.map((args) => args[0]), ["/Query", "/Query", "/End", "/Delete"]);
  assert.equal(existsSync(paths.taskXml), false);
  assert.equal(readFileSync(paths.stdoutLog, "utf8"), "keep me");

  const missing = inspectWindowsTask({
    runner: (args) => args.includes("/TN")
      ? result(1, "", "not found")
      : result(0, '"\\AnotherTask","N/A"\r\n'),
  });
  assert.equal(missing.checked, true);
  assert.equal(missing.registered, false);
  assert.equal(missing.owned, false);
});

test("Windows service refuses to control a same-name task without the ownership marker", (t) => {
  const { paths } = fixture(t);
  const calls = [];
  const externalXml = `<?xml version="1.0"?><Task><RegistrationInfo><URI>\\BrowserRelay</URI></RegistrationInfo></Task>`;
  const runner = (args) => {
    calls.push(args);
    return result(0, externalXml);
  };

  const state = inspectWindowsTask({ runner });
  assert.equal(state.checked, true);
  assert.equal(state.registered, true);
  assert.equal(state.owned, false);
  assert.throws(() => installWindowsTask({
    sid: testSid,
    nodePath: process.execPath,
    serviceEntryPath,
    cliPath,
    paths,
    runner,
  }), /not owned by Browser Relay; refusing to overwrite/);
  assert.throws(() => uninstallWindowsTask({ paths, runner }), /not owned by Browser Relay; refusing to stop or delete/);
  assert.deepEqual([...new Set(calls.map((args) => args[0]))], ["/Query"]);
  assert.equal(existsSync(paths.taskXml), false);
});

test("Windows task query distinguishes proven absence from scheduler failures", () => {
  const deniedCalls = [];
  const denied = inspectWindowsTask({
    runner: (args) => {
      deniedCalls.push(args);
      return result(5, "", "Access is denied");
    },
  });
  assert.equal(denied.checked, false);
  assert.equal(denied.registered, false);
  assert.match(denied.error, /Task Scheduler query.*exit code 5/);
  assert.deepEqual(deniedCalls.map((args) => args[0]), ["/Query", "/Query"]);

  const hidden = inspectWindowsTask({
    runner: (args) => args.includes("/TN")
      ? result(5, "", "Access is denied")
      : result(0, '"\\BrowserRelay","N/A"\r\n'),
  });
  assert.equal(hidden.checked, false);
  assert.equal(hidden.registered, true);
  assert.match(hidden.error, /task XML query.*exit code 5/i);

  assert.deepEqual(parseWindowsTaskNames('"\\One","data"\r\n"\\Folder\\A, B","data"\r\n'), [
    "\\One",
    "\\Folder\\A, B",
  ]);
});

test("an ACL-hidden same-name race cannot trigger a forced overwrite", (t) => {
  const { paths } = fixture(t);
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[0] === "/Query" && args.includes("/TN")) return result(5, "", "Access is denied");
    if (args[0] === "/Query") return result(0, '"\\AnotherTask","N/A"\r\n');
    if (args[0] === "/Create") return result(5, "", "Access is denied");
    return result(0);
  };

  assert.throws(() => installWindowsTask({
    sid: testSid,
    nodePath: process.execPath,
    serviceEntryPath,
    cliPath,
    paths,
    runner,
  }), /registration failed with exit code 5/);
  const create = calls.find((args) => args[0] === "/Create");
  assert.ok(create);
  assert.equal(create.includes("/F"), false);
  assert.equal(calls.some((args) => args[0] === "/End" || args[0] === "/Run"), false);
});

test("Windows user lookup extracts a SID without depending on localized labels", () => {
  const sid = currentWindowsSid({
    runner: () => result(0, '"桌面\\用户","S-1-5-21-9-8-7-1002"\r\n'),
  });
  assert.equal(sid, "S-1-5-21-9-8-7-1002");
});

test("Windows service entry redirects stdout and stderr without spawning a child", async (t) => {
  const { root, paths } = fixture(t);
  const worker = join(root, "worker & ! (测试).mjs");
  writeFileSync(worker, 'console.log(`service stdout ${process.env.BROWSER_RELAY_HOST}:${process.env.BROWSER_RELAY_PORT}`); console.error("service stderr");\n');

  const run = await runNode([
    serviceEntryPath,
    "--entry", worker,
    "--stdout-log", paths.stdoutLog,
    "--stderr-log", paths.stderrLog,
  ]);

  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "");
  assert.equal(readFileSync(paths.stdoutLog, "utf8"), "service stdout 127.0.0.1:18795\n");
  assert.equal(readFileSync(paths.stderrLog, "utf8"), "service stderr\n");
});

test("Windows Task Scheduler executes and controls the real Unicode task action", {
  skip: process.platform !== "win32",
  timeout: 60_000,
}, async (t) => {
  const { root, paths } = fixture(t, "space & bang ! parens (x) 测试", false);
  const worker = join(root, "scheduled worker & ! (测试).mjs");
  const pidFile = join(root, "scheduled.pid");
  writeFileSync(worker, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log("scheduled service started"); setInterval(() => {}, 1000);\n`);
  const taskName = `BrowserRelay-Test-${process.pid}-${Date.now()}`;
  const options = {
    taskName,
    sid: currentWindowsSid(),
    nodePath: process.execPath,
    serviceEntryPath,
    cliPath: worker,
    paths,
  };
  t.after(async () => {
    runWindowsTaskCommand("end", { taskName });
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      await waitFor(() => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      });
    }
    runWindowsTaskCommand("delete", { taskName });
    rmSync(root, { recursive: true, force: true });
  });

  installWindowsTask(options);
  assert.equal(await waitFor(() => existsSync(paths.stdoutLog)
    && readFileSync(paths.stdoutLog, "utf8").includes("scheduled service started")), true);
  const registered = inspectWindowsTask({ taskName });
  assert.equal(registered.checked, true);
  assert.equal(registered.registered, true);
  assert.equal(registered.owned, true);
  assert.match(registered.xml.replace(/\0/g, ""), /InteractiveToken/);

  const ended = runWindowsTaskCommand("end", { taskName });
  assert.equal(ended.status, 0, ended.stderr || ended.stdout);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(await waitFor(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }), true, "scheduled task process did not exit after schtasks /End");
  const deleted = runWindowsTaskCommand("delete", { taskName });
  assert.equal(deleted.status, 0, deleted.stderr || deleted.stdout);
  assert.equal(inspectWindowsTask({ taskName }).registered, false);
});

test("Windows task command builders keep paths and names as separate argv", () => {
  const xml = "C:\\Users\\A & B\\task.xml";
  const name = "BrowserRelay Test";
  assert.deepEqual(windowsTaskCommandArgs("create", { taskXml: xml, taskName: name }), [
    "/Create", "/XML", xml, "/TN", name,
  ]);
  assert.deepEqual(windowsTaskCommandArgs("create", { taskXml: xml, taskName: name, force: true }), [
    "/Create", "/XML", xml, "/TN", name, "/F",
  ]);
  assert.deepEqual(windowsTaskCommandArgs("query", { taskName: name }), ["/Query", "/TN", name, "/XML"]);
  assert.deepEqual(windowsTaskCommandArgs("list", { taskName: name }), ["/Query", "/FO", "CSV", "/NH"]);
  assert.deepEqual(windowsTaskCommandArgs("run", { taskName: name }), ["/Run", "/TN", name]);
  assert.deepEqual(windowsTaskCommandArgs("end", { taskName: name }), ["/End", "/TN", name]);
  assert.deepEqual(windowsTaskCommandArgs("delete", { taskName: name }), ["/Delete", "/TN", name, "/F"]);
});

// Keep the real runner imported and type-checked on non-Windows CI as well.
assert.equal(typeof invokeSchtasks, "function");

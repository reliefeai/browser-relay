import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildNpxInvocation,
  resolveWindowsNpxCli,
  runNpxSync,
} from "../server/npx-runner.js";

test("POSIX npx invocation preserves the argv array", () => {
  const args = ["--yes", "skills", "add", "/tmp/skill path", "--agent", "codex"];
  const env = { PATH: "/usr/bin" };

  assert.deepEqual(buildNpxInvocation(args, { platformName: "darwin", env }), {
    command: "npx",
    args,
    env,
  });
});

test("Windows npx invocation bypasses cmd.exe and preserves the argv array", (t) => {
  const root = mkdtempSync(join(tmpdir(), "browser-relay-npx-build-"));
  const npxCli = join(root, "npx-cli.js");
  writeFileSync(npxCli, "");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skillPath = join(root, "Agent User & Co", "browser relay", "skill!");
  const args = ["--yes", "skills", "add", skillPath, "--global", "--agent", "codex"];
  const env = { BROWSER_RELAY_NPX_CLI: npxCli };

  const invocation = buildNpxInvocation(args, { platformName: "win32", env });

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [npxCli, ...args]);
  assert.equal(invocation.env, env);
});

test("Windows npx resolution honors safe candidates and rejects invalid overrides", (t) => {
  const root = mkdtempSync(join(tmpdir(), "browser-relay-npx-resolve-"));
  const override = join(root, "override", "npx-cli.js");
  const npmCli = join(root, "npm", "bin", "npm-cli.js");
  const npmNpxCli = join(dirname(npmCli), "npx-cli.js");
  const execPath = join(root, "node", "node.exe");
  const bundledNpxCli = join(dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
  for (const file of [override, npmCli, npmNpxCli, bundledNpxCli]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.equal(resolveWindowsNpxCli({
    env: { BROWSER_RELAY_NPX_CLI: override, npm_execpath: npmCli },
    execPath,
  }), override);
  assert.equal(resolveWindowsNpxCli({ env: { npm_execpath: npmCli }, execPath }), npmNpxCli);
  assert.equal(resolveWindowsNpxCli({
    env: { npm_execpath: join(root, "pnpm.cjs") },
    execPath,
  }), bundledNpxCli);
  assert.equal(resolveWindowsNpxCli({
    env: { npm_execpath: join(root, "yarn.js") },
    execPath,
  }), bundledNpxCli);

  assert.throws(
    () => resolveWindowsNpxCli({ env: { BROWSER_RELAY_NPX_CLI: "relative.js" }, execPath }),
    /must point to an existing absolute/,
  );
  assert.throws(
    () => resolveWindowsNpxCli({ env: { BROWSER_RELAY_NPX_CLI: join(root, "missing.js") }, execPath }),
    /must point to an existing absolute/,
  );
  assert.throws(
    () => resolveWindowsNpxCli({ env: { BROWSER_RELAY_NPX_CLI: root }, execPath }),
    /must point to an existing absolute/,
  );
  assert.throws(
    () => resolveWindowsNpxCli({ env: {}, execPath: join(root, "missing", "node.exe") }),
    /Could not locate npm's npx-cli.js/,
  );
});

test("Windows runner executes npx-cli.js with exact argv and exit code", (t) => {
  const root = mkdtempSync(join(tmpdir(), "browser relay & bang!-"));
  const script = join(root, "fake npx & bang!.cjs");
  const record = join(root, "received argv.json");
  writeFileSync(script, [
    'const { writeFileSync } = require("node:fs");',
    'writeFileSync(process.env.BROWSER_RELAY_TEST_RECORD, JSON.stringify(process.argv.slice(2)));',
    'process.exit(Number(process.env.BROWSER_RELAY_TEST_EXIT || 0));',
    '',
  ].join("\n"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const skillPath = join(root, "skill path & bang!", "browser-relay");
  const args = ["--yes", "skills", "add", skillPath, "--global", "--yes", "--agent", "codex"];
  const env = {
    ...process.env,
    BROWSER_RELAY_NPX_CLI: script,
    BROWSER_RELAY_TEST_RECORD: record,
  };

  const success = runNpxSync(args, { platformName: "win32", env, encoding: "utf8" });
  assert.equal(success.error, undefined);
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), args);

  const failure = runNpxSync(args, {
    platformName: "win32",
    env: { ...env, BROWSER_RELAY_TEST_EXIT: "7" },
    encoding: "utf8",
  });
  assert.equal(failure.status, 7, failure.stderr);
});

test("Windows runner reports resolution errors and preserves signals", () => {
  const missing = runNpxSync(["--version"], {
    platformName: "win32",
    env: { BROWSER_RELAY_NPX_CLI: join(tmpdir(), "browser-relay-missing-npx-cli.js") },
  });
  assert.equal(missing.error?.code, "ENOENT");
  assert.equal(missing.status, null);

  const root = mkdtempSync(join(tmpdir(), "browser-relay-npx-signal-"));
  const npxCli = join(root, "npx-cli.js");
  writeFileSync(npxCli, "");
  try {
    const signalled = runNpxSync(["--version"], {
      platformName: "win32",
      env: { BROWSER_RELAY_NPX_CLI: npxCli },
      spawnSyncFn: () => ({ error: undefined, status: null, signal: "SIGTERM" }),
    });
    assert.equal(signalled.status, null);
    assert.equal(signalled.signal, "SIGTERM");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows resolves and executes the npx CLI bundled with the runner Node", {
  skip: process.platform !== "win32",
}, () => {
  const env = { ...process.env };
  delete env.BROWSER_RELAY_NPX_CLI;
  const npxCli = resolveWindowsNpxCli({ env, execPath: process.execPath });
  assert.match(npxCli, /npx-cli\.js$/i);

  const result = runNpxSync(["--version"], {
    platformName: "win32",
    env,
    execPath: process.execPath,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

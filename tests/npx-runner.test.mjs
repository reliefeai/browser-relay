import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildNpxInvocation, runNpxSync } from "../server/npx-runner.js";

test("POSIX npx invocation preserves the argv array", () => {
  const args = ["--yes", "skills", "add", "/tmp/skill path", "--agent", "codex"];
  const env = { PATH: "/usr/bin" };

  assert.deepEqual(buildNpxInvocation(args, { platformName: "darwin", env }), {
    command: "npx",
    args,
    env,
  });
});

test("Windows npx invocation keeps dynamic values out of the cmd.exe command string", () => {
  const skillPath = "C:\\Users\\Agent User & Co\\browser relay\\skill";
  const args = ["--yes", "skills", "add", skillPath, "--global", "--agent", "codex"];
  const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe", PATH: "C:\\Windows" };

  const invocation = buildNpxInvocation(args, { platformName: "win32", env });

  assert.equal(invocation.command, env.ComSpec);
  assert.deepEqual(invocation.args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
  assert.equal(
    invocation.args[4],
    'npx.cmd "%BROWSER_RELAY_NPX_ARG_0%" "%BROWSER_RELAY_NPX_ARG_1%" "%BROWSER_RELAY_NPX_ARG_2%" "%BROWSER_RELAY_NPX_ARG_3%" "%BROWSER_RELAY_NPX_ARG_4%" "%BROWSER_RELAY_NPX_ARG_5%" "%BROWSER_RELAY_NPX_ARG_6%"',
  );
  assert.equal(invocation.env.BROWSER_RELAY_NPX_ARG_3, skillPath);
  assert.doesNotMatch(invocation.args[4], /Agent User|& Co/);
  assert.equal(invocation.env.PATH, env.PATH);
});

test("Windows runner executes npx.cmd with exact argv and exit code", {
  skip: process.platform !== "win32",
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), "browser relay & bang!-"));
  const bin = join(root, "fake bin");
  const script = join(bin, "fake-npx.cjs");
  const record = join(root, "received argv.json");
  mkdirSync(bin, { recursive: true });
  writeFileSync(script, [
    'const { writeFileSync } = require("node:fs");',
    'writeFileSync(process.env.BROWSER_RELAY_TEST_RECORD, JSON.stringify(process.argv.slice(2)));',
    'process.exit(Number(process.env.BROWSER_RELAY_TEST_EXIT || 0));',
    '',
  ].join("\n"));
  writeFileSync(join(bin, "npx.cmd"), [
    "@echo off",
    '"%BROWSER_RELAY_TEST_NODE%" "%BROWSER_RELAY_TEST_SCRIPT%" %*',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const skillPath = join(root, "skill path & bang!", "browser-relay");
  const args = ["--yes", "skills", "add", skillPath, "--global", "--yes", "--agent", "codex"];
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    BROWSER_RELAY_TEST_NODE: process.execPath,
    BROWSER_RELAY_TEST_SCRIPT: script,
    BROWSER_RELAY_TEST_RECORD: record,
  };

  const success = runNpxSync(args, { env, encoding: "utf8" });
  assert.equal(success.error, undefined);
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), args);

  const failure = runNpxSync(args, {
    env: { ...env, BROWSER_RELAY_TEST_EXIT: "7" },
    encoding: "utf8",
  });
  assert.equal(failure.status, 7, failure.stderr);
});

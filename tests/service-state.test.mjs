import test from "node:test";
import assert from "node:assert/strict";
import { inspectPosixServiceState, relayStartRemediation } from "../server/service-state.js";

const base = {
  plistPath: "/tmp/org.browser-relay.service.plist",
  systemdPath: "/tmp/browser-relay.service",
  launchdLabel: "org.browser-relay.service",
  systemdUnit: "browser-relay",
  existsSyncFn: () => true,
};

test("Linux service state handles a missing systemctl executable", () => {
  const error = Object.assign(new Error("spawnSync systemctl ENOENT"), { code: "ENOENT" });
  const state = inspectPosixServiceState({
    ...base,
    sys: "linux",
    spawnSyncFn: () => ({ error, status: null, stdout: undefined, stderr: undefined }),
  });

  assert.equal(state.checked, false);
  assert.equal(state.loaded, false);
  assert.equal(state.registered, true);
  assert.equal(state.error, "systemctl is unavailable (command not found)");
});

test("Linux service state reports an unavailable user bus without throwing", () => {
  const state = inspectPosixServiceState({
    ...base,
    sys: "linux",
    spawnSyncFn: () => ({
      error: undefined,
      status: 1,
      stdout: "",
      stderr: "Failed to connect to bus: No medium found\nsecond line is ignored",
    }),
  });

  assert.equal(state.checked, false);
  assert.equal(state.loaded, false);
  assert.equal(state.error, "systemd user status is unavailable: Failed to connect to bus: No medium found");
});

test("Linux service state recognizes active and inactive systemd states", () => {
  for (const [serviceStatus, loaded] of [["active", true], ["inactive", false], ["failed", false]]) {
    const state = inspectPosixServiceState({
      ...base,
      sys: "linux",
      spawnSyncFn: () => ({ error: undefined, status: loaded ? 0 : 3, stdout: `${serviceStatus}\n`, stderr: "" }),
    });
    assert.equal(state.checked, true);
    assert.equal(state.loaded, loaded);
    assert.equal(state.error, null);
  }
});

test("macOS service state reports missing stdout and finds an exact launchd label", () => {
  const unavailable = inspectPosixServiceState({
    ...base,
    sys: "darwin",
    spawnSyncFn: () => ({ error: undefined, status: 0, stdout: undefined, stderr: undefined }),
  });
  assert.equal(unavailable.checked, false);
  assert.equal(unavailable.loaded, false);
  assert.equal(unavailable.error, "launchctl status is unavailable: command returned no output");

  const loaded = inspectPosixServiceState({
    ...base,
    sys: "darwin",
    spawnSyncFn: () => ({
      error: undefined,
      status: 0,
      stdout: "812\t0\torg.browser-relay.service\n-\t0\torg.browser-relay.service-helper\n",
      stderr: "",
    }),
  });
  assert.equal(loaded.loaded, true);
  assert.equal(loaded.pid, "812");
});

test("relay recovery uses foreground mode when the service manager is unavailable", () => {
  assert.equal(
    relayStartRemediation({ checked: false, registered: true }),
    "Start the relay in a terminal with: browser-relay",
  );
  assert.equal(
    relayStartRemediation({ checked: true, registered: true }),
    "Run: browser-relay status, then browser-relay logs",
  );
  assert.equal(
    relayStartRemediation(null),
    "Start the relay in a terminal with: browser-relay",
  );
});

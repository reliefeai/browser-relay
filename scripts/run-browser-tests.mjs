import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-concurrency=1",
    "tests/browser-e2e.test.mjs",
    "tests/browser-reliability.test.mjs",
    "tests/browser-parity.test.mjs",
    "tests/browser-review.test.mjs",
    "tests/browser-activity.test.mjs",
    "tests/browser-background.test.mjs",
  ],
  { stdio: "inherit", env: { ...process.env, BROWSER_RELAY_E2E: "1" } },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

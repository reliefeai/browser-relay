import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

const WINDOWS_NPX_CLI_OVERRIDE = "BROWSER_RELAY_NPX_CLI";

function isRegularAbsoluteFile(candidate, statSyncFn) {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) return false;
  try {
    return statSyncFn(candidate).isFile();
  } catch {
    return false;
  }
}

function missingNpxCliError(message) {
  return Object.assign(new Error(message), { code: "ENOENT" });
}

export function resolveWindowsNpxCli(options = {}) {
  const sourceEnv = options.env || process.env;
  const execPath = options.execPath || process.execPath;
  const statSyncFn = options.statSyncFn || statSync;

  if (Object.prototype.hasOwnProperty.call(sourceEnv, WINDOWS_NPX_CLI_OVERRIDE)) {
    const override = sourceEnv[WINDOWS_NPX_CLI_OVERRIDE];
    if (isRegularAbsoluteFile(override, statSyncFn)) return override;
    throw missingNpxCliError(
      `${WINDOWS_NPX_CLI_OVERRIDE} must point to an existing absolute npx-cli.js file`,
    );
  }

  const npmExecPath = sourceEnv.npm_execpath;
  if (
    typeof npmExecPath === "string"
    && isAbsolute(npmExecPath)
    && basename(npmExecPath).toLowerCase() === "npm-cli.js"
  ) {
    const sibling = join(dirname(npmExecPath), "npx-cli.js");
    if (isRegularAbsoluteFile(sibling, statSyncFn)) return sibling;
  }

  if (typeof execPath === "string" && isAbsolute(execPath)) {
    const bundled = join(dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
    if (isRegularAbsoluteFile(bundled, statSyncFn)) return bundled;
  }

  throw missingNpxCliError(
    `Could not locate npm's npx-cli.js for Node ${execPath}. Reinstall Node.js with npm or set ${WINDOWS_NPX_CLI_OVERRIDE}.`,
  );
}

export function buildNpxInvocation(args, options = {}) {
  const platformName = options.platformName || platform();
  const sourceEnv = options.env || process.env;
  if (platformName !== "win32") {
    return { command: "npx", args: [...args], env: sourceEnv };
  }

  // Windows .cmd shims reparse `%*`, which can corrupt paths containing
  // spaces or shell metacharacters. Execute npm's JavaScript npx entry point
  // with the current Node process so every value remains a real argv item.
  const execPath = options.execPath || process.execPath;
  const npxCli = resolveWindowsNpxCli({
    env: sourceEnv,
    execPath,
    statSyncFn: options.statSyncFn,
  });
  return {
    command: execPath,
    args: [npxCli, ...args],
    env: sourceEnv,
  };
}

export function runNpxSync(args, options = {}) {
  const {
    platformName,
    env = process.env,
    execPath,
    statSyncFn,
    spawnSyncFn = spawnSync,
    ...spawnOptions
  } = options;
  let invocation;
  try {
    invocation = buildNpxInvocation(args, { platformName, env, execPath, statSyncFn });
  } catch (error) {
    return { error, status: null, signal: null, stdout: null, stderr: null };
  }
  return spawnSyncFn(invocation.command, invocation.args, {
    ...spawnOptions,
    env: invocation.env,
  });
}

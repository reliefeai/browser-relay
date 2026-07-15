import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const WINDOWS_ARG_PREFIX = "BROWSER_RELAY_NPX_ARG_";

export function buildNpxInvocation(args, options = {}) {
  const platformName = options.platformName || platform();
  const sourceEnv = options.env || process.env;
  if (platformName !== "win32") {
    return { command: "npx", args: [...args], env: sourceEnv };
  }

  // .cmd shims cannot be executed directly by child_process on Windows.
  // Keep every dynamic value out of the cmd.exe command string: paths may
  // contain spaces or metacharacters, while quoted environment expansion
  // preserves them as one argument. Delayed expansion is disabled so `!`
  // in a path stays literal.
  const env = { ...sourceEnv };
  const references = args.map((value, index) => {
    const name = `${WINDOWS_ARG_PREFIX}${index}`;
    env[name] = value;
    return `"%${name}%"`;
  });
  return {
    command: sourceEnv.ComSpec || sourceEnv.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", `npx.cmd ${references.join(" ")}`],
    env,
  };
}

export function runNpxSync(args, options = {}) {
  const { platformName, env = process.env, ...spawnOptions } = options;
  const invocation = buildNpxInvocation(args, { platformName, env });
  return spawnSync(invocation.command, invocation.args, {
    ...spawnOptions,
    env: invocation.env,
  });
}

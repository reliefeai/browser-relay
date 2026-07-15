#!/usr/bin/env node
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function redirect(stream, file) {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a");
  const original = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    let done = callback;
    let charset = encoding;
    if (typeof encoding === "function") {
      done = encoding;
      charset = undefined;
    }
    try {
      if (typeof chunk === "string") writeSync(fd, chunk, null, typeof charset === "string" ? charset : "utf8");
      else writeSync(fd, chunk);
      if (typeof done === "function") queueMicrotask(done);
      return true;
    } catch (error) {
      return original(chunk, encoding, callback) && !error;
    }
  };
  process.on("exit", () => {
    try { closeSync(fd); } catch {}
  });
}

const entry = option("--entry");
const stdoutLog = option("--stdout-log");
const stderrLog = option("--stderr-log");

if (!entry || !stdoutLog || !stderrLog) {
  console.error("Usage: windows-service-entry --entry <file> --stdout-log <file> --stderr-log <file>");
  process.exit(2);
}

redirect(process.stdout, stdoutLog);
redirect(process.stderr, stderrLog);
// Match the launchd/systemd service definitions: the managed local service is
// always loopback-only on the standard port. Remote control remains outbound.
process.env.BROWSER_RELAY_HOST = "127.0.0.1";
process.env.BROWSER_RELAY_PORT = "18795";
process.argv = [process.execPath, entry];

try {
  await import(pathToFileURL(entry).href);
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}

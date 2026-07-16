import { readFileSync } from "node:fs";

const mode = process.env.BROWSER_RELAY_TEST_FETCH_MODE;
const packageVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")).version;

if (mode === "healthy") {
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    version: packageVersion,
    connected: true,
    tabCount: 1,
    uptimeSeconds: 12,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
} else if (mode === "unreachable") {
  globalThis.fetch = async () => {
    throw new TypeError("mock relay unavailable");
  };
}

import { chromium } from "playwright";
import { createServer } from "node:http";
import net from "node:net";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createBrowser, createTransport } from "../../server/sdk.js";

export async function waitFor(fn, timeout = 10000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw last || new Error("condition timed out");
}
export async function setupBrowser({
  headed = false,
  relayLatencyMs = 0,
  viewport = { width: 1280, height: 1000 },
  fixtureFile = "automation.html",
  nativeVisibility = false,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "browser-relay-e2e-"));
  const ext = join(dir, "extension");
  await cp(new URL("../../extension/", import.meta.url), ext, {
    recursive: true,
  });
  const reservation = createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  let proxy,
    extensionPort = port;
  const sockets = new Set();
  if (relayLatencyMs) {
    proxy = net.createServer((downstream) => {
      const upstream = net.connect({ host: "127.0.0.1", port });
      sockets.add(downstream);
      sockets.add(upstream);
      for (const [from, to] of [
        [downstream, upstream],
        [upstream, downstream],
      ]) {
        from.on("data", (data) =>
          setTimeout(() => {
            if (!to.destroyed) to.write(data);
          }, relayLatencyMs / 2),
        );
        from.on("error", () => to.destroy());
        from.on("close", () => {
          to.destroy();
          sockets.delete(from);
        });
      }
    });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    extensionPort = proxy.address().port;
  }
  const background = join(ext, "background.js");
  await writeFile(
    background,
    (await readFile(background, "utf8")).replace(
      "const DEFAULT_PORT = 18795",
      `const DEFAULT_PORT = ${extensionPort}`,
    ),
  );
  const relay = spawn(process.execPath, ["server/relay-server.js"], {
    cwd: new URL("../..", import.meta.url),
    env: {
      ...process.env,
      BROWSER_RELAY_PORT: String(port),
      BROWSER_RELAY_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let relayLog = "";
  relay.stdout.on("data", (b) => (relayLog += b));
  relay.stderr.on("data", (b) => (relayLog += b));
  let context, fixture, nativeProcess, nativeBrowser;
  const close = async () => {
    if (nativeBrowser) await nativeBrowser.close();
    else await context?.close();
    if (nativeProcess && nativeProcess.exitCode === null && nativeProcess.signalCode === null) {
      const exited = new Promise(resolve => nativeProcess.once('exit', resolve));
      nativeProcess.kill('SIGTERM');
      await exited;
    }
    relay.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    if (proxy) await new Promise((r) => proxy.close(r));
    if (fixture) await new Promise((r) => fixture.close(r));
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/`)).ok);
    const html = await readFile(
      new URL(`../fixtures/${fixtureFile}`, import.meta.url),
      "utf8",
    );
    fixture = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        req.url.startsWith("/frame")
          ? `<title>Frame</title><button onclick="this.textContent='Frame done'">${req.url.includes("cross") ? "Cross frame" : "Frame action"}</button>`
          : html,
      );
    });
    await new Promise((r) => fixture.listen(0, r));
    const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
    if (nativeVisibility) {
      // Normal Playwright startup forces focus emulation on every page. A
      // native launch plus noDefaults keeps real background visibility.
      nativeProcess = spawn(chromium.executablePath(), [
        `--user-data-dir=${join(dir, 'profile')}`,
        '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
        ...(!headed ? ['--headless=new'] : []),
        `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, 'about:blank',
      ], { stdio: 'ignore' });
      const cdpPort = await waitFor(async () => (await readFile(join(dir, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      nativeBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { noDefaults: true });
      context = nativeBrowser.contexts()[0];
    } else context = await chromium.launchPersistentContext(join(dir, "profile"), {
      channel: "chromium",
      headless: !headed,
      viewport,
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(fixtureUrl);
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const request = createTransport({
      url: `http://127.0.0.1:${port}`,
      remoteDeviceId: "",
    });
    const browser = createBrowser({ request, sessionId: "e2e" });
    const target = await waitFor(async () =>
      (await browser.tabs()).find((t) => t.url === fixtureUrl),
    );
    return {
      context,
      page,
      worker,
      fixtureUrl,
      port,
      browser,
      request,
      tab: browser.tab(target.id),
      close,
      relayLog: () => relayLog,
      dir,
    };
  } catch (error) {
    await close();
    throw new Error(`${error.message}\n${relayLog.slice(-3000)}`);
  }
}

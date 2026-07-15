#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "demo");
const port = Number(process.env.PORT || 4173);

const server = createServer((request, response) => {
  const path = request.url === "/" ? "/intranet.html" : request.url;
  if (path !== "/intranet.html") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  createReadStream(join(root, "intranet.html")).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Browser Relay demo: http://127.0.0.1:${port}/intranet.html`);
});

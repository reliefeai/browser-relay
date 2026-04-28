#!/usr/bin/env node
// Sync extension/manifest.json version to package.json version.
// Run via `npm run sync-version` or automatically on `prepublishOnly`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const manifestPath = join(root, "extension/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[sync-version] extension/manifest.json -> ${pkg.version}`);
} else {
  console.log(`[sync-version] already at ${pkg.version}`);
}

#!/usr/bin/env node
// Sync package-owned agent marketplace manifests to package.json.
// The Chrome Web Store extension has an independent release version.
// Run via `npm run sync-version` or automatically on `prepublishOnly`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const manifestPaths = [
  "gemini-extension.json",
  ".github/plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".codex-plugin/plugin.json",
];

for (const relativePath of manifestPaths) {
  const manifestPath = join(root, relativePath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (manifest.version === pkg.version) {
    console.log(`[sync-version] ${relativePath} already at ${pkg.version}`);
    continue;
  }
  manifest.version = pkg.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[sync-version] ${relativePath} -> ${pkg.version}`);
}

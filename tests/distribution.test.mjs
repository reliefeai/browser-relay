import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf-8'));

test('agent marketplace manifests follow the package version and standard skill path', () => {
  const pkg = readJson('package.json');
  const manifests = [
    'extension/manifest.json',
    'gemini-extension.json',
    '.github/plugin/plugin.json',
    '.claude-plugin/plugin.json',
    '.cursor-plugin/plugin.json',
    '.codex-plugin/plugin.json',
  ];

  for (const path of manifests) {
    assert.equal(readJson(path).version, pkg.version, path);
  }
  assert.ok(existsSync(join(root, 'skills/browser-relay/SKILL.md')));
  assert.ok(pkg.files.includes('skills/'));
});

test('npm can select the English root README without dropping Chinese docs', () => {
  const rootReadmes = readdirSync(root)
    .filter((name) => /^readme(?:\.|$)/i.test(name))
    .sort();

  assert.deepEqual(rootReadmes, ['README.md']);
  assert.ok(existsSync(join(root, 'docs/README.zh-CN.md')));
});

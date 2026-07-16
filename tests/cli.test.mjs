import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version;
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bundledSkillDir = join(repoRoot, 'skill');
const bundledSkill = readFileSync(join(bundledSkillDir, 'SKILL.md'), 'utf-8');

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startFakeRelay(t, handler) {
  const port = await getFreePort();
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { port };
}

function runCli(t, port, args, env = {}) {
  const childEnv = { ...process.env };
  if (port === null) {
    delete childEnv.BROWSER_RELAY_URL;
    delete childEnv.BROWSER_RELAY_HOST;
    delete childEnv.BROWSER_RELAY_PORT;
  } else {
    childEnv.BROWSER_RELAY_URL = `http://127.0.0.1:${port}`;
  }
  Object.assign(childEnv, env);
  const child = spawn(process.execPath, ['server/cli.js', ...args], {
    cwd: new URL('..', import.meta.url),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function setupFakeNpx(t) {
  const root = mkdtempSync(join(tmpdir(), 'browser-relay-skill-test-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const fakeSource = `
const { copyFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const home = process.env.USERPROFILE || process.env.HOME;
writeFileSync(join(home, 'npx-args.json'), JSON.stringify(args));
if (process.env.FAKE_NPX_MODE === 'nonzero') process.exit(7);
if (process.env.FAKE_NPX_MODE === 'signal') process.kill(process.pid, 'SIGTERM');
if (process.env.FAKE_NPX_MODE === 'no-copy') process.exit(0);
const addIndex = args.indexOf('add');
const agentIndex = args.indexOf('--agent');
const source = args[addIndex + 1];
const agents = agentIndex === -1 ? [] : args.slice(agentIndex + 1);
for (const agent of agents) {
  const base = agent === 'claude-code'
    ? join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills')
    : join(home, '.agents', 'skills');
  const target = join(base, 'browser-relay');
  mkdirSync(target, { recursive: true });
  copyFileSync(join(source, 'SKILL.md'), join(target, 'SKILL.md'));
}
`;
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'fake-npx.cjs'), fakeSource);
    writeFileSync(join(bin, 'npx.cmd'), [
      '@echo off',
      `"${process.execPath}" "%~dp0fake-npx.cjs" %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n'));
  } else {
    const npx = join(bin, 'npx');
    writeFileSync(npx, `#!/usr/bin/env node\n${fakeSource}`);
    chmodSync(npx, 0o755);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    home,
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
    },
  };
}

test('remote add creates POSIX credential storage with private permissions', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'browser-relay-remotes-new-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deviceId = 'br-G1PMrqZmTckQP63P';

  const result = await runCli(t, 0, ['remote', 'add', 'office', deviceId], { HOME: home, USERPROFILE: home });
  assert.equal(result.code, 0, result.stderr);
  const dir = join(home, '.browser-relay');
  const file = join(dir, 'remotes.json');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(deviceId));

  const jsonList = await runCli(t, 0, ['remote', 'ls', '--json'], { HOME: home, USERPROFILE: home });
  assert.equal(jsonList.code, 0, jsonList.stderr);
  assert.doesNotMatch(jsonList.stdout + jsonList.stderr, /G1PMrqZmTckQP63P|br-G1PMrqZmTckQP63P/);
  assert.deepEqual(JSON.parse(jsonList.stdout).office, {
    maskedDeviceId: '(redacted)',
    host: 'https://relay.linso.ai',
  });
  for (const fragment of ['G1PM', 'rqZm', 'TckQ', 'P63P']) {
    assert.equal((jsonList.stdout + jsonList.stderr).includes(fragment), false);
  }

  const humanList = await runCli(t, 0, ['remote', 'ls'], { HOME: home, USERPROFILE: home });
  assert.equal(humanList.code, 0, humanList.stderr);
  assert.doesNotMatch(humanList.stdout + humanList.stderr, /G1PMrqZmTckQP63P|br-G1PMrqZmTckQP63P/);
  assert.match(humanList.stdout, /\(redacted\)/);
  for (const fragment of ['G1PM', 'rqZm', 'TckQ', 'P63P']) {
    assert.equal((humanList.stdout + humanList.stderr).includes(fragment), false);
  }
});

test('remote add tightens existing wide POSIX credential storage permissions', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'browser-relay-remotes-existing-'));
  const home = join(root, 'home');
  const dir = join(home, '.browser-relay');
  const file = join(dir, 'remotes.json');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  writeFileSync(file, '{}\n', { mode: 0o644 });
  chmodSync(dir, 0o755);
  chmodSync(file, 0o644);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await runCli(t, 0, ['remote', 'add', 'office', 'br-G1PMrqZmTckQP63P'], { HOME: home, USERPROFILE: home });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('remote validation errors do not echo a supplied device capability', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'browser-relay-remotes-error-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const invalidDeviceId = 'br-secret-that-must-never-appear-in-errors!';

  const result = await runCli(t, 0, ['remote', 'add', 'office', invalidDeviceId], { HOME: home, USERPROFILE: home });
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(invalidDeviceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('skill install passes explicit agents and verifies every copied target', async (t) => {
  const fixture = setupFakeNpx(t);
  const claudeHome = join(fixture.root, 'custom-claude');
  const result = await runCli(t, 0, [
    'skill', 'install', '--agent', 'codex', 'claude-code',
  ], {
    ...fixture.env,
    CLAUDE_CONFIG_DIR: claudeHome,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.home, 'npx-args.json'), 'utf-8')), [
    '--yes',
    'skills',
    'add',
    bundledSkillDir,
    '--global',
    '--yes',
    '--copy',
    '--agent',
    'codex',
    'claude-code',
  ]);
  const codexTarget = join(fixture.home, '.agents/skills/browser-relay/SKILL.md');
  const claudeTarget = join(claudeHome, 'skills/browser-relay/SKILL.md');
  assert.equal(readFileSync(codexTarget, 'utf-8'), bundledSkill);
  assert.equal(readFileSync(claudeTarget, 'utf-8'), bundledSkill);
  assert.ok(result.stdout.includes(`codex: ${codexTarget}`));
  assert.ok(result.stdout.includes(`claude-code: ${claudeTarget}`));
});

test('skill install rejects silent zero-install and normalizes npx failures', async (t) => {
  const silent = setupFakeNpx(t);
  const noCopy = await runCli(t, 0, ['skill', 'install', '--agent', 'codex'], {
    ...silent.env,
    FAKE_NPX_MODE: 'no-copy',
  });
  assert.equal(noCopy.code, 1);
  assert.match(noCopy.stderr, /target verification failed/);
  assert.match(noCopy.stderr, /codex: missing/);

  const failed = setupFakeNpx(t);
  const nonzero = await runCli(t, 0, ['skill', 'install', '--agent', 'codex'], {
    ...failed.env,
    FAKE_NPX_MODE: 'nonzero',
  });
  assert.equal(nonzero.code, 1);
  assert.match(nonzero.stderr, /skills command failed with exit code 7/);

  if (process.platform !== 'win32') {
    const signalled = setupFakeNpx(t);
    const signal = await runCli(t, 0, ['skill', 'install', '--agent', 'codex'], {
      ...signalled.env,
      FAKE_NPX_MODE: 'signal',
    });
    assert.equal(signal.code, 1);
    assert.match(signal.stderr, /terminated by signal SIGTERM/);
  }

  const missingRoot = mkdtempSync(join(tmpdir(), 'browser-relay-no-npx-'));
  const emptyBin = join(missingRoot, 'bin');
  const emptyHome = join(missingRoot, 'home');
  mkdirSync(emptyBin, { recursive: true });
  mkdirSync(emptyHome, { recursive: true });
  t.after(() => rmSync(missingRoot, { recursive: true, force: true }));
  const missingNpx = await runCli(t, 0, ['skill', 'install', '--agent', 'codex'], {
    HOME: emptyHome,
    USERPROFILE: emptyHome,
    PATH: emptyBin,
  });
  assert.equal(missingNpx.code, 1);
  assert.match(missingNpx.stderr, /Could not run npx|skills command failed/);
});

test('skill subcommands keep legacy output while enforcing explicit install targets', async (t) => {
  const legacy = await runCli(t, 0, ['skill']);
  assert.equal(legacy.code, 0);
  assert.match(legacy.stdout, /^npx --yes skills add /);
  assert.match(legacy.stdout, /--global --yes --copy --agent codex$/m);

  const command = await runCli(t, 0, ['skill', 'command', '--agent=claude-code']);
  assert.equal(command.code, 0);
  assert.match(command.stdout, /--agent claude-code$/m);

  const deduplicated = await runCli(t, 0, [
    'skill', 'command', '--agent', 'codex', 'codex', 'universal',
  ]);
  assert.equal(deduplicated.code, 0);
  assert.match(deduplicated.stdout, /--agent codex universal$/m);

  const path = await runCli(t, 0, ['skill', 'path']);
  assert.equal(path.code, 0);
  assert.equal(path.stdout.trim(), bundledSkillDir);

  const help = await runCli(t, 0, ['skill', 'help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /codex, claude-code, universal/);

  const missing = await runCli(t, 0, ['skill', 'install']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Missing required option: --agent/);

  const unsupported = await runCli(t, 0, ['skill', 'install', '--agent', 'cursor']);
  assert.equal(unsupported.code, 2);
  assert.match(unsupported.stderr, /Unsupported agent: cursor/);
});

test('CLI --json preserves structured relay errors on failure', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = JSON.stringify({
      ok: false,
      code: 'endpoint_not_found',
      error: 'Unknown API endpoint: /api/tabs',
      message: 'Unknown API endpoint: /api/tabs',
      status: 404,
      retryable: false,
    });
    res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['tabs', '--json']);

  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'endpoint_not_found');
  assert.equal(payload.status, 404);
});

test('status executes its platform service probe without a missing spawnSync import', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = JSON.stringify({ ok: true, version: packageVersion, connected: true, tabCount: 1 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['status']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Service:/m);
  assert.match(result.stdout, /^HTTP:\s+responding/m);
  assert.doesNotMatch(result.stderr, /spawnSync is not defined/);
});

test('status rejects an unrelated HTTP 200 response as unhealthy', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = JSON.stringify({ status: 'ok' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['status']);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /^HTTP:\s+not responding/m);
});

test('Linux status and doctor recover cleanly without systemctl', { skip: process.platform !== 'linux' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'browser-relay-no-systemctl-'));
  const home = join(root, 'home');
  const emptyPath = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(emptyPath, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const healthy = await runCli(t, null, ['status'], {
    HOME: home,
    USERPROFILE: home,
    PATH: emptyPath,
    NODE_OPTIONS: `--import=${pathToFileURL(join(repoRoot, 'tests/fixtures/mock-doctor-fetch.mjs')).href}`,
    BROWSER_RELAY_TEST_FETCH_MODE: 'healthy',
  });

  assert.equal(healthy.code, 0);
  assert.match(healthy.stdout, /Service:\s+unknown/);
  assert.match(healthy.stdout, /systemctl is unavailable \(command not found\)/);
  assert.match(healthy.stdout, /HTTP:\s+responding/);
  assert.doesNotMatch(healthy.stdout, /Run the relay in this terminal/);
  assert.doesNotMatch(healthy.stdout + healthy.stderr, /TypeError|Cannot read properties/);

  const healthyDoctor = await runCli(t, null, ['doctor', '--json'], {
    HOME: home,
    USERPROFILE: home,
    PATH: emptyPath,
    NODE_OPTIONS: `--import=${pathToFileURL(join(repoRoot, 'tests/fixtures/mock-doctor-fetch.mjs')).href}`,
    BROWSER_RELAY_TEST_FETCH_MODE: 'healthy',
  });
  assert.equal(healthyDoctor.code, 0);
  assert.equal(healthyDoctor.stderr.trim(), '');
  const healthyPayload = JSON.parse(healthyDoctor.stdout);
  const healthyService = healthyPayload.checks.find((check) => check.id === 'service.registration');
  assert.equal(healthyService.status, 'warn');
  assert.equal(healthyService.details.checked, false);
  assert.equal('remediation' in healthyService, false);
  assert.equal(healthyPayload.recommendations.some((item) => item.includes('Start the relay')), false);

  const unavailable = await runCli(t, null, ['status'], {
    HOME: home,
    USERPROFILE: home,
    PATH: emptyPath,
    NODE_OPTIONS: `--import=${pathToFileURL(join(repoRoot, 'tests/fixtures/mock-doctor-fetch.mjs')).href}`,
    BROWSER_RELAY_TEST_FETCH_MODE: 'unreachable',
  });
  assert.equal(unavailable.code, 1);
  assert.match(unavailable.stdout, /HTTP:\s+not responding/);
  assert.match(unavailable.stdout, /Run the relay in this terminal: browser-relay/);
  assert.doesNotMatch(unavailable.stdout + unavailable.stderr, /TypeError|Cannot read properties/);

  const unavailableDoctor = await runCli(t, null, ['doctor', '--json'], {
    HOME: home,
    USERPROFILE: home,
    PATH: emptyPath,
    NODE_OPTIONS: `--import=${pathToFileURL(join(repoRoot, 'tests/fixtures/mock-doctor-fetch.mjs')).href}`,
    BROWSER_RELAY_TEST_FETCH_MODE: 'unreachable',
  });
  assert.equal(unavailableDoctor.code, 1);
  assert.equal(unavailableDoctor.stderr.trim(), '');
  const unavailablePayload = JSON.parse(unavailableDoctor.stdout);
  assert.equal(unavailablePayload.ok, false);
  assert.ok(unavailablePayload.recommendations.includes('Start the relay in a terminal with: browser-relay'));
});

test('Linux status reports an unavailable systemd user bus without throwing', { skip: process.platform !== 'linux' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'browser-relay-no-user-bus-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const systemctl = join(bin, 'systemctl');
  writeFileSync(systemctl, '#!/bin/sh\necho "Failed to connect to bus: No medium found" >&2\nexit 1\n');
  chmodSync(systemctl, 0o755);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await runCli(t, null, ['status'], {
    HOME: home,
    USERPROFILE: home,
    PATH: bin,
    NODE_OPTIONS: `--import=${pathToFileURL(join(repoRoot, 'tests/fixtures/mock-doctor-fetch.mjs')).href}`,
    BROWSER_RELAY_TEST_FETCH_MODE: 'unreachable',
  });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /systemd user status is unavailable: Failed to connect to bus: No medium found/);
  assert.doesNotMatch(result.stdout + result.stderr, /TypeError|Cannot read properties/);

  const doctor = await runCli(t, null, ['doctor', '--json'], {
    HOME: home,
    USERPROFILE: home,
    PATH: bin,
    NODE_OPTIONS: `--import=${pathToFileURL(join(repoRoot, 'tests/fixtures/mock-doctor-fetch.mjs')).href}`,
    BROWSER_RELAY_TEST_FETCH_MODE: 'unreachable',
  });
  assert.equal(doctor.code, 1);
  assert.equal(doctor.stderr.trim(), '');
  const payload = JSON.parse(doctor.stdout);
  const service = payload.checks.find((check) => check.id === 'service.registration');
  assert.equal(service.details.checked, false);
  assert.match(service.details.error, /Failed to connect to bus: No medium found/);
  assert.ok(payload.recommendations.includes('Start the relay in a terminal with: browser-relay'));
});

test('wait CLI sends stable options and prints a compact success', async (t) => {
  let received = null;
  const relay = await startFakeRelay(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    received = { method: req.method, url: req.url, body: JSON.parse(raw) };
    const body = JSON.stringify({
      ok: true,
      matched: true,
      selector: '.ready',
      state: 'attached',
      elapsedMs: 75,
      attempts: 2,
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, [
    'wait', '.ready', '--state', 'attached', '--timeout', '2500', '--poll', '75', '--tab', 'tab-1',
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Matched attached: .ready (75ms, 2 attempts)');
  assert.deepEqual(received, {
    method: 'POST',
    url: '/api/wait',
    body: { selector: '.ready', state: 'attached', timeoutMs: 2500, pollMs: 75, tabId: 'tab-1' },
  });
});

test('doctor reports a ready end-to-end browser path as structured JSON', async (t) => {
  const relay = await startFakeRelay(t, (req, res) => {
    assert.equal(req.url, '/api/debug');
    const body = JSON.stringify({ ok: true, version: packageVersion, connected: true, tabCount: 2, uptimeSeconds: 42 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['doctor', '--json']);

  assert.equal(result.code, 0);
  assert.equal(result.stderr.trim(), '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal('ready' in payload, false);
  assert.equal(payload.version, 1);
  assert.equal(payload.cliVersion, packageVersion);
  assert.deepEqual(payload.checks.map((check) => check.id), [
    'runtime',
    'assets.extension',
    'assets.skill',
    'service.registration',
    'relay.http',
    'relay.version',
    'extension.connection',
    'tabs.attached',
    'logs.access',
  ]);
  assert.equal(payload.checks.find((check) => check.id === 'extension.connection').status, 'pass');
  assert.equal(payload.checks.find((check) => check.id === 'tabs.attached').details.count, 2);
  assert.equal(payload.checks.find((check) => check.id === 'relay.http').details.uptimeSeconds, 42);
  assert.equal(payload.checks.find((check) => check.id === 'service.registration').status, 'skip');
  assert.equal(payload.summary.failed, 0);
  assert.deepEqual(payload.recommendations.filter((item) => item.includes('reload the unpacked extension')), []);
});

test('doctor recognizes the standard global .agents skill directory', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'browser-relay-doctor-skill-'));
  const home = join(root, 'home');
  const targetDir = join(home, '.agents/skills/browser-relay');
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(bundledSkillDir, 'SKILL.md'), join(targetDir, 'SKILL.md'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const relay = await startFakeRelay(t, (_req, res) => {
    const body = JSON.stringify({ ok: true, version: packageVersion, connected: true, tabCount: 1 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  const result = await runCli(t, relay.port, ['doctor', '--json'], {
    HOME: home,
    USERPROFILE: home,
  });

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const skill = payload.checks.find((check) => check.id === 'assets.skill');
  assert.equal(skill.status, 'pass');
  assert.deepEqual(skill.details.installations, [{
    path: join(targetDir, 'SKILL.md'),
    status: 'current',
  }]);
});

test('doctor treats a disconnected extension and zero tabs as warnings', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = JSON.stringify({ ok: true, version: packageVersion, connected: false, tabCount: 0 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['doctor', '--json']);

  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal('ready' in payload, false);
  assert.equal(payload.checks.find((check) => check.id === 'extension.connection').status, 'warn');
  assert.equal(payload.checks.find((check) => check.id === 'tabs.attached').status, 'warn');
  assert.ok(payload.recommendations.some((item) => item.includes('reload the unpacked extension')));
  assert.ok(payload.recommendations.some((item) => item.includes('browser-relay tabs')));
});

test('doctor warns but succeeds when CLI and daemon versions differ', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = JSON.stringify({ ok: true, version: '0.0.0-test', connected: true, tabCount: 1 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['doctor', '--json']);

  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.checks.find((check) => check.id === 'relay.version').status, 'warn');
  assert.equal(payload.summary.failed, 0);
  assert.ok(payload.recommendations.some((item) => item.includes('Restart the foreground relay process')));
});

test('doctor fails only the HTTP check for an invalid relay response', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = 'not json';
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['doctor', '--json']);

  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.checks.find((check) => check.id === 'relay.http').status, 'fail');
  assert.equal(payload.checks.find((check) => check.id === 'relay.version').status, 'skip');
  assert.equal(payload.checks.find((check) => check.id === 'extension.connection').status, 'skip');
  assert.equal(payload.checks.find((check) => check.id === 'tabs.attached').status, 'skip');
});

test('doctor rejects a JSON object that is not the debug endpoint contract', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = JSON.stringify({});
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['doctor', '--json']);

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.checks.find((check) => check.id === 'relay.http').status, 'fail');
  assert.match(payload.checks.find((check) => check.id === 'relay.http').message, /invalid debug payload/);
});

test('doctor human output has stable prefixes and summary', async (t) => {
  const relay = await startFakeRelay(t, (_req, res) => {
    const body = JSON.stringify({ ok: true, version: packageVersion, connected: false, tabCount: 0 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  const result = await runCli(t, relay.port, ['doctor'], { NO_COLOR: '1' });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Browser Relay doctor/m);
  assert.match(result.stdout, /^\[PASS\] Relay HTTP debug endpoint is healthy$/m);
  assert.match(result.stdout, /^\[WARN\] Chrome extension is not connected$/m);
  assert.match(result.stdout, /^\[SKIP\] Local background service check skipped for a custom relay URL$/m);
  assert.match(result.stdout, /^Doctor: \d+ passed, \d+ warnings, 0 failed, \d+ skipped$/m);
  assert.doesNotMatch(result.stdout, /\x1b\[/);
});

test('doctor redacts query parameters from its JSON relay URL', async (t) => {
  const relay = await startFakeRelay(t, (req, res) => {
    assert.equal(req.url, '/api/debug?token=secret-value');
    const body = JSON.stringify({ ok: true, version: packageVersion, connected: true, tabCount: 1 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  const relayUrl = `http://127.0.0.1:${relay.port}?token=secret-value`;

  const result = await runCli(t, relay.port, ['doctor', '--json'], { BROWSER_RELAY_URL: relayUrl });

  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /secret-value/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.relayUrl, `http://127.0.0.1:${relay.port}`);
});

test('doctor uses exit code 2 for unknown options and supports help', async (t) => {
  const port = await getFreePort();
  const invalid = await runCli(t, port, ['doctor', '--bogus']);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /Unknown doctor option: --bogus/);

  const invalidJson = await runCli(t, port, ['doctor', '--json', '--bogus']);
  assert.equal(invalidJson.code, 2);
  assert.equal(invalidJson.stderr.trim(), '');
  assert.equal(JSON.parse(invalidJson.stdout).code, 'invalid_option');

  const help = await runCli(t, port, ['doctor', '--help']);
  assert.equal(help.code, 0);
  assert.equal(help.stderr.trim(), '');
  assert.match(help.stdout, /browser-relay doctor \[--json\]/);
  assert.match(help.stdout, /never installs or restarts anything/);
});

test('doctor rejects URL userinfo without exposing credentials', async (t) => {
  const port = await getFreePort();
  const relayUrl = `http://secret-user:secret-password@127.0.0.1:${port}`;

  const result = await runCli(t, port, ['doctor', '--json'], { BROWSER_RELAY_URL: relayUrl });

  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout, /secret-user|secret-password/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.relayUrl, `http://127.0.0.1:${port}`);
  assert.match(payload.checks.find((check) => check.id === 'relay.http').message, /userinfo is not supported/);
});

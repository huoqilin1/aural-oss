import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, relative, isAbsolute } from 'node:path';
import { mkdirSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { checkLocalIsolation, requiredServices } from '../scripts/check-local-isolation.mjs';
const root = resolve(import.meta.dirname, '..');
const valid = () => ({ mode: 'mock', loadDotenv: false, notifications: 'local-sink', dataRoot: resolve(root, 'output/local-sandbox/unit-fixture'), services: Object.fromEntries(requiredServices.map(name => [name, 'http://127.0.0.1:19001'])) });
test('local config validation never claims full acceptance', () => {
  const result = checkLocalIsolation(valid(), root);
  assert.equal(result.configurationCheckPassed, true);
  assert.equal(result.fullLocalAcceptancePassed, false);
});
test('missing configuration fails closed', () => assert.equal(checkLocalIsolation({}, root).configurationCheckPassed, false));
test('each backend including callbacks must explicitly be local', () => {
  for (const name of requiredServices) {
    const c = valid(); c.services[name] = 'https://hr.yifx.vip';
    assert.ok(checkLocalIsolation(c, root).errors.includes(`SERVICE_NOT_EXPLICIT_LOOPBACK:${name}`));
  }
});
test('DNS aliases, URL credentials, redirect parameters and unknown protocols are rejected', () => {
  for (const target of ['https://localhost.example.com', 'https://127.0.0.1.example.com', 'https://user:secret@127.0.0.1', 'http://127.0.0.1?next=https://hr.yifx.vip', 'file:///tmp/service']) {
    const c = valid(); c.services.hr = target;
    const result = checkLocalIsolation(c, root);
    assert.equal(result.configurationCheckPassed, false);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});
test('data root outside dedicated local sandbox is rejected', () => {
  for (const dataRoot of [root, resolve(root, '../production'), resolve(root, 'output/local-sandbox/../other')]) {
    const c = valid(); c.dataRoot = dataRoot;
    assert.ok(checkLocalIsolation(c, root).errors.includes('DATA_ROOT_NOT_ISOLATED'));
  }
});
test('dotenv and outbound notifications cannot silently default to live', () => {
  const c = valid(); delete c.loadDotenv; c.notifications = 'live';
  const result = checkLocalIsolation(c, root);
  assert.ok(result.errors.includes('DOTENV_NOT_DISABLED'));
  assert.ok(result.errors.includes('NOTIFICATIONS_NOT_LOCAL'));
});
test('real-provider mode is blocked until independent quota and isolation are verified', () => {
  const c = valid(); c.mode = 'real';
  assert.equal(checkLocalIsolation(c, root).configurationCheckPassed, false);
});
test('unreviewed additional targets are rejected', () => {
  const c = valid(); c.services.extra = 'https://hr.yifx.vip';
  assert.equal(checkLocalIsolation(c, root).configurationCheckPassed, false);
});
test('a sandbox junction cannot redirect test writes outside the dedicated root', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'aural-isolation-'));
  try {
    mkdirSync(resolve(fixture, 'output'));
    mkdirSync(resolve(fixture, 'outside'));
    symlinkSync(resolve(fixture, 'outside'), resolve(fixture, 'output/local-sandbox'), process.platform === 'win32' ? 'junction' : 'dir');
    const c = valid(); c.dataRoot = resolve(fixture, 'output/local-sandbox/run');
    assert.ok(checkLocalIsolation(c, fixture).errors.includes('DATA_ROOT_NOT_ISOLATED'));
  } finally {
    const rel = relative(resolve(tmpdir()), fixture);
    assert.ok(!isAbsolute(rel) && rel.startsWith('aural-isolation-') && !rel.includes('..'));
    rmSync(fixture, { recursive: true });
  }
});

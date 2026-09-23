import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const guard = new URL('./e2e/guard-production-e2e.mjs', import.meta.url);
const base = {
  ...process.env,
  PRODUCTION_E2E_APPROVED: 'YES', PRODUCTION_RESUME_APPROVED: 'YES',
  HR_API_BASE: 'https://hr.yifx.vip', RESUME_INDEX: '0', PRODUCTION_POSITION_ID: '9',
  APPLY_VIA: '', PRODUCTION_NEGATIVE_APPLY_APPROVED: '',
};
function run(extra) {
  return spawnSync(process.execPath, [guard.pathname.replace(/^\/(\w:)/, '$1')], {
    env: { ...base, ...extra }, encoding: 'utf8',
  });
}
for (const format of ['original', 'deidentified']) {
  test(`authorized ${format} resume hash is accepted without a sanitization flag`, () => {
    const hash = createHash('sha256').update(`fixture-${format}`).digest('hex');
    const result = run({ PRODUCTION_RESUME_TEXT_SHA256: hash });
    assert.equal(result.status, 0, result.stderr);
  });
}
test('missing batch approval still fails closed', () => {
  assert.equal(run({ PRODUCTION_E2E_APPROVED: '', PRODUCTION_RESUME_TEXT_SHA256: 'a'.repeat(64) }).status, 2);
});
test('missing sample hash still fails closed', () => {
  assert.equal(run({ PRODUCTION_RESUME_TEXT_SHA256: '' }).status, 2);
});
test('unapproved destination still fails closed', () => {
  assert.equal(run({ HR_API_BASE: 'https://example.invalid', PRODUCTION_RESUME_TEXT_SHA256: 'a'.repeat(64) }).status, 2);
});

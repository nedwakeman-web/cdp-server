'use strict';

/**
 * test-gap-parity.cjs
 *
 * Pins the Galactic Activation Portal set so the silent regression that shipped
 * a non canonical 52 entry set cannot recur. The stale build carried a set that
 * passed every existing test because no test asserted portal membership. This
 * file asserts the three structural properties of the canonical Loom of Maya:
 * exactly fifty two portals, 261 symmetry (every portal K pairs with 261 minus
 * K), and the two runs of ten consecutive portals at 106 to 115 and 146 to 155.
 * It also pins the anchor and the worked Kin values that the off by sixty fix
 * established.
 *
 * Run: node tests/test-gap-parity.cjs   (exit 0 on pass, 1 on any failure)
 *
 * House style holds: no em dashes, no en dashes, no exclamation marks.
 */

const assert = require('assert');
const c = require('../coordinates-core.cjs');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { failures += 1; console.log('FAIL  ' + name + '  ' + (e && e.message ? e.message : e)); }
}

const CANONICAL_GAP = [
  1, 20, 22, 39, 43, 50, 51, 58, 64, 69, 72, 77, 85, 88, 93, 96,
  106, 107, 108, 109, 110, 111, 112, 113, 114, 115,
  146, 147, 148, 149, 150, 151, 152, 153, 154, 155,
  165, 168, 173, 176, 184, 189, 192, 197, 203, 210, 211, 218, 222, 239, 241, 260,
];

check('the Kin anchor is 2024-07-08 = Kin 1', function () {
  assert.strictEqual(c.kinForDate('2024-07-08'), 1);
});

check('off by sixty fix: 2026-03-31 = Kin 112', function () {
  assert.strictEqual(c.kinForDate('2026-03-31'), 112);
});

check('three source verified: 2026-05-04 = Kin 146', function () {
  assert.strictEqual(c.kinForDate('2026-05-04'), 146);
});

check('the portal set is exactly the canonical fifty two', function () {
  const got = [];
  for (let k = 1; k <= 260; k += 1) if (c.isGAP(k)) got.push(k);
  assert.deepStrictEqual(got, CANONICAL_GAP);
});

check('the portal set is 261 symmetric', function () {
  for (const k of CANONICAL_GAP) {
    assert.ok(c.isGAP(261 - k), 'occult partner ' + (261 - k) + ' of portal ' + k + ' is missing');
  }
});

check('the two ten day portal runs are present and complete', function () {
  for (let k = 106; k <= 115; k += 1) assert.ok(c.isGAP(k), 'run one missing ' + k);
  for (let k = 146; k <= 155; k += 1) assert.ok(c.isGAP(k), 'run two missing ' + k);
});

check('non portal Kins from the stale set are no longer portals', function () {
  assert.strictEqual(c.isGAP(2), false);
  assert.strictEqual(c.isGAP(8), false);
  assert.strictEqual(c.isGAP(134), false);
});

if (failures > 0) { console.log('\n' + failures + ' check(s) failed'); process.exit(1); }
console.log('\nall portal parity checks passed');

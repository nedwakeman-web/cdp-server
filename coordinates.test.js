'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../lib/coordinates');

test('the anchor date is Kin 1, the corrected Law of Time StarRoot reference', () => {
  assert.equal(c.kinForDate('2024-07-08'), 1);
});

test('the day after the anchor is Kin 2', () => {
  assert.equal(c.kinForDate('2024-07-09'), 2);
});

test('the count wraps every 260 days back to Kin 1', () => {
  // 2024-07-08 plus 260 days, with no February 29 in the interval, returns to Kin 1.
  // 2024-07-08 to 2025-03-25 is 260 days (2025 is not a leap year).
  assert.equal(c.kinForDate('2025-03-25'), 1);
  assert.equal(c.kinForDate('2025-03-26'), 2);
});

test('dates before the anchor resolve with a positive modulo', () => {
  // The day before Kin 1 is Kin 260.
  assert.equal(c.kinForDate('2024-07-07'), 260);
});

test('February 29 is excluded, so it shares its Kin with February 28', () => {
  // Across a leap day, the counted-day gap between Feb 28 and Mar 1 is one, not
  // two, because Feb 29 is not counted. So their Kins differ by exactly one.
  const feb28 = c.kinForDate('2028-02-28');
  const mar01 = c.kinForDate('2028-03-01');
  const diff = ((mar01 - feb28) % 260 + 260) % 260;
  assert.equal(diff, 1, 'Feb 29 does not advance the Kin');
});

test('the production anchor was wrong by sixty; the corrected Kin for 2026-03-31 is reported for reference', () => {
  const kin = c.kinForDate('2026-03-31');
  // Invariant we assert: the corrected value is sixty ahead of the old wrong
  // value of 52 (modulo 260), which is what off-by-sixty means.
  const wrongProduction = 52;
  const expected = ((wrongProduction + 60 - 1) % 260) + 1;
  assert.equal(kin, expected);
});

test('tone and seal are derived correctly and held as distinct naming systems', () => {
  const d = c.kinDescriptor('2024-07-08'); // Kin 1
  assert.equal(d.kin, 1);
  assert.equal(d.tone, 1);
  assert.equal(d.toneName, 'Magnetic');
  assert.equal(d.sealName, 'Dragon');
  assert.equal(d.register, 'symbolic');
});

test('reduceNumber preserves master numbers and reduces the rest', () => {
  assert.equal(c.reduceNumber(29), 11); // 2 plus 9 is 11, a master, preserved
  assert.equal(c.reduceNumber(38), 11); // 3 plus 8 is 11
  assert.equal(c.reduceNumber(48), 3);  // 4 plus 8 is 12, then 1 plus 2 is 3
  assert.equal(c.reduceNumber(22), 22); // already a master
  assert.equal(c.reduceNumber(44), 44); // already a master
  assert.equal(c.reduceNumber(8), 8);
});

test('universalDay sums the full date and reduces under the master rule', () => {
  // 2024-07-08 digits sum to 2+0+2+4+0+7+0+8 = 23, then 2+3 = 5.
  const u = c.universalDay('2024-07-08');
  assert.equal(u.value, 5);
  assert.equal(u.isMaster, false);
  assert.equal(u.register, 'symbolic');
});

test('an invalid date shape is rejected rather than silently miscomputed', () => {
  assert.throws(() => c.kinForDate('2024/07/08'));
  assert.throws(() => c.universalDay('not-a-date'));
});

test('the portal set and lunar window report unknown until wired, never a fabricated value', () => {
  assert.equal(c.isGAP(1), null);
  assert.equal(c.lunarWindow('2026-03-31'), null);
});

// Quick stress test for cdp-server-patch-v21.js
'use strict';
const { predict, daysExclLeap, CANDIDATES } = require('./cdp-server-patch-v21');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok?'PASS':'FAIL') + ' ' + name + (ok?'':' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)));
  ok ? pass++ : fail++;
}

// 1. Canonical anchor self-consistency
const c0 = CANDIDATES[0];   // 8 Jul 2024 = Kin 1
const p0 = predict(c0.anchorDate, c0.anchorKin, '2024-07-08');
check('canonical self: 8 Jul 2024 = Kin 1', p0.kin, 1);

// 2. Day after canonical
check('canonical: 9 Jul 2024 = Kin 2',
  predict(c0.anchorDate, c0.anchorKin, '2024-07-09').kin, 2);

// 3. 18 days after, no leap (no Feb 29 between)
check('canonical: 26 Jul 2024 = Kin 19',
  predict(c0.anchorDate, c0.anchorKin, '2024-07-26').kin, 19);

// 4. Two known points internally consistent
const a = predict(c0.anchorDate, c0.anchorKin, '2025-07-08');
const b = predict('2024-07-08', 1, '2025-07-08');
check('determinism: same call gives same answer', a.kin, b.kin);

// 5. Crossing Feb 29: 28 Feb 2024 vs 1 Mar 2024 should be exactly 1 day under exclusion rule
//    (Dreamspell skips Feb 29). But our anchor is 8 Jul 2024 so let's use a different test:
//    From 8 Jul 2024 (Kin 1) backward to 8 Jul 2023.
//    Days inclusive: 366 (2024 leap year), exclude 1 Feb 29: 365 days
//    Going backward 365 days mod 260 = 105 backward, so kin = 1 - 105 mod 260 + 1 = (1 - 1 - 105) mod 260 + 1
//    = -105 mod 260 + 1 = 155 + 1 = 156
const back = predict(c0.anchorDate, c0.anchorKin, '2023-07-08');
check('canonical: 8 Jul 2023 = Kin 156', back.kin, 156);

// 6. days_excl_leap signed correctness
check('days fwd', daysExclLeap(new Date('2024-07-08T12:00:00Z'), new Date('2024-07-09T12:00:00Z')), 1);
check('days bwd', daysExclLeap(new Date('2024-07-08T12:00:00Z'), new Date('2024-07-07T12:00:00Z')), -1);

// 7. Server's claimed match: 4 May 2026 under server anchor
const serverAnchor = CANDIDATES[1];
const sk = predict(serverAnchor.anchorDate, serverAnchor.anchorKin, '2026-05-04');
check("server's anchor: 4 May 2026 produces some Kin (sanity)", sk.kin > 0 && sk.kin <= 260, true);

// 8. Confirm seal mapping
check('Kin 1 is Red Magnetic Dragon',
  predict(c0.anchorDate, c0.anchorKin, '2024-07-08').full,
  'Kin 1 Red Magnetic Dragon');

// 9. Confirm Kin 144 mapping (server anchor's kin)
check('Kin 144 is Yellow Magnetic Seed',
  predict(serverAnchor.anchorDate, serverAnchor.anchorKin, '2024-07-26').full,
  'Kin 144 Yellow Magnetic Seed');

console.log('\n' + pass + '/' + (pass+fail) + ' passing');
process.exit(fail ? 1 : 0);

'use strict';
const c = require('./coordinates-core.cjs');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  got=' + JSON.stringify(got) + (ok ? '' : ' want=' + JSON.stringify(want)));
  ok ? pass++ : fail++;
}

// Kin anchor and corrected values
eq('anchor 2024-07-08 = Kin 1', c.kinForDate('2024-07-08'), 1);
eq('2026-03-31 = Kin 112 (off-by-60 fixed)', c.kinForDate('2026-03-31'), 112);
eq('Ned 1958-06-15 = Kin 68 (not profile 51)', c.kinForDate('1958-06-15'), 68);
eq('leap edge 2024-02-28 = Kin 131', c.kinForDate('2024-02-28'), 131);
eq('leap edge 2024-03-01 = Kin 132', c.kinForDate('2024-03-01'), 132);
eq('pre-anchor 2023-01-01 = Kin 228', c.kinForDate('2023-01-01'), 228);

// GAP wired, 52 entries, and Kin 112 is a portal
let gapCount = 0;
for (let k = 1; k <= 260; k++) if (c.isGAP(k)) gapCount++;
eq('GAP set size = 52', gapCount, 52);
eq('Kin 112 isGAP = true', c.isGAP(112), true);
eq('Kin 113 isGAP = true', c.isGAP(113), true);
eq('Kin 6 isGAP = false', c.isGAP(6), false);

// Colour-complete descriptor, composed once, no duplication
eq('descriptor parity 2026-03-31', c.kinDescriptor('2026-03-31').full, 'Kin 112 Galactic Yellow Human');
eq('descriptor parity anchor', c.kinDescriptor('2024-07-08').full, 'Kin 1 Magnetic Red Dragon');
const d = c.kinDescriptor('2024-02-28');
eq('no colour duplication (single colour token)', (d.full.match(/Blue|Red|White|Yellow/g) || []).length, 1);
eq('seal held colourless', d.seal.includes('Blue') || d.seal.includes('Red') || d.seal.includes('Yellow') || d.seal.includes('White'), false);

// Universal Day, masters preserved
eq('universalDay 2026-06-01 = 8', c.universalDay('2026-06-01').value, 8);
const masterDay = c.universalDay('2024-11-19'); // 2+0+2+4+1+1+1+9 = 20 -> 2 ; pick a real master below
// find a master universal day to prove preservation
let masterProof = null;
for (let day = 1; day <= 28 && !masterProof; day++) {
  const ds = '2025-09-' + String(day).padStart(2,'0');
  const u = c.universalDay(ds);
  if (u.isMaster) masterProof = { ds, u };
}
eq('a master Universal Day is preserved not reduced', masterProof && masterProof.u.isMaster && masterProof.u.value > 9, true);

// Personal numerology: Ned, any 2026 date -> Personal Year master 22 reducing to 4
const pn = c.personalNumerology('1958-06-15', '2026-06-01');
eq('Ned Personal Year value = 22 (master)', pn.personalYear.value, 22);
eq('Ned Personal Year reducesTo = 4 (matches profile)', pn.personalYear.reducesTo, 4);
eq('Ned Personal Year isMaster = true', pn.personalYear.isMaster, true);

// Aggregator shape and honest lunar unknown
const dc = c.dayCoordinates('2026-03-31', { birthDate: '1958-06-15' });
eq('aggregator includes personal layers when birthDate given', dc.coordinates.filter(x=>x.key.startsWith('personal_')).length, 3);
const lunarCoord = dc.coordinates.find(x => x.key === 'lunar');
eq('lunar reported as honest unknown', lunarCoord.unknown, true);
const kinCoord = dc.coordinates.find(x => x.key === 'kin');
eq('kin chip = symbol, claimTag = dreamspell_count', [kinCoord.chip, kinCoord.claimTag], ['symbol','dreamspell_count']);
eq('kin display flags the portal', kinCoord.display.includes('Galactic Activation Portal'), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

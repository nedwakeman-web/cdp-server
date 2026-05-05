// ─────────────────────────────────────────────────────────────────────────────
// CDP Server Patch v21: Kin Anchor Diagnostic
//
// Adds a single read-only endpoint that does NOT change any calculation. It
// returns, for any date, what the LIVE server's getKin() produces alongside
// what each of three candidate anchors would predict. The intent is to give
// Sonia and Ned a one-call instrument to lock in the correct anchor without
// guesswork ,  and to keep doing so over time, since Dreamspell sources
// occasionally publish corrections.
//
// Loading: in server.js, after astroService is initialised and `app` exists:
//
//   require('./cdp-server-patch-v21').register(app, { astroService });
//
// Endpoints added:
//   GET /api/kin/diagnose?date=YYYY-MM-DD
//        Returns { date, server: {kin, seal, tone}, candidates: [...] }
//
//   GET /api/kin/known-tests
//        Runs all hard-coded reference dates and returns pass/fail per anchor.
//
// Author: CDP build, May 2026
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const SEALS = ['Red Dragon','White Wind','Blue Night','Yellow Seed','Red Serpent',
  'White World-Bridger','Blue Hand','Yellow Star','Red Moon','White Dog',
  'Blue Monkey','Yellow Human','Red Skywalker','White Wizard','Blue Eagle',
  'Yellow Warrior','Red Earth','White Mirror','Blue Storm','Yellow Sun'];
const TONES = ['Magnetic','Lunar','Electric','Self-Existing','Overtone','Rhythmic',
  'Resonant','Galactic','Solar','Planetary','Spectral','Crystal','Cosmic'];

// Three candidate anchors observed in the project. Source of each is recorded
// alongside so the live diagnostic produces an auditable answer rather than
// a chosen one.
const CANDIDATES = [
  {
    id: 'fol-starroot',
    label: 'Foundation for the Law of Time / StarRoot',
    anchorDate: '2024-07-08',
    anchorKin:  1,
    citation:   'Argüelles 1987; lawoftime.org; Sonia stated reference per Vol 11.'
  },
  {
    id: 'server-current',
    label: 'Server (current production)',
    anchorDate: '2024-07-26',
    anchorKin:  144,
    citation:   'server.js v32, set May 2026 after a previous correction sweep.'
  },
  {
    id: 'tortuga-1320',
    label: 'Tortuga 1320 (community calculator)',
    anchorDate: '2026-05-05',
    anchorKin:  124,
    citation:   'tortuga.com; non-canonical, included for cross-reference only.'
  }
];

function daysExclLeap(a, b) {
  // Calendar days from a to b (signed), excluding any 29 Feb in the open-closed interval.
  const ms = b - a;
  let n = Math.round(ms / 86400000);
  const lo = n >= 0 ? a : b;
  const hi = n >= 0 ? b : a;
  let leaps = 0;
  for (let y = lo.getUTCFullYear(); y <= hi.getUTCFullYear(); y++) {
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
    if (!isLeap) continue;
    const f = new Date(Date.UTC(y, 1, 29, 12, 0, 0));
    if (f > lo && f <= hi) leaps++;
  }
  return n >= 0 ? n - leaps : n + leaps;
}

function predict(anchorDateStr, anchorKin, targetDateStr) {
  const a = new Date(anchorDateStr + 'T12:00:00Z');
  const t = new Date(targetDateStr + 'T12:00:00Z');
  const d = daysExclLeap(a, t);
  const kin = ((anchorKin - 1 + d) % 260 + 260) % 260 + 1;
  const seal = SEALS[(kin - 1) % 20];
  const tone = TONES[(kin - 1) % 13];
  const colourFromSeal = seal.split(' ')[0];
  return { kin, seal, tone, colour: colourFromSeal, full: `Kin ${kin} ${colourFromSeal} ${tone} ${seal.split(' ').slice(1).join(' ')}` };
}

// Hard-coded reference dates we can validate against. The truth column is the
// canonical Foundation for the Law of Time value. If your project uses a
// different canonical reference, edit this list and re-run /api/kin/known-tests.
const KNOWN_TESTS = [
  { date: '2024-07-08', expectedKin: 1,   note: 'FOL anchor: Red Magnetic Dragon' },
  { date: '2024-07-09', expectedKin: 2,   note: 'Day after FOL anchor: White Lunar Wind' },
  { date: '2025-07-08', expectedKin: 105, note: 'One year after FOL anchor (excl 1 Feb 29 = 364 days, no leap between)' },
  { date: '2025-03-26', expectedKin: 260, note: 'Day before Day Out of Time / Galactic New Year region (verify against your reference)' }
];

function register(app, deps) {
  const astroService = (deps && deps.astroService) || null;

  app.get('/api/kin/diagnose', (req, res) => {
    try {
      const date = String(req.query.date || new Date().toISOString().slice(0,10));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      }
      const out = {
        date,
        server:   null,
        candidates: CANDIDATES.map(c => ({
          id: c.id,
          label: c.label,
          anchor: { date: c.anchorDate, kin: c.anchorKin },
          citation: c.citation,
          predicted: predict(c.anchorDate, c.anchorKin, date)
        })),
        agreement: {}
      };
      if (astroService && typeof astroService.getKin === 'function') {
        try { out.server = astroService.getKin(date); } catch(e) { out.server = { error: e.message }; }
      } else {
        out.server = { error: 'astroService.getKin not exposed' };
      }
      // Note which candidate the server matches (if any)
      if (out.server && out.server.kin) {
        out.agreement = Object.fromEntries(
          out.candidates.map(c => [c.id, c.predicted.kin === out.server.kin])
        );
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/kin/known-tests', (req, res) => {
    try {
      const results = KNOWN_TESTS.map(t => {
        const row = { date: t.date, expectedKin: t.expectedKin, note: t.note };
        if (astroService && typeof astroService.getKin === 'function') {
          try {
            const k = astroService.getKin(t.date);
            row.serverKin = k.kin;
            row.serverSeal = k.seal;
            row.serverTone = k.tone;
            row.serverPass = (k.kin === t.expectedKin);
          } catch (e) {
            row.error = e.message;
            row.serverPass = false;
          }
        }
        for (const c of CANDIDATES) {
          const p = predict(c.anchorDate, c.anchorKin, t.date);
          row[c.id + 'Kin']  = p.kin;
          row[c.id + 'Pass'] = (p.kin === t.expectedKin);
        }
        return row;
      });
      const summary = {
        server:           results.filter(r => r.serverPass).length,
        'fol-starroot':   results.filter(r => r['fol-starrootPass']).length,
        'server-current': results.filter(r => r['server-currentPass']).length,
        'tortuga-1320':   results.filter(r => r['tortuga-1320Pass']).length,
        of: results.length
      };
      res.json({ summary, results, candidates: CANDIDATES });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { register, predict, daysExclLeap, CANDIDATES };

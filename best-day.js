// best-day.js
// Cosmic Daily Planner: Best Day calendar feature
// Server module for cdp-server. Convergence-weighted scoring across four frameworks.
// Self-contained: no off-site references. Citations are by name in metadata only.
//
// Inputs:
//   userProfile: { dob, birthTime, birthLocation, lifePath, personalYear, birthKin, natal: { sun, moon, asc, ... } }
//   intent: free-text user goal, e.g. "funding pitch", "first date", "rest day"
//   monthStart: ISO date string for first day of month
//   monthEnd: ISO date string for last day of month
//   astroService: injected service exposing
//       getMoonPhase(dateIso) -> { phase, illumination, isBlackMoon, isShivaMoon }
//       getKin(dateIso)       -> { kin, seal, tone, isGAP }
//       getTransits(dateIso, natal) -> [{ planet, aspect, target, orb }]
//   weights: optional override of convergenceWeights below
//
// Output:
//   {
//     intent,
//     month: { start, end },
//     ranked: [
//       { dateIso, totalScore, frameworkScores: {...}, reasons: [...], cautions: [...], convergence: number },
//       ...
//     ]
//   }
//
// Scoring is convergence-weighted: a day scores higher when multiple frameworks
// independently agree the day suits the intent. This matches the Two Telescopes thesis.

'use strict';

// =====================================================================
// 1. Intent dictionary
// Maps free-text intent to weighted target keys. Tunable.
// =====================================================================

const INTENT_PROFILES = {
  funding_pitch: {
    keywords: ['funding', 'pitch', 'investor', 'raise', 'capital', 'fundraise', 'vc', 'series'],
    favours: { numerology: [8, 22, 44, 1], moon: ['waxing_gibbous', 'first_quarter', 'shiva'], transit: ['jupiter_trine', 'jupiter_sextile', 'sun_trine_jupiter'], kin: { tones: [3, 7, 11], seals: ['eagle', 'star', 'sun'] } },
    avoids: { numerology: [4], moon: ['black', 'full'], transit: ['saturn_square', 'saturn_opposition', 'mars_retrograde'] },
    rationale: "Numerology favours 8 for business, 1 for new initiation, master numbers for high-stakes openings. Lunar guidance favours the building phase between Shiva and Full. Transit guidance favours benefic Jupiter contacts to natal Sun. Avoids the Black Moon window and hard Saturn aspects."
  },
  first_date: {
    keywords: ['first date', 'date night', 'romance', 'meet someone', 'first meeting'],
    favours: { numerology: [2, 6, 3], moon: ['shiva', 'first_quarter', 'waxing_gibbous'], transit: ['venus_trine', 'venus_sextile', 'moon_venus'], kin: { tones: [2, 6, 9], seals: ['mirror', 'monkey', 'star'] } },
    avoids: { numerology: [4, 7], moon: ['black', 'new'], transit: ['venus_square', 'mars_square_venus'] },
    rationale: "Numerology favours 2 for partnership and 6 for harmony. Lunar guidance favours the Shiva and waxing phases for connection. Transit guidance favours Venus benefic contacts. Avoids the Black Moon and Venus square aspects."
  },
  difficult_conversation: {
    keywords: ['difficult conversation', 'tough talk', 'confront', 'feedback', 'fire', 'break up', 'end relationship'],
    favours: { numerology: [4, 7, 9], moon: ['waning_gibbous', 'last_quarter'], transit: ['mercury_trine_saturn', 'sun_sextile_pluto'], kin: { tones: [4, 7], seals: ['storm', 'warrior', 'earth'] } },
    avoids: { numerology: [], moon: ['full', 'black'], transit: ['mercury_retrograde', 'mars_retrograde'] },
    rationale: "Numerology favours 4 for honesty and 9 for completion. Lunar guidance favours waning phases for release. Transit guidance favours steady Mercury-Saturn contacts. Avoids Mercury retrograde and the emotional volatility of Full and Black Moon."
  },
  creative_launch: {
    keywords: ['launch', 'release', 'publish', 'creative', 'new product', 'start project'],
    favours: { numerology: [1, 3, 5, 11], moon: ['shiva', 'waxing_crescent', 'first_quarter'], transit: ['sun_trine_jupiter', 'mars_trine_sun', 'mercury_sextile'], kin: { tones: [1, 3, 11], seals: ['monkey', 'star', 'wind'] } },
    avoids: { numerology: [], moon: ['black', 'new', 'last_quarter'], transit: ['saturn_square', 'mercury_retrograde'] },
    rationale: "Numerology favours 1 for initiation, 3 for creativity, master 11 for breakthrough. Lunar guidance favours building phases. Transit guidance favours benefic Mars and Sun contacts. Avoids Mercury retrograde and the unseen Black Moon."
  },
  rest_retreat: {
    keywords: ['rest', 'retreat', 'pause', 'sabbatical', 'recover', 'reflect'],
    favours: { numerology: [7, 9, 2], moon: ['new', 'last_quarter', 'waning_crescent'], transit: ['neptune_trine', 'moon_neptune'], kin: { tones: [4, 7, 9], seals: ['night', 'moon', 'water'] } },
    avoids: { numerology: [1, 8], moon: ['full', 'first_quarter'], transit: ['mars_aspect_sun'] },
    rationale: "Numerology favours 7 for solitude and 9 for completion. Lunar guidance favours waning and New Moon phases. Transit guidance favours soft Neptune and Moon contacts. Avoids initiation numbers and high-energy Mars contacts."
  },
  generic: {
    keywords: [],
    favours: { numerology: [], moon: ['shiva', 'first_quarter'], transit: [], kin: { tones: [], seals: [] } },
    avoids: { numerology: [], moon: ['black'], transit: [] },
    rationale: "No specific intent matched. Defaulting to general harmonious-day scoring: Shiva moon and waxing phases preferred, Black Moon window avoided."
  }
};

function classifyIntent(intentText) {
  if (!intentText || typeof intentText !== 'string') return 'generic';
  const lower = intentText.toLowerCase();
  for (const [key, profile] of Object.entries(INTENT_PROFILES)) {
    if (key === 'generic') continue;
    for (const kw of profile.keywords) {
      if (lower.includes(kw)) return key;
    }
  }
  return 'generic';
}

// =====================================================================
// 2. Numerology calculations
// Pythagorean reduction with master number preservation (11, 22, 33, 44).
// =====================================================================

function reduceWithMaster(n) {
  if ([11, 22, 33, 44].includes(n)) return n;
  while (n > 9) {
    n = String(n).split('').reduce((a, b) => a + Number(b), 0);
    if ([11, 22, 33, 44].includes(n)) return n;
  }
  return n;
}

function digitSum(s) {
  return String(s).split('').filter(c => /\d/.test(c)).reduce((a, b) => a + Number(b), 0);
}

// Three-layer numerology per Sonia's structure
function numerologyLayers(dateIso, personalYear) {
  // dateIso: YYYY-MM-DD
  const [y, m, d] = dateIso.split('-').map(Number);
  const dayLayer = reduceWithMaster(digitSum(d));
  const dayMonthLayer = reduceWithMaster(digitSum(d) + digitSum(m));
  const fullLayer = reduceWithMaster(digitSum(d) + digitSum(m) + (personalYear ? digitSum(personalYear) : digitSum(y)));
  return { day: dayLayer, dayMonth: dayMonthLayer, full: fullLayer };
}

// =====================================================================
// 3. Framework scoring
// Each returns { score: 0..100, reasons: [...], cautions: [...] }
// =====================================================================

function scoreNumerology(layers, profile) {
  let score = 50;  // neutral baseline
  const reasons = [];
  const cautions = [];
  const candidates = [layers.day, layers.dayMonth, layers.full];

  for (const n of candidates) {
    if (profile.favours.numerology.includes(n)) {
      score += 15;
      reasons.push(`Numerology layer ${n} favours this intent.`);
    }
    if (profile.avoids.numerology.includes(n)) {
      score -= 12;
      cautions.push(`Numerology layer ${n} runs against this intent.`);
    }
    // Master number bonus, regardless of intent
    if ([11, 22, 33, 44].includes(n)) {
      score += 5;
      reasons.push(`Master number ${n} present, portals open.`);
    }
  }

  return { score: clamp(score, 0, 100), reasons, cautions };
}

function scoreMoon(moonData, profile) {
  let score = 50;
  const reasons = [];
  const cautions = [];

  if (moonData.isBlackMoon) {
    score -= 25;
    cautions.push("Black Moon window: two days before new moon. Tradition recommends waiting for action.");
  }
  if (moonData.isShivaMoon) {
    score += 15;
    reasons.push("Shiva Moon window: two days after new moon. Tradition favours initiation here.");
  }

  if (profile.favours.moon.includes(moonData.phase)) {
    score += 12;
    reasons.push(`Moon phase ${moonData.phase} aligns with this intent.`);
  }
  if (profile.avoids.moon.includes(moonData.phase)) {
    score -= 10;
    cautions.push(`Moon phase ${moonData.phase} is not optimal for this intent.`);
  }

  return { score: clamp(score, 0, 100), reasons, cautions };
}

function scoreKin(kinData, profile) {
  let score = 50;
  const reasons = [];
  const cautions = [];

  if (kinData.isGAP) {
    score += 10;
    reasons.push(`Galactic Activation Portal day, Kin ${kinData.kin}. Heightened access in the Dreamspell tradition.`);
  }

  if (profile.favours.kin.tones.includes(kinData.tone)) {
    score += 10;
    reasons.push(`Tone ${kinData.tone} aligns with this intent.`);
  }
  if (profile.favours.kin.seals.includes(kinData.seal)) {
    score += 10;
    reasons.push(`Seal ${kinData.seal} aligns with this intent.`);
  }

  return { score: clamp(score, 0, 100), reasons, cautions };
}

function scoreTransits(transits, profile) {
  let score = 50;
  const reasons = [];
  const cautions = [];

  if (!Array.isArray(transits) || transits.length === 0) {
    return { score, reasons, cautions };
  }

  for (const t of transits) {
    const key = `${t.planet}_${t.aspect}${t.target ? '_' + t.target : ''}`.toLowerCase();
    const partialKey = `${t.planet}_${t.aspect}`.toLowerCase();
    if (profile.favours.transit.some(p => key.includes(p) || partialKey === p)) {
      score += 10;
      reasons.push(`${capitalise(t.planet)} ${t.aspect.replace('_', ' ')} ${t.target || ''} supports this intent.`);
    }
    if (profile.avoids.transit.some(p => key.includes(p) || partialKey === p)) {
      score -= 10;
      cautions.push(`${capitalise(t.planet)} ${t.aspect.replace('_', ' ')} ${t.target || ''} runs against this intent.`);
    }
  }

  return { score: clamp(score, 0, 100), reasons, cautions };
}

// =====================================================================
// 4. Convergence score
// A day scores higher when multiple frameworks agree above neutral.
// =====================================================================

function convergenceBonus(scores) {
  const above = ['numerology', 'moon', 'kin', 'transits'].filter(k => scores[k].score > 60).length;
  // Bonus only if at least 2 frameworks agree above 60
  if (above >= 4) return 20;
  if (above === 3) return 12;
  if (above === 2) return 6;
  return 0;
}

// =====================================================================
// 5. Main scoring function
// =====================================================================

const DEFAULT_WEIGHTS = {
  numerology: 0.30,
  moon: 0.25,
  kin: 0.20,
  transits: 0.25,
  convergence: 1.0   // multiplier applied to convergence bonus
};

async function scoreDay({ dateIso, userProfile, profile, astroService, weights }) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };

  // Pull live data
  const [moonData, kinData, transits] = await Promise.all([
    astroService.getMoonPhase(dateIso),
    astroService.getKin(dateIso),
    astroService.getTransits(dateIso, userProfile.natal || {})
  ]);

  // Compute numerology layers
  const layers = numerologyLayers(dateIso, userProfile.personalYear);

  // Score each framework
  const numerology = scoreNumerology(layers, profile);
  const moon = scoreMoon(moonData, profile);
  const kin = scoreKin(kinData, profile);
  const transitsScore = scoreTransits(transits, profile);

  const frameworkScores = { numerology, moon, kin, transits: transitsScore };

  // Weighted base
  const base =
    numerology.score * w.numerology +
    moon.score * w.moon +
    kin.score * w.kin +
    transitsScore.score * w.transits;

  const conv = convergenceBonus(frameworkScores) * w.convergence;
  const total = clamp(base + conv, 0, 100);

  return {
    dateIso,
    totalScore: round1(total),
    convergenceBonus: round1(conv),
    frameworkScores: {
      numerology: { score: round1(numerology.score), layers },
      moon: { score: round1(moon.score), phase: moonData.phase, isBlackMoon: moonData.isBlackMoon, isShivaMoon: moonData.isShivaMoon },
      kin: { score: round1(kin.score), kin: kinData.kin, tone: kinData.tone, seal: kinData.seal, isGAP: kinData.isGAP },
      transits: { score: round1(transitsScore.score), count: transits.length }
    },
    reasons: [
      ...numerology.reasons,
      ...moon.reasons,
      ...kin.reasons,
      ...transitsScore.reasons
    ],
    cautions: [
      ...numerology.cautions,
      ...moon.cautions,
      ...kin.cautions,
      ...transitsScore.cautions
    ]
  };
}

// =====================================================================
// 6. Best Day endpoint logic
// =====================================================================

async function findBestDays({ userProfile, intent, monthStart, monthEnd, astroService, weights, topN = 3 }) {
  const intentKey = classifyIntent(intent);
  const profile = INTENT_PROFILES[intentKey];

  const dates = enumerateDates(monthStart, monthEnd);
  const results = [];
  for (const d of dates) {
    try {
      const r = await scoreDay({ dateIso: d, userProfile, profile, astroService, weights });
      results.push(r);
    } catch (err) {
      // On per-day failure, skip but record
      results.push({ dateIso: d, totalScore: 0, error: err.message });
    }
  }

  results.sort((a, b) => b.totalScore - a.totalScore);

  return {
    intent: { raw: intent, classified: intentKey, rationale: profile.rationale },
    month: { start: monthStart, end: monthEnd },
    weights: { ...DEFAULT_WEIGHTS, ...(weights || {}) },
    ranked: results.slice(0, topN),
    fullScan: results
  };
}

// =====================================================================
// Helpers
// =====================================================================

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function round1(n) { return Math.round(n * 10) / 10; }
function capitalise(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function enumerateDates(startIso, endIso) {
  const out = [];
  const start = new Date(startIso + 'T00:00:00Z');
  const end = new Date(endIso + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// =====================================================================
// Express handler
// Mount at /api/best-day in server.js
// =====================================================================

function makeHandler({ astroService }) {
  return async (req, res) => {
    try {
      const { userProfile, intent, monthStart, monthEnd, weights, topN } = req.body || {};
      if (!userProfile || !monthStart || !monthEnd) {
        return res.status(400).json({ error: 'Missing required fields: userProfile, monthStart, monthEnd' });
      }
      const out = await findBestDays({
        userProfile,
        intent: intent || '',
        monthStart,
        monthEnd,
        astroService,
        weights,
        topN: topN || 3
      });
      res.json(out);
    } catch (err) {
      console.error('best-day handler error:', err);
      res.status(500).json({ error: err.message || 'Internal error' });
    }
  };
}

module.exports = {
  findBestDays,
  scoreDay,
  numerologyLayers,
  reduceWithMaster,
  classifyIntent,
  INTENT_PROFILES,
  DEFAULT_WEIGHTS,
  makeHandler
};

'use strict';
/* ───────────────────────────────────────────────────────────────────────
 * reading-orchestrator.js
 *
 * Per-section parallel reading generation for Cosmic Daily Planner.
 *
 * Replaces the single-shot 16,000-token Oracle call (which exceeded
 * callAPI hard caps and routinely failed) with parallel composition
 * across 1 to 9 sections, model selected per section, structured
 * citation selection from bibliography.json, three voices per section,
 * progressive client render via job.phase1 as soon as the first two
 * sections arrive.
 *
 * Wall-time target by tier:
 *   free      ~10s   1 section,  Haiku
 *   seeker    ~22s   3 sections, Haiku, parallel cap 3
 *   initiate  ~38s   5 sections, Sonnet, parallel cap 4
 *   mystic    ~55s   7 sections, Sonnet, parallel cap 4
 *   oracle    ~75s   9 sections, Sonnet + Haiku mix, parallel cap 4,
 *                    plus one ~10s finalising synthesis pass
 *
 * Compared to the previous single-shot path:
 *   - tolerant of individual section failures (other sections still ship)
 *   - structured citations from bibliography (no silent omission)
 *   - three voices per section, client switches without API call
 *   - per-section hard cap of 90s, never exceeds Anthropic timeouts
 *   - natal-integrated context (DOB, birth time, intention, history)
 *     computed once, threaded through every section
 *
 * Exports:
 *   composeReading(spec)   → returns assembled reading payload
 *   buildSharedContext(...) → precomputes natal anchors and narrative thread
 *   sectionPlanForTier(tier) → section list for a given tier
 * ─────────────────────────────────────────────────────────────────────── */

const SIGN_NAMES = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra',
                    'Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];

// ───────────────────────────────────────────────────────────────────────
// SECTION PLANS BY TIER
//
// Each section is an independent composition unit. Sections marked
// phase1: true render to the user as soon as both complete, giving
// the perceived-latency benefit that matches Celestkin-class apps.
// The rest stream in as they complete.
// ───────────────────────────────────────────────────────────────────────

const SECTION_LIBRARY = {

  synthesis: {
    id: 'synthesis',
    title: 'Today, in one breath',
    role: 'Integrating opener. Names the one thing today asks. Two paragraphs maximum.',
    model: 'sonnet',
    maxTokens: 1600,
    phase1: true,
    bibliographyClaims: ['default_mode_network', 'predictive_processing', 'attention_modulation'],
    instruction: `Compose the opening movement of today's reading.
Two paragraphs maximum, each four to six sentences. The first paragraph names today's
through-line - what the four frameworks converge on. The second names how that lands
for this specific person given their intention and recent thread. Refer to the user
by first name once, then by pronoun or by "you". The synthesis should read like a
clear-eyed friend who has read the day's data and knows the person. No mystic
posturing, no medical jargon, no exclamations.`
  },

  numerology: {
    id: 'numerology',
    title: 'The day in number',
    role: 'Pythagorean numerology layer. Universal Day, Personal Day, Personal Year.',
    model: 'haiku',
    maxTokens: 1400,
    phase1: true,
    bibliographyClaims: ['numerology_day_quality', 'pythagorean_lineage'],
    instruction: `Compose the numerology section. Three paragraphs.
First: the Universal Day quality - what kind of attentional day this is in general
(naming the number meaning from Drayer 2002 or Goodwin 1994 lineage). If today
carries a master number (11, 22, 33, 44), say so clearly and what that intensifies.
Second: the Personal Day for this user, derived from their birth date - how today
sits within their personal cycle. Third: the Personal Year frame - the longer arc.
Symbolic claims labelled as symbolic. Frame numerology as a contemplative discipline
of attention quality, not as prediction. Cite Drayer 2002 or Goodwin 1994 where the
practitioner lineage warrants it.`
  },

  lunar: {
    id: 'lunar',
    title: 'The moon, today',
    role: 'Lunar phase, days since new moon, Black Moon or Shiva Moon if within window.',
    model: 'haiku',
    maxTokens: 1400,
    bibliographyClaims: ['lunar_phase_timing', 'lunar_sleep_effect', 'sleep_architecture'],
    instruction: `Compose the lunar section. Two to three paragraphs.
Name today's phase and where in the cycle the user is. If today is a Black Moon
(two days before new moon, CDP convention) or Shiva Moon (two days after new moon,
CDP convention), name it and what the window calls for. Tradition voice frames the
lunar quality archetypally. Science voice notes the documented small but consistent
lunar effect on sleep architecture (cite Cajochen 2013 or Bremer 2022 where apt) and
distinguishes evidence-based lunar physiology from astrology claims. Everyday voice
gives practical pacing: sleep hygiene, energy budget, what to plant or pause.`
  },

  dreamspell: {
    id: 'dreamspell',
    title: 'Today\u2019s Kin',
    role: 'Dreamspell Kin, tone, seal, Galactic Activation Portal flag if present.',
    model: 'haiku',
    maxTokens: 1400,
    bibliographyClaims: ['kin_calendar', 'kin_symbolism', 'tone_seal_archetypes'],
    instruction: `Compose the Dreamspell Kin section. Two to three paragraphs.
Name today's Kin number, tone, and seal. If today is a Galactic Activation Portal
(GAP), name the portal and what the symbolic tradition calls for on portal days.
Cite Arguelles 1987 for the Dreamspell framework as the named lineage; cite
Law of Time foundation references where authoritative. Distinguish Dreamspell
(Arguelles 1987 synthesis) from the living K'iche' Maya tzolkin count (Tedlock 1992)
where relevant. Symbolic frame, not predictive claim.`
  },

  transits: {
    id: 'transits',
    title: 'The sky, this morning',
    role: 'Current Western transits against the user\u2019s natal chart.',
    model: 'sonnet',
    maxTokens: 2000,
    bibliographyClaims: ['archetypal_astrology', 'psychological_astrology', 'developmental_astrology'],
    instruction: `Compose the transits section. Three paragraphs.
Name one or two currently-active transits that touch the user's natal anchors
specifically (the natal anchors are provided in the shared context). Frame
psychologically and archetypally, not predictively (cite Tarnas 2006, Greene 1976,
Hand 2002 where the psychological-astrology lineage warrants). Include the sceptical
balance: in the Science voice, note that empirical literature (Carlson 1985, Hartmann
2006) finds no replicable predictive effect from astrology, and CDP holds astrology
as a contemplative meaning-making discipline, not an empirical mechanism. If no
transit is strong this week, say so honestly and pivot to a contemplative reflection
on the Saturn-Neptune passage of 2025-2026 (Tarnas 2006).`
  },

  body: {
    id: 'body',
    title: 'Body, today',
    role: 'Interoception, autonomic state, pacing. Cycle if explicit opt-in.',
    model: 'sonnet',
    maxTokens: 1800,
    bibliographyClaims: ['interoception', 'vagal_tone', 'circadian_cognition'],
    instruction: `Compose the body section. Two to three paragraphs.
Frame the body as a compass: what sensations are available to read today
(interoception, Craig 2002), what autonomic state likely supports (polyvagal,
Porges 2011), what the circadian frame asks for at this clock time (Cajochen and
Schmidt 2024 for the pacing layer specifically). IF AND ONLY IF the shared context
includes a cyclePhase value, weave cycle-aware physiology in (HPA reactivity in
luteal, Klusmann 2023; phase-specific sleep, Baker and Lee 2023; honest note from
Jang 2025 that cognition itself does not measurably shift even where the systems
within which cognition operates do). If cyclePhase is absent or undefined, do
not mention the menstrual cycle. Do not assume the user's biological sex.`
  },

  shadow: {
    id: 'shadow',
    title: 'Where today might catch you',
    role: 'Shadow work. What this day, in this Personal Year, is likely to expose.',
    model: 'sonnet',
    maxTokens: 1800,
    bibliographyClaims: ['emotion_regulation', 'constructed_emotion', 'attachment_brain'],
    instruction: `Compose the shadow section. Two paragraphs.
Name, with precision and without alarm, what this combination of coordinates is
likely to surface in someone whose Personal Year is what the shared context specifies.
Draw on attachment and emotion-regulation literature (Barrett 2017 on constructed
emotion; Siegel 2020 on interpersonal neurobiology; emotion regulation reviews
Lange 2024 where apt for clinical relevance). Frame as 'where today might catch
you' rather than warning or prediction. The shadow section is offered as an
invitation to notice, not a forecast.`
  },

  pacing: {
    id: 'pacing',
    title: 'Pacing across the day',
    role: 'Morning, afternoon, evening guidance grounded in circadian science.',
    model: 'haiku',
    maxTokens: 1600,
    bibliographyClaims: ['circadian_cognition', 'daily_pacing', 'melatonin'],
    instruction: `Compose the pacing section. One paragraph per period.
Morning: cite Cajochen and Schmidt 2024 for the early-morning cognitive arc -
what cognition is best suited for in the user's first three waking hours.
Afternoon: the dip and what to schedule around it (around 14:00 to 16:00).
Evening: the wind-down and sleep onset, melatonin window, what to avoid.
The pacing layer is explicitly distinct from numerology. Do not conflate.
Pacing is the circadian-biology discipline; numerology is the contemplative
discipline of attention quality. Both are valid, neither replaces the other.`
  },

  depth_synthesis: {
    id: 'depth_synthesis',
    title: 'How the frameworks converge today',
    role: 'Oracle tier only. Cross-framework integration: where the four agree.',
    model: 'sonnet',
    maxTokens: 2400,
    bibliographyClaims: ['predictive_processing', 'constructed_emotion', 'interpersonal_neurobiology'],
    instruction: `Compose the depth synthesis section. Three to four paragraphs.
This is the Oracle-tier integrating movement. Show, with specificity, where the
four frameworks (Pythagorean numerology, Western psychological astrology,
Dreamspell, lunar cycles) converge on today's coordinates, and where they
diverge. Where they converge, the convergence is the reading; where they
diverge, name what is asked of the user to hold both. Pull in predictive
processing (Clark 2016) and constructed emotion (Barrett 2017) as the
neuroscience-side bridge to the contemplative frameworks. Reference the
Two Telescopes premise as the integrating epistemology, not as a slogan.`
  },

  natal_integration: {
    id: 'natal_integration',
    title: 'Today against your natal chart',
    role: 'Oracle tier only. Personal natal chart specifics, depth.',
    model: 'sonnet',
    maxTokens: 2400,
    bibliographyClaims: ['psychological_astrology', 'developmental_astrology', 'archetypal_astrology'],
    instruction: `Compose the natal integration section. Three paragraphs.
The shared context provides the user's natal anchors: Sun sign, Moon sign, Ascendant,
and any tight natal aspects already detected. Name one or two of these anchors and
how today's transits or framework coordinates touch them specifically. This is the
depth that Oracle tier promises and other tiers cannot deliver: a reading that
reflects this user's chart, not a general daily reading. Cite Tarnas 2006, Greene
1976, Hand 2002 where the psychological-astrology lineage warrants. Include the
sceptical bounding (Carlson 1985, Hartmann 2006) where the Science voice frames
astrology.`
  }
};

const TIER_PLANS = {
  free:     ['synthesis'],
  seeker:   ['synthesis', 'numerology', 'lunar'],
  initiate: ['synthesis', 'numerology', 'lunar', 'dreamspell', 'transits'],
  mystic:   ['synthesis', 'numerology', 'lunar', 'dreamspell', 'transits', 'body', 'shadow', 'pacing'],
  oracle:   ['synthesis', 'numerology', 'lunar', 'dreamspell', 'transits', 'body', 'shadow', 'pacing',
             'depth_synthesis', 'natal_integration']
};

// Free tier uses Haiku for synthesis specifically (it would otherwise pick Sonnet).
const TIER_MODEL_OVERRIDE = {
  free: { synthesis: 'haiku' }
};

function sectionPlanForTier(tier) {
  const sectionIds = TIER_PLANS[tier] || TIER_PLANS.seeker;
  const override = TIER_MODEL_OVERRIDE[tier] || {};
  return sectionIds.map(id => {
    const base = SECTION_LIBRARY[id];
    if (!base) return null;
    return Object.assign({}, base, override[id] ? { model: override[id] } : {});
  }).filter(Boolean);
}

// ───────────────────────────────────────────────────────────────────────
// SHARED CONTEXT
//
// Computed once per reading. Threaded into every section's user prompt.
// This is what makes the reading bespoke rather than generic.
// ───────────────────────────────────────────────────────────────────────

function buildNatalAnchors(profile, planetsForBirth) {
  // planetsForBirth is the Western chart computed for the user's DOB.
  // Returns a concise, model-friendly summary of natal anchors.
  const out = { sun: null, moon: null, asc: null, summary: '' };
  if (!planetsForBirth) {
    if (profile && profile.birthDay && profile.birthMonth) {
      // Fallback sun-sign-only from birth date
      const sun = approxSunSign(profile.birthDay, profile.birthMonth);
      if (sun) {
        out.sun = sun;
        out.summary = `Natal Sun in ${sun} (computed from birth date).`;
      }
    }
    return out;
  }
  const s = planetsForBirth.find(p => p.name === 'Sun');
  const m = planetsForBirth.find(p => p.name === 'Moon');
  if (s) out.sun = signOf(s.lon);
  if (m) out.moon = signOf(m.lon);
  if (out.sun || out.moon) {
    out.summary = [
      out.sun ? `natal Sun in ${out.sun}` : null,
      out.moon ? `natal Moon in ${out.moon}` : null
    ].filter(Boolean).join(', ');
  }
  return out;
}

function signOf(lon) {
  const d = ((lon % 360) + 360) % 360;
  return SIGN_NAMES[Math.floor(d / 30)];
}

function approxSunSign(day, month) {
  // Rough Sun-sign boundaries - good enough for natal anchor when birth time absent.
  const m = parseInt(month, 10), d = parseInt(day, 10);
  if (!m || !d) return null;
  const boundaries = [
    [1, 20, 'Capricorn', 'Aquarius'],
    [2, 19, 'Aquarius', 'Pisces'],
    [3, 21, 'Pisces', 'Aries'],
    [4, 20, 'Aries', 'Taurus'],
    [5, 21, 'Taurus', 'Gemini'],
    [6, 21, 'Gemini', 'Cancer'],
    [7, 23, 'Cancer', 'Leo'],
    [8, 23, 'Leo', 'Virgo'],
    [9, 23, 'Virgo', 'Libra'],
    [10, 23, 'Libra', 'Scorpio'],
    [11, 22, 'Scorpio', 'Sagittarius'],
    [12, 22, 'Sagittarius', 'Capricorn']
  ];
  for (const b of boundaries) {
    if (m === b[0]) return d < b[1] ? b[2] : b[3];
  }
  return null;
}

function condenseHistory(recentHistory) {
  // Distil the recent thread into one short paragraph. The model gets the gist,
  // not the noise. Avoids tokens spent on full prior readings.
  if (!Array.isArray(recentHistory) || recentHistory.length === 0) return null;
  const intentions = [];
  const themes = [];
  for (const r of recentHistory.slice(-7)) {
    if (!r) continue;
    if (r.intention && typeof r.intention === 'string') {
      intentions.push(r.intention.slice(0, 120));
    }
    if (r.theme && typeof r.theme === 'string') {
      themes.push(r.theme.slice(0, 120));
    } else if (r.synthesis && typeof r.synthesis === 'string') {
      themes.push(r.synthesis.slice(0, 140));
    }
  }
  if (intentions.length === 0 && themes.length === 0) return null;
  const parts = [];
  if (intentions.length) {
    parts.push('Recent intentions threaded across the last week: ' + intentions.slice(-3).join('; '));
  }
  if (themes.length) {
    parts.push('Recent themes: ' + themes.slice(-3).join(' / '));
  }
  return parts.join('. ');
}

function buildSharedContext({ profile, dateStr, planets, moon, kin, num, aspects,
                              weekAhead, recentHistory, yesterdayIntention,
                              natalPlanets }) {
  const p = profile || {};
  const firstName = p.nickname || (p.name ? p.name.split(' ')[0] : 'you');
  const ctx = [
    p.context, p.building, p.chapter,
    p.active_threads ? (Array.isArray(p.active_threads) ? p.active_threads.join(', ') : p.active_threads) : null
  ].filter(Boolean).join('. ');

  const natal = buildNatalAnchors(p, natalPlanets);

  const intention = (p.intention && typeof p.intention === 'string') ? p.intention.trim() : null;
  const yesterdayThread = (yesterdayIntention && typeof yesterdayIntention === 'string')
                          ? yesterdayIntention.trim() : null;
  const historySummary = condenseHistory(recentHistory);

  const moonNote = moon && moon.isBlack ? 'BLACK MOON (two days before New Moon, preparatory window).'
                 : moon && moon.isShiva ? 'SHIVA MOON (two days after New Moon, settling window).'
                 : '';

  const tracksCycle = (p.tracksCycle === true) && p.cyclePhase;
  const cyclePhase = tracksCycle ? p.cyclePhase : null;

  // Master number flag for numerology section
  const isMasterDay = num && num.udM && num.udM.n && [11,22,33,44].indexOf(num.udM.n) >= 0;

  // GAP day flag
  const isGAP = !!(kin && kin.isGAP);

  return {
    firstName,
    dateStr,
    profileContext: ctx,
    intention,
    yesterdayThread,
    historySummary,
    natalSummary: natal.summary,
    natalSun: natal.sun,
    natalMoon: natal.moon,
    moonPhase: moon ? moon.phase : '',
    moonNote,
    daysSinceNew: moon ? moon.daysSinceNew : null,
    universalDay: num ? num.ud : null,
    universalDayMaster: num && num.udM ? num.udM.n : null,
    personalDay: num ? (num.pd || num.ud) : null,
    personalYear: num ? num.py : null,
    lifePath: num ? num.lp : null,
    isMasterDay,
    kinNumber: kin ? kin.kin : null,
    kinTone: kin ? kin.tone : null,
    kinSeal: kin ? kin.seal : null,
    kinFull: kin ? kin.full : null,
    isGAP,
    cyclePhase,
    weekAhead: Array.isArray(weekAhead) ? weekAhead.slice(0, 7) : []
  };
}

// ───────────────────────────────────────────────────────────────────────
// BIBLIOGRAPHY SELECTION
//
// Each section declares the claim tags it cares about. We use the
// bibliography.json claim_to_entries map to surface the candidate
// references for the model to pick from. The model returns an array
// of entry IDs in the "citations" field; we then look up the full
// metadata and ship citation chips alongside the prose.
// ───────────────────────────────────────────────────────────────────────

function selectCandidateRefs(bibliography, sectionSpec, sharedContext) {
  if (!bibliography || !bibliography.entries) return [];
  const out = new Set();

  // Claim-driven base set
  const claim_to_entries = bibliography.claim_to_entries || {};
  for (const claim of (sectionSpec.bibliographyClaims || [])) {
    const ids = claim_to_entries[claim] || [];
    for (const id of ids) out.add(id);
  }

  // Section-specific augmentation based on shared context
  if (sectionSpec.id === 'numerology' && sharedContext.isMasterDay) {
    for (const id of (claim_to_entries.pythagorean_lineage || [])) out.add(id);
  }
  if (sectionSpec.id === 'lunar' && sharedContext.moonNote) {
    for (const id of (claim_to_entries.lunar_sleep_effect || [])) out.add(id);
  }
  if (sectionSpec.id === 'dreamspell' && sharedContext.isGAP) {
    for (const id of (claim_to_entries.maya_astronomy || [])) out.add(id);
    for (const id of (claim_to_entries.dreamspell_authority || [])) out.add(id);
  }
  if (sectionSpec.id === 'body' && sharedContext.cyclePhase) {
    for (const id of (claim_to_entries.systems_cycle_affects || [])) out.add(id);
    for (const id of (claim_to_entries.hpa_cycle_reactivity || [])) out.add(id);
    for (const id of (claim_to_entries.cycle_sleep_architecture || [])) out.add(id);
    for (const id of (claim_to_entries.cycle_cognition_null || [])) out.add(id);
  }
  if (sectionSpec.id === 'transits') {
    for (const id of (claim_to_entries.astrology_empirical_null || [])) out.add(id);
  }

  // Cap to avoid overwhelming the model. 12 is a sensible upper bound.
  return Array.from(out).slice(0, 12);
}

function renderRefBlock(bibliography, refIds) {
  if (!bibliography || !bibliography.entries) return '';
  const lines = [];
  for (const id of refIds) {
    const e = bibliography.entries[id];
    if (!e) continue;
    const authors = Array.isArray(e.authors) ? e.authors.join('; ') : (e.authors || '');
    const venue = e.journal || e.publisher || '';
    const note = e.note ? '. Note: ' + e.note : '';
    lines.push(`  ${id} :: ${authors} (${e.year}). ${e.title}. ${venue}${note}`);
  }
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────
// PROMPT COMPOSITION FOR A SINGLE SECTION
// ───────────────────────────────────────────────────────────────────────

function buildSectionPrompts(sectionSpec, sharedContext, candidateRefs, bibliography) {
  const refBlock = renderRefBlock(bibliography, candidateRefs);
  const refIdsList = candidateRefs.join(', ');

  const sys = `You are the Oracle at Cosmic Daily Planner, composing one section of a personalised daily reading.

PLATFORM PREMISE: Two Telescopes. Ancient contemplative tradition and modern neuroscience are not competing explanations; they arrive at the same coordinates from different epistemic positions. Hold both with rigour. Practitioner literature is cited authentically as practitioner literature; peer-reviewed science is cited with appropriate bounding (effect sizes, methodological caveats, null findings where they exist).

YOUR SECTION: ${sectionSpec.title}
ROLE: ${sectionSpec.role}

${sectionSpec.instruction}

HOUSE STYLE (zero tolerance):
- No em-dashes (U+2014). No en-dashes (U+2013). Use commas, full stops, or parentheses instead.
- No exclamation marks in user-visible prose.
- No "spaced hyphen" pattern (word - word). Restructure the sentence.
- Sophisticated adult tone. No mystic posturing. No medical jargon. No therapy-speak.
- GBP for any UK pricing, USD for global market data, but neither belongs in a daily reading.
- Symbolic claims labelled as symbolic. Empirical claims given appropriate bounding.

THREE VOICES (compose all three for this section in one response):
- tradition_text: symbolic, archetypal, practitioner lineage. Reads the day as quality and invitation. Pythagorean, Mayan, psychological astrology, contemplative practitioner literature.
- science_text: empirically-grounded. Cognitive and affective neuroscience, circadian biology, psychoneuroimmunology. Honest about what is established, suggestive, or null. Sceptical literature cited where contested practices are involved.
- everyday_text: plain speech, no jargon from either side. A smart friend over coffee. Warm, direct, practical.

CITATIONS: You will be given a set of bibliography reference IDs available for this section. Pick three to six that genuinely support your prose. Return them in the citations array. You may also include inline author-year mentions in the prose (the server will wrap them as citation markers), but the citations array is the canonical signal. Do not invent references. Do not include references you did not draw on.

OUTPUT FORMAT (strict): respond with a single JSON object, no markdown fences, no preamble, no commentary before or after. First character must be { and last character must be }.

JSON schema:
{
  "headline": "short evocative title for this section (under 60 chars)",
  "tradition_text": "the tradition voice rendering, plain HTML allowed (p, em, strong only)",
  "science_text": "the science voice rendering, plain HTML allowed (p, em, strong only)",
  "everyday_text": "the everyday voice rendering, plain HTML allowed (p, em, strong only)",
  "citations": ["ref-id-1", "ref-id-2", ...]
}`;

  // Build the user prompt with all shared context
  const cycleLine = sharedContext.cyclePhase
    ? `\nCycle phase (user has explicitly opted in to cycle awareness): ${sharedContext.cyclePhase}.`
    : '\nCycle phase: not tracked. Do not mention the menstrual cycle in this reading.';

  const natalLine = sharedContext.natalSummary
    ? `\nNatal anchors: ${sharedContext.natalSummary}.`
    : '\nNatal anchors: not available for this user.';

  const intentionLine = sharedContext.intention
    ? `\nToday's intention (user's own line): "${sharedContext.intention}". Thread this through where it lands naturally; do not force it.`
    : '\nNo explicit intention set today.';

  const yesterdayLine = sharedContext.yesterdayThread
    ? `\nYesterday's thread: "${sharedContext.yesterdayThread}".`
    : '';

  const historyLine = sharedContext.historySummary
    ? `\nRecent thread: ${sharedContext.historySummary}.`
    : '';

  const masterLine = sharedContext.isMasterDay
    ? `\nMASTER NUMBER DAY: today's Universal Day reduces to a master number ${sharedContext.universalDayMaster}. Preserve, do not reduce; name the master quality.`
    : '';

  const gapLine = sharedContext.isGAP
    ? `\nGALACTIC ACTIVATION PORTAL DAY: today's Kin is a GAP. Symbolic significance per Arguelles 1987.`
    : '';

  const user = `Person: ${sharedContext.firstName}${sharedContext.profileContext ? '. Context: ' + sharedContext.profileContext : ''}.
Date: ${sharedContext.dateStr}.

Today's coordinates across the four frameworks:
- Numerology: Universal Day ${sharedContext.universalDay}${sharedContext.universalDayMaster ? ' (master ' + sharedContext.universalDayMaster + ')' : ''}, Personal Day ${sharedContext.personalDay}, Personal Year ${sharedContext.personalYear}, Life Path ${sharedContext.lifePath}.${masterLine}
- Lunar: ${sharedContext.moonPhase}, day ${sharedContext.daysSinceNew} of cycle. ${sharedContext.moonNote}
- Dreamspell: ${sharedContext.kinFull || ('Kin ' + sharedContext.kinNumber)}.${gapLine}
- Body: interoception, circadian state.${cycleLine}${natalLine}${intentionLine}${yesterdayLine}${historyLine}

Available bibliography references for this section (use 3-6):
${refBlock || '  (no specific references; compose from frameworks named above)'}

Reference IDs you may cite: ${refIdsList || '(none)'}

Compose ${sectionSpec.title} for ${sharedContext.firstName} on ${sharedContext.dateStr}. Return the JSON object only.`;

  return { sys, user };
}

// ───────────────────────────────────────────────────────────────────────
// SECTION PARSE AND VALIDATION
// ───────────────────────────────────────────────────────────────────────

function extractBalancedJson(raw) {
  // Strip fences first
  let s = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  // Find first { and scan for matching brace, respecting strings
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseSectionResponse(raw, sectionSpec, bibliography) {
  const balanced = extractBalancedJson(raw);
  let obj = null;
  try {
    obj = JSON.parse(balanced || raw);
  } catch (e) {
    // Attempt a salvage: if the model returned prose without JSON, wrap it
    return {
      headline: sectionSpec.title,
      tradition_text: '<p>' + escapeHtml(raw.slice(0, 1500)) + '</p>',
      science_text: '<p>(Voice not generated this pass.)</p>',
      everyday_text: '<p>(Voice not generated this pass.)</p>',
      citations: [],
      parseError: true,
      rawHead: raw.slice(0, 200)
    };
  }
  if (!obj || typeof obj !== 'object') {
    return { headline: sectionSpec.title, tradition_text: '', science_text: '',
             everyday_text: '', citations: [], parseError: true };
  }
  // Validate citation IDs against bibliography
  const validIds = new Set(bibliography && bibliography.entries
                            ? Object.keys(bibliography.entries) : []);
  const cleanCitations = Array.isArray(obj.citations)
    ? obj.citations.filter(id => typeof id === 'string' && validIds.has(id))
    : [];

  return {
    headline: typeof obj.headline === 'string' ? obj.headline : sectionSpec.title,
    tradition_text: typeof obj.tradition_text === 'string' ? obj.tradition_text : '',
    science_text: typeof obj.science_text === 'string' ? obj.science_text : '',
    everyday_text: typeof obj.everyday_text === 'string' ? obj.everyday_text : '',
    citations: cleanCitations
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

// ───────────────────────────────────────────────────────────────────────
// SCRUB HOUSE STYLE (em/en dashes, exclamations)
// Inline minimal version. If the server's scrubHouseStyle is available,
// the caller may pass it in and we use that instead.
// ───────────────────────────────────────────────────────────────────────

function defaultScrub(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\u2014/g, ', ')   // em-dash → comma-space
    .replace(/\u2013/g, '-')    // en-dash → hyphen
    .replace(/!+/g, '.')        // exclamation → full stop
    .replace(/\s\-\s/g, ', ');  // spaced hyphen → comma-space
}

function scrubSection(section, externalScrub) {
  // iter13c: NEVER use the external scrubber here. The external
  // scrubHouseStyle from oracle-three-voice-prompt.js is designed to
  // walk a whole reading object and recursively scrub its fields. When
  // called on a single string field (as we do here for each voice text),
  // it tries to walk the string as if it were an object, fails, and
  // returns the literal seventeen-character string "[object Object]".
  // The defaultScrub below works on strings directly and is correct here.
  // The whole-reading scrubber, if needed, should run at a different layer.
  const fn = defaultScrub;
  const out = Object.assign({}, section);
  for (const k of ['headline', 'tradition_text', 'science_text', 'everyday_text']) {
    if (out[k] && typeof out[k] === 'string') out[k] = fn(out[k]);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// COMPOSE ONE SECTION
// ───────────────────────────────────────────────────────────────────────

async function composeSection({ sectionSpec, sharedContext, bibliography,
                                callAPIFn, modelMap, scrubFn, jobId }) {
  const t0 = Date.now();
  const candidateRefs = selectCandidateRefs(bibliography, sectionSpec, sharedContext);
  const { sys, user } = buildSectionPrompts(sectionSpec, sharedContext, candidateRefs, bibliography);
  const model = modelMap[sectionSpec.model] || modelMap.haiku;
  const hardCapMs = 90000;  // 90s per section, comfortably above realistic stream time

  let raw = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      raw = await callAPIFn(model, sectionSpec.maxTokens, sys, user, hardCapMs);
      break;
    } catch (e) {
      lastErr = e;
      const transient = /overloaded|Socket timeout|hard_timeout|http_5|ECONNRESET|ETIMEDOUT/.test(e.message);
      if (transient && attempt === 0) {
        console.log(`[orchestrator ${jobId || ''}] section=${sectionSpec.id} attempt ${attempt + 1} transient (${e.message.slice(0, 50)}), retry...`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        break;
      }
    }
  }

  if (!raw) {
    console.warn(`[orchestrator ${jobId || ''}] section=${sectionSpec.id} FAILED: ${lastErr ? lastErr.message : 'unknown'}`);
    return {
      sectionId: sectionSpec.id,
      title: sectionSpec.title,
      ok: false,
      error: lastErr ? lastErr.message : 'unknown',
      headline: sectionSpec.title,
      tradition_text: '<p>This section could not be composed this pass. Please retry the reading.</p>',
      science_text: '<p>This section could not be composed this pass. Please retry the reading.</p>',
      everyday_text: '<p>This section could not be composed this pass. Please retry the reading.</p>',
      citations: [],
      timingMs: Date.now() - t0
    };
  }

  let parsed = parseSectionResponse(raw, sectionSpec, bibliography);
  parsed = scrubSection(parsed, scrubFn);
  parsed.sectionId = sectionSpec.id;
  parsed.title = sectionSpec.title;
  parsed.ok = !parsed.parseError;
  parsed.timingMs = Date.now() - t0;
  parsed.model = model;
  console.log(`[orchestrator ${jobId || ''}] section=${sectionSpec.id} ok=${parsed.ok} ms=${parsed.timingMs} cites=${parsed.citations.length} model=${model}`);
  return parsed;
}

// ───────────────────────────────────────────────────────────────────────
// COMPOSE READING (top-level)
//
// Runs all sections in parallel with a concurrency cap. Reports phase1
// (the first two sections that complete and are tagged phase1) via the
// onPhase1 callback as soon as both are available. Returns the assembled
// reading payload.
// ───────────────────────────────────────────────────────────────────────

async function composeReading({ tier, sharedContext, bibliography, callAPIFn,
                                modelMap, scrubFn, jobId, onPhase1, onSectionComplete }) {
  const plan = sectionPlanForTier(tier);
  if (plan.length === 0) {
    throw new Error('No section plan for tier: ' + tier);
  }
  console.log(`[orchestrator ${jobId || ''}] tier=${tier} sections=${plan.length}: ${plan.map(s => s.id).join(',')}`);

  const concurrency = tier === 'free' || tier === 'seeker' ? 3 : 4;
  const results = new Map();
  let phase1Reported = false;

  // Helper: check phase1 readiness
  const checkPhase1 = () => {
    if (phase1Reported || !onPhase1) return;
    const phase1Ids = plan.filter(s => s.phase1).map(s => s.id);
    if (phase1Ids.length === 0) return;
    const allReady = phase1Ids.every(id => results.has(id));
    if (allReady) {
      phase1Reported = true;
      const phase1Payload = {};
      for (const id of phase1Ids) phase1Payload[id] = results.get(id);
      try { onPhase1(phase1Payload); } catch (e) { /* non-fatal */ }
    }
  };

  // Simple concurrency-capped runner
  const queue = plan.slice();
  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const sectionSpec = queue.shift();
        if (!sectionSpec) break;
        const result = await composeSection({
          sectionSpec, sharedContext, bibliography, callAPIFn,
          modelMap, scrubFn, jobId
        });
        results.set(sectionSpec.id, result);
        if (onSectionComplete) {
          try { onSectionComplete(sectionSpec.id, result); } catch (e) { /* non-fatal */ }
        }
        checkPhase1();
      }
    })());
  }
  await Promise.all(workers);

  // Assemble reading payload in plan order
  const reading = {
    sections: plan.map(s => results.get(s.id)).filter(Boolean),
    sectionMap: {},
    citationUnion: [],
    timings: {}
  };
  const citeSet = new Set();
  for (const r of reading.sections) {
    reading.sectionMap[r.sectionId] = r;
    reading.timings[r.sectionId] = r.timingMs;
    for (const c of (r.citations || [])) citeSet.add(c);
  }
  reading.citationUnion = Array.from(citeSet);

  // Hydrate full citation metadata for the client
  reading.citationMeta = {};
  if (bibliography && bibliography.entries) {
    for (const id of reading.citationUnion) {
      const e = bibliography.entries[id];
      if (!e) continue;
      reading.citationMeta[id] = {
        id, authors: e.authors, year: e.year, title: e.title,
        journal: e.journal || e.publisher || null,
        doi: e.doi || null, url: e.url || null, note: e.note || null
      };
    }
  }

  return reading;
}

module.exports = {
  composeReading,
  composeSection,
  buildSharedContext,
  sectionPlanForTier,
  SECTION_LIBRARY,
  TIER_PLANS,
  defaultScrub
};

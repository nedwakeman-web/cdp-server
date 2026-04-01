/**
 * COSMIC DAILY PLANNER — Production Server
 * Railway deployment · Express · Anthropic API
 * Scholarly refs: Aldana 2022, Šprajc 2023, Tarnas 2006, Greene 1976, Drayer 2002
 */

const express = require('express');
const https   = require('https');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* ═════════════════════════════════════════════════════════
   EPHEMERIS — Simplified planetary positions
   Reference: March 31, 2026 0h UTC (verified from reading output)
   Sources: JPL Horizons, Swiss Ephemeris (www.astro.com/swisseph/)
═════════════════════════════════════════════════════════ */

const REF_DATE = new Date(Date.UTC(2026, 2, 31, 0, 0, 0)); // March 31 2026
const REF_JD   = 2461126.5;

// Ecliptic longitudes at reference (degrees, 0=0°Aries)
const REF_LON = {
  sun:     10.5,   // 11° Aries
  mercury: 354.2,  // 24° Pisces
  venus:   66.8,   // 7° Gemini
  mars:    13.4,   // 13° Aries
  jupiter: 107.3,  // 17° Cancer
  saturn:  2.0,    // 2° Aries
  uranus:  57.8,   // 28° Taurus
  neptune: 1.0,    // 1° Aries
  pluto:   305.0   // 5° Aquarius
};

// Mean daily motion (degrees/day) — approximate
const DAILY_MOTION = {
  sun:     0.9856, mercury: 1.20,  venus:   1.20,
  mars:    0.524,  jupiter: 0.083, saturn:  0.034,
  uranus:  0.011,  neptune: 0.006, pluto:   0.004
};

const SIGNS = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
               'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];

function lonToSign(lon) {
  const l = ((lon % 360) + 360) % 360;
  const si = Math.floor(l / 30);
  const deg = Math.round(l % 30);
  return { sign: SIGNS[si], degree: deg === 0 ? 1 : deg, lon: l };
}

function getPlanetPositions(date) {
  const msPerDay = 86400000;
  const delta = (date - REF_DATE) / msPerDay;
  const pos = {};
  for (const p of Object.keys(REF_LON)) {
    pos[p] = lonToSign(REF_LON[p] + DAILY_MOTION[p] * delta);
  }
  // Moon from phase calculation
  const moonAge  = getMoonAge(date);
  const sunLon   = pos.sun.lon;
  // Moon starts near sun at new moon, moves ~13.18°/day
  const newMoonLon = sunLon - (moonAge * 13.176 % 360);
  const moonLon = ((newMoonLon + moonAge * 13.176) % 360 + 360) % 360;
  pos.moon = lonToSign(moonLon);
  // Add moon phase info
  pos.moon.phase     = getMoonPhaseKey(date);
  pos.moon.phaseName = MOON_PHASE_NAMES[pos.moon.phase];
  pos.moon.age       = moonAge.toFixed(1);
  return pos;
}

/* Moon Phase ─────────────────────────────────────────── */
const MOON_ANCHOR   = new Date(Date.UTC(2000, 0, 6, 18, 14, 0));
const LUNAR_CYCLE   = 29.530588853;
const MOON_PHASE_NAMES = {
  new_moon:'New Moon', black_moon:'Black Moon', shiva_moon:'Shiva Moon',
  waxing_crescent:'Waxing Crescent', first_quarter:'First Quarter',
  waxing_gibbous:'Waxing Gibbous', full_moon:'Full Moon',
  waning_gibbous:'Waning Gibbous', last_quarter:'Last Quarter',
  waning_crescent:'Waning Crescent'
};

function getMoonAge(date) {
  const diff = (date - MOON_ANCHOR) / 86400000;
  let age = diff % LUNAR_CYCLE;
  return age < 0 ? age + LUNAR_CYCLE : age;
}

function getMoonPhaseKey(date) {
  const a = getMoonAge(date);
  if (a < 1.5)   return 'new_moon';
  if (a < 3.5)   return 'shiva_moon';      // 2 days post new moon — blissful
  if (a < 7.38)  return 'waxing_crescent';
  if (a < 9.22)  return 'first_quarter';
  if (a < 14.0)  return 'waxing_gibbous';
  if (a < 16.0)  return 'full_moon';
  if (a < 22.0)  return 'waning_gibbous';
  if (a < 23.85) return 'last_quarter';
  if (a < 27.53) return 'waning_crescent';
  return 'black_moon';  // 2 days pre new moon — tricky
}

/* Dreamspell ─────────────────────────────────────────── */
const DS_ANCHOR     = new Date(2020, 6, 26); // July 26 2020 = Kin 118
const DS_ANCHOR_KIN = 118;
const SEALS_LIST    = ['Dragon','Wind','Night','Seed','Serpent','WorldBridger','Hand','Star',
                       'Moon','Dog','Monkey','Human','Skywalker','Wizard','Eagle','Warrior',
                       'Earth','Mirror','Storm','Sun'];
const SEAL_COLORS   = ['Red','White','Blue','Yellow','Red','White','Blue','Yellow',
                       'Red','White','Blue','Yellow','Red','White','Blue','Yellow',
                       'Red','White','Blue','Yellow'];
const TONES_LIST    = ['Magnetic','Lunar','Electric','Self-Existing','Overtone','Rhythmic',
                       'Resonant','Galactic','Solar','Planetary','Spectral','Crystal','Cosmic'];
const GAP_KINS      = new Set([19,20,22,25,33,37,38,39,40,41,53,55,58,60,65,
                                93,94,95,96,98,100,101,104,107,108,113,116,118,119,
                                131,133,140,143,145,146,147,148,149,150,
                                152,160,162,163,165,168,182,196,211,222,225,227,240]);

function getDreamspellKin(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((d - DS_ANCHOR) / 86400000);
  return ((DS_ANCHOR_KIN - 1 + diff) % 260 + 260) % 260 + 1;
}

function getKinName(kin) {
  const seal  = SEALS_LIST[(kin - 1) % 20];
  const color = SEAL_COLORS[(kin - 1) % 20];
  const tone  = TONES_LIST[(kin - 1) % 13];
  return { kin, name: `${color} ${tone} ${seal}`, tone, seal, color, isGAP: GAP_KINS.has(kin) };
}

/* Numerology ─────────────────────────────────────────── */
function sumDigits(n) {
  return String(Math.abs(n)).split('').reduce((a,c) => a + parseInt(c), 0);
}
function reduceNum(n) {
  let v = n;
  while (v > 9) {
    if ([11,22,33,44].includes(v)) return v;
    v = sumDigits(v);
    if ([11,22,33,44].includes(v)) return v;
  }
  return v;
}
function getUniversalDay(date) {
  const sum = date.getDate() + (date.getMonth()+1) + sumDigits(date.getFullYear());
  return reduceNum(sum);
}
function getPersonalYear(bDay, bMonth, date) {
  return reduceNum(bDay + bMonth + reduceNum(sumDigits(date.getFullYear())));
}
function getLifePath(bDay, bMonth, bYear) {
  return reduceNum(sumDigits(bDay) + sumDigits(bMonth) + sumDigits(bYear));
}

const NUM_NAMES = {
  1:'New Beginnings & Focus', 2:'Partnership & Kindness', 3:'Creativity & Connection',
  4:'Work, Honesty & Integrity', 5:'Learning & Social Intelligence', 6:'Harmony, Art & Family',
  7:'Karmic Gateway & Solitude', 8:'Power, Business & Structure', 9:'Cosmic Completion & Peace',
  11:'Master 11 — Magic & Portal', 22:'Master 22 — The Builder', 33:'Master 33 — The Teacher',
  44:'Master 44 — The Architect'
};

/* Planet note generators ─────────────────────────────── */
function getPlanetNote(name, sign, degree) {
  const notes = {
    sun: `Identity and purpose illuminated in ${sign} — ${sign==='Aries'?'pioneering energy, initiative and raw spring momentum':sign==='Taurus'?'grounded sensuality and persistence':sign==='Gemini'?'intellectual agility and communicative brilliance':'solar focus'}`,
    moon: `Emotional landscape coloured by ${sign} — tracks feelings with ${sign==='Virgo'?'analytical precision':sign==='Gemini'?'quicksilver adaptability':sign==='Cancer'?'deep nurturing instinct':'lunar sensitivity'}`,
    mercury: `Communication and cognition in ${sign} — ${sign==='Pisces'?'still clearing post-shadow fog; contracts need re-reading, not rushing':sign==='Aries'?'sharp, direct, possibly combative; ideal for bold communication':sign==='Taurus'?'methodical, reliable, slow to change views':'thinking style'}`,
    venus: `Love, beauty and values in ${sign} — ${sign==='Gemini'?'wit, curiosity and variety; rewards spontaneity and lightness':sign==='Taurus'?'sensual, comfort-seeking; good for pleasure and relationship depth':sign==='Cancer'?'tender, home-oriented; emotional generosity flows freely':'relational energy'}`,
    mars: `Drive and action in ${sign} — ${sign==='Aries'?'double home-sign energy; combustion of will and initiative; watch inflammation and overexertion':sign==='Taurus'?'slow, persistent, immovable; excellent for long-term building':sign==='Gemini'?'scattered but versatile; multi-directional energy':'physical drive'}`,
    jupiter: `Expansion and opportunity in ${sign} — ${sign==='Cancer'?'emotional abundance and family security; Jupiter here expands home, protection, nurturing':sign==='Leo'?'radiant generosity and creative flourishing':sign==='Gemini'?'expansion through communication and learning':'growth arena'}`,
    saturn: `Structure and discipline in ${sign} — ${sign==='Aries'?'demands disciplined new starts; Saturn in Aries insists structures actually hold, not just sprint':sign==='Pisces'?'dissolving old structures; reality-checking dreams':'where life demands accountability'}`,
    uranus: `Innovation and disruption in ${sign} — ${sign==='Taurus'?'financial and material structures being revolutionised; Gemini ingress approaching, accelerating change':sign==='Gemini'?'technological and communicative disruption at peak':'where the unexpected arrives'}`,
    neptune: `Vision and dissolution in ${sign} — ${sign==='Aries'?'dissolving ego-driven ambition; paired with Saturn, asks what is genuine vision versus martyrdom by overwork':sign==='Pisces'?'at home; mystical, compassionate, boundary-dissolving':'where fog and inspiration meet'}`,
    pluto: `Transformation in ${sign} — ${sign==='Aquarius'?'systemic transformation of collective structures and leadership paradigms underway; the old order dissolving at civilisational scale':sign==='Capricorn'?'restructuring institutional power':'where deep change is non-negotiable'}`
  };
  return notes[name] || `In ${sign} at ${degree}°`;
}

/* Aspect calculator ──────────────────────────────────── */
function getAspects(positions, profile) {
  const planets = ['sun','moon','mercury','venus','mars','jupiter','saturn','uranus','neptune','pluto'];
  const aspects  = [];

  // Check Saturn-Neptune conjunction (historically significant for 2026)
  const satLon = positions.saturn.lon;
  const nepLon = positions.neptune.lon;
  const satNepOrb = Math.abs(satLon - nepLon);
  if (satNepOrb < 8) {
    aspects.push({
      rating: 5, stars: '●●●●●',
      title: `Saturn ${positions.saturn.degree}° Aries conjunct Neptune ${positions.neptune.degree}° Aries (${satNepOrb.toFixed(1)}° orb)`,
      body: `The most historically significant aspect of the decade. The last time both planets occupied Aries together was approximately 1522 — the year Magellan's crew completed the first circumnavigation of the Earth, the year Martin Luther's Reformation was fracturing European Christendom. Saturn demands form, accountability, and long-term structure; Neptune dissolves boundaries and opens vision. Together in pioneering Aries, they do not call for reform — they call for genesis. For ${profile.name}, this is the structural backdrop of everything being built: the discipline to make the impossible thing real, and the courage to build it as if life depends on it.`,
      significance: 'civilisational'
    });
  }

  // Sun-Mars proximity
  const sunLon = positions.sun.lon;
  const marsLon = positions.mars.lon;
  const smOrb   = Math.abs(sunLon - marsLon);
  if (smOrb < 15) {
    const rating = smOrb < 5 ? 5 : smOrb < 8 ? 4 : 3;
    aspects.push({
      rating, stars: '●'.repeat(rating) + '○'.repeat(5-rating),
      title: `Sun ${positions.sun.degree}° ${positions.sun.sign} conjunct Mars ${positions.mars.degree}° ${positions.mars.sign} (${smOrb.toFixed(1)}° orb)`,
      body: `Will and drive are fused today. This supercharges momentum for decisive action and executive presence — the energy that signs term sheets, persuades investors, and refuses to accept a mediocre outcome. The shadow: Sun-Mars is the engine, not the brake. Without conscious pacing, intensity lands directly in the body. The gift is fierce clarity of purpose; the risk is inflammation, irritability, and skipping the health habits that would sustain the sprint long-term. Use the morning for the single highest-leverage action, then consciously downshift.`
    });
  }

  // Moon-Jupiter
  const moonLon = positions.moon.lon;
  const jupLon  = positions.jupiter.lon;
  const mjOrb   = Math.abs(moonLon - jupLon);
  if (mjOrb < 12) {
    const type = mjOrb < 3 ? 'exact sextile' : 'sextile';
    const rating = mjOrb < 3 ? 5 : 4;
    aspects.push({
      rating, stars: '●'.repeat(rating) + '○'.repeat(5-rating),
      title: `Moon ${positions.moon.degree}° ${positions.moon.sign} ${type} Jupiter ${positions.jupiter.degree}° ${positions.jupiter.sign} (${mjOrb.toFixed(1)}° orb)`,
      body: `The single most supportive aspect of the day — ${mjOrb < 3 ? 'and it is exact.' : ''} ${positions.moon.sign} Moon loves to analyse and improve; Jupiter in ${positions.jupiter.sign} expands emotional warmth and family security. A rare window where analytical ambition and the desire for genuine presence are not in conflict — they harmonise. A practical act of care lands with outsized emotional weight. Don't defer this.`
    });
  }

  // Sun-Venus sextile
  const venLon = positions.venus.lon;
  const svOrb  = Math.abs(sunLon - venLon);
  if (svOrb > 50 && svOrb < 70) {
    aspects.push({
      rating: 4, stars: '●●●●○',
      title: `Sun ${positions.sun.degree}° ${positions.sun.sign} sextile Venus ${positions.venus.degree}° ${positions.venus.sign} (${(svOrb-60).toFixed(1)}° orb)`,
      body: `Lightness, humour and genuine connection are cosmically available despite any business pressure. Venus in ${positions.venus.sign} rewards spontaneity and warmth — the easiest pivot from task-mode to presence-mode in the week. One unplanned, genuinely playful moment with those you love will land better than any scheduled activity.`
    });
  }

  // Uranus proximity to Gemini ingress
  if (positions.uranus.sign === 'Taurus' && positions.uranus.degree >= 27) {
    aspects.push({
      rating: 3, stars: '●●●○○',
      title: `Uranus ${positions.uranus.degree}° Taurus — Approaching Gemini Ingress`,
      body: `In the final degrees of Taurus, Uranus is completing its seven-year revolution of material and financial values. Its ingress into Gemini (approximately April 26, 2026) will accelerate disruption in communication, technology, and information economies. Financial structures and valuations are entering a period of liberation — deal timing and structuring matters more than usual now.`
    });
  }

  return aspects.slice(0, 5);
}

/* ═════════════════════════════════════════════════════════
   READING GENERATION
═════════════════════════════════════════════════════════ */

const TIER_CFG = {
  free:     { model:'claude-haiku-4-5-20251001',  max_tokens: 600,  label:'Free'     },
  seeker:   { model:'claude-haiku-4-5-20251001',  max_tokens: 1400, label:'Seeker'   },
  initiate: { model:'claude-sonnet-4-6',           max_tokens: 2000, label:'Initiate' },
  mystic:   { model:'claude-sonnet-4-6',           max_tokens: 3000, label:'Mystic'   },
  oracle:   { model:'claude-sonnet-4-6',           max_tokens: 4000, label:'Oracle'   }
};

function buildSystemPrompt(tier, profile, cosmicData) {
  const base = `You are the voice of Cosmic Daily Planner — the world's finest synthesiser of astronomical fact, depth astrology, Pythagorean numerology, and Dreamspell calendrics. You speak with the precision of an astronomer, the depth of a Jungian analyst, and the warmth of a trusted guide.

You always speak to ${profile.name || 'the user'} by name, with specific knowledge of their life.
You NEVER produce generic horoscope content. Every sentence must be specific, grounded, and actionable.
You always label Dreamspell as a modern system (Argüelles 1987), distinct from the ancient K'iche' Maya tzolkʼin tradition.
You never make deterministic predictions — you identify energetic themes and offer them as invitations, not inevitabilities.
You never use markdown headers or bullet points unless specifically structured JSON output is requested.
Voice: calm, grounded, elegant, warmly precise.

USER PROFILE:
Name: ${profile.name || 'the user'}
Location: ${profile.location || 'UK'}
Life Path: ${profile.lifePath || 'unknown'}
Personal Year: ${profile.personalYear || 'unknown'}
Birth Kin: ${profile.birthKin || 'unknown'}
Sun Sign: ${profile.sunSign || 'unknown'}
${profile.context ? `Personal Context:\n${profile.context}` : ''}

TODAY'S COSMIC DATA:
Date: ${cosmicData.dateStr}
Universal Day: ${cosmicData.ud} — ${NUM_NAMES[cosmicData.ud] || ''}
Month Energy: ${cosmicData.monthEnergy} — ${NUM_NAMES[cosmicData.monthEnergy] || ''}
Year Energy: ${cosmicData.yearEnergy} — ${NUM_NAMES[cosmicData.yearEnergy] || ''}
${profile.personalYear ? `Personal Year: ${profile.personalYear}` : ''}
Dreamspell Kin: ${cosmicData.kin.kin} — ${cosmicData.kin.name}${cosmicData.kin.isGAP ? ' (GALACTIC ACTIVATION PORTAL)' : ''}
Moon Phase: ${cosmicData.moonPhaseName}${cosmicData.moonSign ? ` in ${cosmicData.moonSign}` : ''}
Moon Age: ${cosmicData.moonAge} days
Black Moon Warning: ${cosmicData.isBlackMoon ? 'YES — two days before New Moon; proceed with care and introspection' : 'No'}
Shiva Moon: ${cosmicData.isShivaMoon ? 'YES — two days after New Moon; excellent time for new action' : 'No'}

PLANETARY POSITIONS:
${cosmicData.planetTable}

KEY ASPECTS:
${cosmicData.aspectSummary}`;

  return base;
}

function buildUserPrompt(tier, profile, cosmicData) {
  if (tier === 'free') {
    return `Generate a FREE tier daily card for ${profile.name || 'the user'} for ${cosmicData.dateStr}.
Return ONLY plain text (no JSON, no markdown), maximum 4 sentences.
Include: the Universal Day number and its meaning, today's Dreamspell Kin, the moon phase.
One specific action for today.
Feel like a lucky stone in the pocket — beautiful, personal, worth returning to daily.`;
  }

  if (tier === 'seeker') {
    return `Generate a SEEKER tier reading for ${profile.name || 'the user'} for ${cosmicData.dateStr}.
Return ONLY plain text, approximately 300 words.
Include: opening synthesis, numerology section, moon phase, Kin, top 3 priorities with specific actions, morning/afternoon/evening windows, one reflection prompt.
All personalized to ${profile.name}'s specific life context.`;
  }

  // INITIATE, MYSTIC, ORACLE — return structured JSON
  return `Generate a complete ${tier.toUpperCase()} tier Oracle reading for ${profile.name || 'the user'} for ${cosmicData.dateStr}.

Return ONLY valid JSON (no markdown, no preamble) with this exact structure:
{
  "synthesis": "2-3 sentences in the opening italic style — one truth that unifies all four frameworks for ${profile.name} today",
  "numerology": {
    "title": "UD ${cosmicData.ud} — ${NUM_NAMES[cosmicData.ud]||''}",
    "body": "150 words connecting the Universal Day number specifically to ${profile.name}'s actual situation today"
  },
  "moonSection": {
    "title": "${cosmicData.moonPhaseName}${cosmicData.moonSign ? ' in '+cosmicData.moonSign : ''}",
    "body": "120 words on the lunar phase and its specific invitation for ${profile.name} today${cosmicData.isBlackMoon?' — emphasise the tricky, introspective Black Moon energy':cosmicData.isShivaMoon?' — emphasise the blissful Shiva Moon energy for new action':''}"
  },
  "kinSection": {
    "title": "Kin ${cosmicData.kin.kin} — ${cosmicData.kin.name}${cosmicData.kin.isGAP?' — Galactic Portal':''}",
    "body": "100 words on this Kin's specific meaning for ${profile.name} today"
  },
  "astrologySection": {
    "title": "The Transits",
    "body": "200 words on the 2-3 most important transits for ${profile.name} today, specifically the Saturn-Neptune conjunction context if relevant"
  },
  "saturnNeptune": {
    "show": ${Math.abs(cosmicData.positions.saturn.lon - cosmicData.positions.neptune.lon) < 15},
    "body": "100 words on the Saturn-Neptune civilisational context and its specific relevance for ${profile.name}"
  },
  "shadowWork": "100 words in the shadow work section — the unconscious pattern to watch today for ${profile.name}, written in italic editorial voice",
  "priorities": [
    {"number": 1, "title": "...", "body": "80 words", "action": "Specific, concrete action for ${profile.name}"},
    {"number": 2, "title": "...", "body": "80 words", "action": "Specific, concrete action"},
    {"number": 3, "title": "...", "body": "80 words", "action": "Specific, concrete action"}
  ],
  "focusOn": ["item 1", "item 2", "item 3", "item 4"],
  "easeOff": ["item 1", "item 2", "item 3", "item 4"],
  "morning": "50 words — specific morning guidance for ${profile.name} based on planetary timing",
  "afternoon": "50 words — specific afternoon guidance based on planetary timing",
  "evening": "50 words — specific evening guidance based on planetary timing",
  "weekAhead": [
    {"date": "Thu 2/4", "ud": 7, "kinNum": 54, "kinName": "White Lunar Wizard", "isGAP": false, "body": "2 sentences personalised for ${profile.name}"},
    {"date": "Fri 3/4", "ud": 8, "kinNum": 55, "kinName": "Blue Electric Eagle", "isGAP": false, "body": "2 sentences"},
    {"date": "Sat 4/4", "ud": 9, "kinNum": 56, "kinName": "Yellow Self-Existing Warrior", "isGAP": true, "body": "2 sentences"},
    {"date": "Sun 5/4", "ud": 1, "kinNum": 57, "kinName": "Red Overtone Earth", "isGAP": false, "body": "2 sentences"},
    {"date": "Mon 6/4", "ud": 2, "kinNum": 58, "kinName": "White Rhythmic Mirror", "isGAP": true, "body": "2 sentences"},
    {"date": "Tue 7/4", "ud": 3, "kinNum": 59, "kinName": "Blue Resonant Storm", "isGAP": false, "body": "2 sentences"},
    {"date": "Wed 8/4", "ud": 4, "kinNum": 60, "kinName": "Yellow Galactic Seed", "isGAP": true, "body": "2 sentences"}
  ],
  "gift": {
    "quote": "A philosophical quote from a real author that resonates with today's themes",
    "attribution": "Author name, work, year",
    "body": "120 words — a personal meditation for ${profile.name} that weaves the quote into today's specific cosmic invitation"
  }
}

CRITICAL REQUIREMENTS:
- Every section MUST reference ${profile.name} by name and their specific life context
- Planetary positions are exact: ${cosmicData.planetTable}
- Do NOT invent planetary positions different from the data provided
- The week ahead Kin numbers and names must match exactly as given above
- All JSON must be valid — no trailing commas, proper escaping`;
}

/* HTTP Request to Anthropic ───────────────────────────── */
function anthropicCall(payload, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body); req.end();
  });
}

/* Build cosmic context object ─────────────────────────── */
function buildCosmicData(date, profile) {
  const positions   = getPlanetPositions(date);
  const kin         = getKinName(getDreamspellKin(date));
  const ud          = getUniversalDay(date);
  const monthEnergy = reduceNum(date.getMonth() + 1);
  const yearEnergy  = reduceNum(sumDigits(date.getFullYear()));
  const moonPhase   = getMoonPhaseKey(date);
  const moonAge     = getMoonAge(date);
  const isBlackMoon = moonPhase === 'black_moon';
  const isShivaMoon = moonPhase === 'shiva_moon';

  const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const dateStr = `${days[date.getDay()]}, ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;

  const planetTable = [
    `Sun: ${positions.sun.degree}° ${positions.sun.sign}`,
    `Moon: ${positions.moon.degree}° ${positions.moon.sign} (${MOON_PHASE_NAMES[moonPhase]}, ${moonAge.toFixed(1)}d)`,
    `Mercury: ${positions.mercury.degree}° ${positions.mercury.sign}`,
    `Venus: ${positions.venus.degree}° ${positions.venus.sign}`,
    `Mars: ${positions.mars.degree}° ${positions.mars.sign}`,
    `Jupiter: ${positions.jupiter.degree}° ${positions.jupiter.sign}`,
    `Saturn: ${positions.saturn.degree}° ${positions.saturn.sign}`,
    `Uranus: ${positions.uranus.degree}° ${positions.uranus.sign}`,
    `Neptune: ${positions.neptune.degree}° ${positions.neptune.sign}`,
    `Pluto: ${positions.pluto.degree}° ${positions.pluto.sign}`
  ].join('\n');

  const aspects      = getAspects(positions, profile);
  const aspectSummary = aspects.map(a => `${a.title} — ${a.body.slice(0,80)}…`).join('\n');

  return {
    dateStr, ud, monthEnergy, yearEnergy, kin,
    moonPhaseName: MOON_PHASE_NAMES[moonPhase], moonPhase,
    moonSign: positions.moon.sign, moonAge: moonAge.toFixed(1),
    isBlackMoon, isShivaMoon,
    positions, aspects, planetTable, aspectSummary
  };
}

/* ═════════════════════════════════════════════════════════
   API ROUTES
═════════════════════════════════════════════════════════ */

// Main reading endpoint
app.post('/api/reading', async (req, res) => {
  const { tier = 'oracle', date: dateStr, profile = {}, conversationHistory } = req.body;
  const cfg   = TIER_CFG[tier] || TIER_CFG.oracle;
  const date  = dateStr ? new Date(dateStr) : new Date();

  // Enrich profile with calculations if birth data present
  if (profile.birthDay && profile.birthMonth && profile.birthYear) {
    if (!profile.lifePath) {
      profile.lifePath    = getLifePath(profile.birthDay, profile.birthMonth, profile.birthYear);
    }
    if (!profile.personalYear) {
      profile.personalYear = getPersonalYear(profile.birthDay, profile.birthMonth, date);
    }
    if (!profile.birthKin) {
      const bKin = getKinName(getDreamspellKin(new Date(profile.birthYear, profile.birthMonth-1, profile.birthDay)));
      profile.birthKin = `Kin ${bKin.kin} — ${bKin.name}`;
    }
  }

  const cosmic   = buildCosmicData(date, profile);
  const sysPrompt = buildSystemPrompt(tier, profile, cosmic);
  const userPrompt = buildUserPrompt(tier, profile, cosmic);

  const messages = conversationHistory
    ? [...conversationHistory, { role: 'user', content: userPrompt }]
    : [{ role: 'user', content: userPrompt }];

  try {
    const resp = await anthropicCall({
      model: cfg.model, max_tokens: cfg.max_tokens,
      system: sysPrompt, messages
    });

    const rawText = resp.content?.[0]?.text || '';
    let reading;

    if (['initiate','mystic','oracle'].includes(tier)) {
      // Parse structured JSON
      try {
        const clean = rawText.replace(/```json|```/g, '').trim();
        reading = JSON.parse(clean);
      } catch {
        // Return raw if JSON parse fails
        reading = { synthesis: rawText, _raw: true };
      }
    } else {
      reading = { synthesis: rawText, _raw: true };
    }

    // Always include computed cosmic data for the frontend to use
    reading._cosmic = {
      ud: cosmic.ud, monthEnergy: cosmic.monthEnergy, yearEnergy: cosmic.yearEnergy,
      kin: cosmic.kin, moonPhase: cosmic.moonPhase, moonPhaseName: cosmic.moonPhaseName,
      moonSign: cosmic.moonSign, moonAge: cosmic.moonAge,
      isBlackMoon: cosmic.isBlackMoon, isShivaMoon: cosmic.isShivaMoon,
      dateStr: cosmic.dateStr, planetTable: cosmic.planetTable,
      aspects: cosmic.aspects,
      positions: {
        sun:     cosmic.positions.sun,
        moon:    cosmic.positions.moon,
        mercury: cosmic.positions.mercury,
        venus:   cosmic.positions.venus,
        mars:    cosmic.positions.mars,
        jupiter: cosmic.positions.jupiter,
        saturn:  cosmic.positions.saturn,
        uranus:  cosmic.positions.uranus,
        neptune: cosmic.positions.neptune,
        pluto:   cosmic.positions.pluto
      }
    };

    res.json({ reading, tier, model: cfg.model });
  } catch (err) {
    console.error('Reading error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Daily card (quick load, no tier gate)
app.post('/api/daily_message', async (req, res) => {
  const { profile = {}, date: dateStr } = req.body;
  const date   = dateStr ? new Date(dateStr) : new Date();
  const cosmic = buildCosmicData(date, profile);

  // Enrich profile
  if (profile.birthDay && profile.birthMonth && profile.birthYear) {
    profile.lifePath     = getLifePath(profile.birthDay, profile.birthMonth, profile.birthYear);
    profile.personalYear = getPersonalYear(profile.birthDay, profile.birthMonth, date);
    const bKin = getKinName(getDreamspellKin(new Date(profile.birthYear, profile.birthMonth-1, profile.birthDay)));
    profile.birthKin = `Kin ${bKin.kin} — ${bKin.name}`;
  }

  const sysPrompt = buildSystemPrompt('free', profile, cosmic);

  try {
    const resp = await anthropicCall({
      model: 'claude-haiku-4-5-20251001', max_tokens: 500,
      system: sysPrompt,
      messages: [{ role:'user', content:
        `Generate a single free-tier daily card for ${profile.name || 'the user'} — ${cosmic.dateStr}.
        Universal Day ${cosmic.ud}, ${cosmic.kin.name}, ${cosmic.moonPhaseName}.
        3-4 sentences, warmly personal, grounded. One specific action.
        Feel like a lucky stone: beautiful, worth returning to daily.
        Plain text only.` }]
    });

    res.json({
      message: resp.content?.[0]?.text || '',
      cosmic: {
        ud: cosmic.ud, kin: cosmic.kin,
        moonPhase: cosmic.moonPhase, moonPhaseName: cosmic.moonPhaseName,
        moonSign: cosmic.moonSign, dateStr: cosmic.dateStr,
        isBlackMoon: cosmic.isBlackMoon, isShivaMoon: cosmic.isShivaMoon,
        monthEnergy: cosmic.monthEnergy, yearEnergy: cosmic.yearEnergy,
        positions: cosmic.positions
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Conversational Q&A ("Ask your reading")
app.post('/api/ask', async (req, res) => {
  const { question, history = [], profile = {}, date: dateStr } = req.body;
  const date   = dateStr ? new Date(dateStr) : new Date();
  const cosmic = buildCosmicData(date, profile);
  const sysPrompt = buildSystemPrompt('oracle', profile, cosmic) +
    '\n\nYou are answering a follow-up question about today\'s reading. Be specific, warm, and concise (100-200 words). Plain text only.';

  const messages = [
    ...history,
    { role: 'user', content: question }
  ];

  try {
    const resp = await anthropicCall({
      model: 'claude-sonnet-4-6', max_tokens: 400,
      system: sysPrompt, messages
    });
    res.json({ answer: resp.content?.[0]?.text || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cosmic data only (for calendar/day previews — no API cost)
app.post('/api/cosmic', (req, res) => {
  const { date: dateStr, profile = {} } = req.body;
  const date   = dateStr ? new Date(dateStr) : new Date();
  const cosmic = buildCosmicData(date, profile);
  if (profile.birthDay && profile.birthMonth && profile.birthYear) {
    cosmic.personalYear = getPersonalYear(profile.birthDay, profile.birthMonth, date);
    const bKin = getKinName(getDreamspellKin(new Date(profile.birthYear, profile.birthMonth-1, profile.birthDay)));
    cosmic.birthKin = bKin;
  }
  res.json(cosmic);
});

// Catch-all → SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`CDP Production Server on port ${PORT}`));

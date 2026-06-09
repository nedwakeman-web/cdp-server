 // CDP v9.1 + v18 patch (5 May 2026, in-memory invitations fallback)
'use strict';
const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const bestDay = require('./best-day');
const threeVoice = require('./oracle-three-voice-prompt');
const { THREE_VOICE_INSTRUCTION, THREE_VOICE_SCHEMA, validateThreeVoiceReading, renderSectionThreeVoice, scrubHouseStyle } = threeVoice;

// ══════════════════════════════════════════════════════════════════
// Reading Orchestrator (per-section parallel composition)
// Replaces the single-shot 16k-token Oracle call that exceeded
// callAPI hard caps and routinely failed. Sections run in parallel,
// model selected per section, structured citations from bibliography,
// three voices per section, progressive phase-1 render.
// ══════════════════════════════════════════════════════════════════
const orchestrator = require('./reading-orchestrator');

// ══════════════════════════════════════════════════════════════════
// iter12: Compass Coordinate Drawer
// Loads structured bibliography for chip-tap Oracle drawers and
// exposes POST /api/compass/coordinate-drawer further down.
// ══════════════════════════════════════════════════════════════════
const fs = require('fs');
let CDP_BIBLIOGRAPHY = null;
try {
  const bibPath = path.join(__dirname, 'bibliography.json');
  const raw = fs.readFileSync(bibPath, 'utf8');
  CDP_BIBLIOGRAPHY = JSON.parse(raw);
  console.log('[coordinate-drawer] bibliography loaded:',
    Object.keys(CDP_BIBLIOGRAPHY.entries || {}).length, 'entries');
} catch (e) {
  console.warn('[coordinate-drawer] bibliography NOT loaded:', e.message);
  console.warn('[coordinate-drawer] expected at', path.join(__dirname, 'bibliography.json'));
}

// ══════════════════════════════════════════════════════════════════════════
// iter12f: CITATION POST-PROCESSOR
//
// After Sonnet returns Reading JSON, scan every prose field for author-year
// patterns ("Bremer 2022", "Pope and Wurlitzer 2017") and wrap them with
// <span class="v11-cite" data-ref="REF_ID">...</span> markers.
//
// This guarantees citations appear regardless of whether the model followed
// the explicit citation-format instruction. Prompt-engineering proved
// unreliable in iter12d/e; post-processing is the deterministic path.
//
// Build the lookup index ONCE at server boot from bibliography.json so the
// post-processor is fast (single regex pass per prose field).
// ══════════════════════════════════════════════════════════════════════════
const CITATION_INDEX = (function buildCitationIndex() {
  if (!CDP_BIBLIOGRAPHY || !CDP_BIBLIOGRAPHY.entries) return null;
  
  const patterns = [];
  
  for (const [refId, entry] of Object.entries(CDP_BIBLIOGRAPHY.entries)) {
    if (!entry || !entry.year) continue;
    const year = String(entry.year);
    
    // Get authors as array of surnames
    let surnames = [];
    if (Array.isArray(entry.authors)) {
      surnames = entry.authors.map(a => {
        // Convention: bibliography.json uses "Surname, Firstname" format.
        // Surname can be compound (e.g., "Hugo Wurlitzer, Sjanie" or
        // "Van Dam, N.").
        // Strategy: take everything before the comma as the surname phrase,
        // then take the last word of that phrase as the regex matcher.
        // This handles compound surnames correctly.
        const s = a.trim();
        let surnamePart;
        if (s.indexOf(',') > -1) {
          surnamePart = s.split(',')[0].trim();
        } else {
          // Format like "First Last" - take last word
          const parts = s.split(/\s+/);
          surnamePart = parts[parts.length - 1];
        }
        // Take the last word of the surname phrase (handles "Hugo Wurlitzer" -> "Wurlitzer")
        const surWords = surnamePart.split(/\s+/);
        const finalSurname = surWords[surWords.length - 1];
        return finalSurname;
      }).filter(s => s && s.length >= 3 && /^[A-Z]/.test(s));
    } else if (typeof entry.authors === 'string') {
      surnames = [entry.authors.split(/[\s,]+/)[0]];
    }
    
    if (surnames.length === 0) continue;
    
    // Build all citation patterns this entry matches:
    //  - "Surname YEAR"                  → single author or "et al"
    //  - "Surname1 and Surname2 YEAR"    → two authors
    //  - "Surname1 et al YEAR"           → many authors
    //  - "Surname1 et al. YEAR"          → with period
    //  - "Surname, YEAR"                 → comma-style
    
    const s1 = surnames[0];
    const escS1 = s1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    if (surnames.length === 1) {
      // Single author: "Smith 2022" or "Smith, 2022" or "Smith (2022)"
      patterns.push({
        regex: new RegExp('\\b(' + escS1 + ')(\\s+and\\s+\\w+)?(\\s*,?\\s*\\(?\\s*' + year + '\\)?)\\b', 'g'),
        refId: refId,
        display: s1 + ' ' + year,
        priority: 1
      });
    } else if (surnames.length === 2) {
      // Two authors: "Pope and Wurlitzer 2017"
      const s2 = surnames[1];
      const escS2 = s2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      patterns.push({
        regex: new RegExp('\\b' + escS1 + '\\s+and\\s+' + escS2 + '\\s*,?\\s*\\(?\\s*' + year + '\\)?\\b', 'g'),
        refId: refId,
        display: s1 + ' and ' + s2 + ' ' + year,
        priority: 2
      });
      // Also catch just first author with year (e.g., "Pope 2017")
      patterns.push({
        regex: new RegExp('\\b' + escS1 + '\\s*,?\\s*\\(?\\s*' + year + '\\)?\\b', 'g'),
        refId: refId,
        display: s1 + ' ' + year,
        priority: 1
      });
    } else {
      // 3+ authors: "Klusmann et al 2023" or just "Klusmann 2023"
      patterns.push({
        regex: new RegExp('\\b' + escS1 + '\\s+et\\s+al\\.?\\s*,?\\s*\\(?\\s*' + year + '\\)?\\b', 'g'),
        refId: refId,
        display: s1 + ' et al ' + year,
        priority: 2
      });
      patterns.push({
        regex: new RegExp('\\b' + escS1 + '\\s*,?\\s*\\(?\\s*' + year + '\\)?\\b', 'g'),
        refId: refId,
        display: s1 + ' ' + year,
        priority: 1
      });
    }
  }
  
  // Sort by priority DESC so longer multi-author patterns match before single-author
  patterns.sort((a, b) => b.priority - a.priority);
  
  console.log('[citation-postprocessor] index built:', patterns.length, 'patterns for',
    Object.keys(CDP_BIBLIOGRAPHY.entries).length, 'entries');
  return patterns;
})();

/**
 * Wrap "Author Year" mentions with <span class="v11-cite" data-ref="REF_ID">
 * Skip text already inside an existing v11-cite span.
 */
function wrapCitations(text) {
  if (!text || typeof text !== 'string') return text;
  if (!CITATION_INDEX || CITATION_INDEX.length === 0) return text;
  
  // To avoid wrapping inside already-wrapped citations, we mask existing
  // v11-cite spans, do the replacement, then restore.
  const existingSpans = [];
  let masked = text.replace(/<span\s+class="v11-cite"[^>]*>[^<]*<\/span>/g, function(m) {
    existingSpans.push(m);
    return '\u0001CITE_PLACEHOLDER_' + (existingSpans.length - 1) + '\u0001';
  });
  
  // Apply each pattern. Highest priority (multi-author) first to prevent
  // single-author patterns matching part of a multi-author string.
  for (const pattern of CITATION_INDEX) {
    masked = masked.replace(pattern.regex, function(match) {
      // Skip if match is inside our placeholder
      if (match.indexOf('\u0001') >= 0) return match;
      return '<span class="v11-cite" data-ref="' + pattern.refId + '">' + match + '</span>';
    });
  }
  
  // Restore existing spans
  masked = masked.replace(/\u0001CITE_PLACEHOLDER_(\d+)\u0001/g, function(_, idx) {
    return existingSpans[parseInt(idx, 10)] || '';
  });
  
  return masked;
}

/**
 * Walk a Reading JSON object and apply wrapCitations to every string value.
 * Returns count of citations wrapped for logging.
 */
function postProcessCitations(obj) {
  let wrapped = 0;
  const visited = new WeakSet();
  
  function walk(node) {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') return; // handled in parent
    if (typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);
    
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (typeof node[i] === 'string') {
          const before = (node[i].match(/v11-cite/g) || []).length;
          node[i] = wrapCitations(node[i]);
          const after = (node[i].match(/v11-cite/g) || []).length;
          wrapped += (after - before);
        } else {
          walk(node[i]);
        }
      }
    } else {
      for (const key of Object.keys(node)) {
        if (typeof node[key] === 'string') {
          const before = (node[key].match(/v11-cite/g) || []).length;
          node[key] = wrapCitations(node[key]);
          const after = (node[key].match(/v11-cite/g) || []).length;
          wrapped += (after - before);
        } else {
          walk(node[key]);
        }
      }
    }
  }
  
  walk(obj);
  return wrapped;
}


// ── CORS, accept all origins (frontend is public; auth handled by tier logic) ──
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,PUT,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-CDP-Anon-Id,X-CDP-Timezone');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// iter13d/13f: raise JSON body-parser limit. Default 100kb is too small for
// follow-up Q&A calls (/api/ask, /api/cosmic, etc) which bundle the full
// reading payload as context. Oracle-tier readings now include 10 sections
// with three voices each plus citation metadata plus the legacy projection
// bridge plus history, which can exceed 4mb in practice. 16mb covers
// realistic worst case with headroom; the frontend has been updated to
// trim readingData before send so this should be defensive only.
app.use(express.json({ limit: '16mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── SECURITY HEADERS ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "font-src 'self' https://fonts.gstatic.com https://fonts.googleapis.com data:; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; " +
    "connect-src 'self' https://api.anthropic.com https://*.supabase.co https://*.supabase.in; " +
    "img-src 'self' data: blob: https:; " +
    "frame-src 'none';"
  );
  next();
});


// ══════════════════════════════════════════════════════════════════
// SWISS EPHEMERIS 2026, verified from Astrodienst ae_2026.pdf
// [sun°, moon°, mercury°, venus°, mars°, jupiter°, saturn°, uranus°, neptune°, pluto°]
// Decimal tropical geocentric at 00:00 UT
// Signs: Ar=0 Ta=30 Ge=60 Ca=90 Le=120 Vi=150 Li=180 Sc=210 Sg=240 Cp=270 Aq=300 Pi=330
// ══════════════════════════════════════════════════════════════════
const EPH = {
  '2026-03-29':[8.31,19.13,11.42,359.65,20.77,105.17,5.17,58.57,2.08,305.20],
  '2026-03-30':[9.30,2.45,12.12,0.42,21.55,105.22,5.30,58.62,2.08,305.20],
  '2026-03-31':[10.29,165.57,12.88,1.08,22.33,105.72,5.42,58.72,2.17,305.20],
  '2026-04-01':[11.28,178.48,13.70,1.63,23.12,105.78,5.55,58.80,2.20,305.23],
  '2026-04-02':[12.26,191.20,14.57,2.87,23.90,105.85,5.67,58.80,2.23,305.23],
  '2026-04-03':[13.25,203.72,15.50,4.10,24.68,105.92,5.80,58.85,2.28,305.25],
  '2026-04-04':[14.23,216.05,16.47,5.33,25.47,105.98,5.92,58.90,2.32,305.27],
  '2026-04-05':[15.22,228.22,17.48,6.57,26.25,106.07,6.05,58.93,2.35,305.28],
  '2026-04-06':[16.20,240.23,18.55,7.78,27.02,106.15,6.17,58.98,2.38,305.30],
  '2026-04-07':[17.19,252.15,19.65,9.02,27.80,106.22,6.28,59.03,2.43,305.30],
  '2026-04-08':[18.17,264.03,20.80,10.25,28.58,106.30,6.42,59.08,2.47,305.32],
  '2026-04-09':[19.15,275.92,21.98,11.47,29.37,106.40,6.53,59.13,2.50,305.33],
  '2026-04-10':[20.14,287.88,23.20,12.70,0.15,106.48,6.67,59.17,2.53,305.35],
  '2026-04-11':[21.12,300.03,24.45,13.92,0.92,106.57,6.78,59.22,2.57,305.37],
  '2026-04-12':[22.10,312.43,25.73,15.15,1.70,106.67,6.90,59.27,2.60,305.38],
  '2026-04-13':[23.08,324.80,27.07,16.37,2.48,106.77,7.03,59.32,2.65,305.40],
  '2026-04-14':[24.06,337.27,28.42,17.60,3.25,106.87,7.15,59.37,2.68,305.42],
  '2026-04-15':[25.04,349.80,29.80,18.82,4.03,106.97,7.27,59.42,2.72,305.43],
  '2026-04-16':[26.02,2.37,1.22,20.03,4.80,107.07,7.38,59.45,2.75,305.45],
  '2026-04-17':[27.00,14.97,2.67,21.27,5.58,107.18,7.52,59.50,2.78,305.47],
  '2026-04-18':[27.98,27.95,4.15,22.48,6.35,107.28,7.63,59.57,2.82,305.48],
  '2026-04-19':[28.96,49.78,5.65,23.70,7.13,107.40,7.75,59.62,2.87,305.50],
  '2026-04-20':[29.93,64.78,7.18,24.92,7.90,107.52,7.87,59.68,2.90,305.52],
  '2026-04-21':[30.91,79.62,8.75,26.15,8.68,107.63,7.98,59.73,2.93,305.53],
  '2026-04-22':[31.88,94.23,10.35,27.37,9.45,107.75,8.10,59.78,2.97,305.55],
  '2026-04-23':[32.86,108.62,11.97,28.58,10.22,107.87,8.22,59.83,3.00,305.57],
  '2026-04-24':[33.84,122.48,13.62,29.80,11.00,107.98,8.35,59.88,3.03,305.58],
  '2026-04-25':[34.81,136.10,15.30,31.02,11.77,108.12,8.47,59.92,3.07,305.60],
  '2026-04-26':[35.79,149.42,17.00,32.23,12.53,108.25,8.57,60.00,3.12,305.62],
  '2026-04-27':[36.76,162.37,18.73,33.43,13.30,108.37,8.68,60.05,3.13,305.63],
  '2026-04-28':[37.73,175.33,20.50,34.65,14.07,108.50,8.80,60.10,3.17,305.65],
  '2026-04-29':[38.70,188.27,22.30,35.87,14.83,108.63,8.92,60.13,3.20,305.67],
  '2026-04-30':[39.67,200.25,24.12,37.08,15.60,108.78,9.03,60.22,3.23,305.50],
  '2026-05-01':[40.64,212.00,25.97,38.28,16.37,108.92,9.15,60.28,3.27,305.50],
  '2026-05-15':[55.29,280.00,12.00,53.03,24.07,109.80,10.25,60.75,3.58,305.68],
  '2026-06-01':[71.24,310.00,26.25,68.22,32.25,110.25,11.15,61.12,3.83,305.68],
};

const PLANETS = ['Sun','Moon','Mercury','Venus','Mars','Jupiter','Saturn','Uranus','Neptune','Pluto'];
const SIGNS = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];

function getSign(deg){const d=((deg%360)+360)%360;return SIGNS[Math.floor(d/30)];}
function getDegInSign(deg){const d=((deg%360)+360)%360;return (d%30).toFixed(1);}

function getEphData(dateStr){
  if(EPH[dateStr])return EPH[dateStr];
  const keys=Object.keys(EPH).sort();
  let prev=null,next=null;
  for(const k of keys){if(k<=dateStr)prev=k;if(k>=dateStr&&!next)next=k;}
  if(!prev)return EPH[keys[0]];
  if(!next)return EPH[keys[keys.length-1]];
  if(prev===next)return EPH[prev];
  const d0=new Date(prev),d1=new Date(next),d2=new Date(dateStr);
  const t=(d2-d0)/(d1-d0);
  return EPH[prev].map((v,i)=>v+t*(EPH[next][i]-v));
}

function buildPlanets(dateStr){
  const raw=getEphData(dateStr);
  return raw.map((deg,i)=>({name:PLANETS[i],deg,sign:getSign(deg),degStr:`${getDegInSign(deg)}° ${getSign(deg)}`}));
}

// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// NUMEROLOGY + MOON ENRICHMENT, integrated from cdp-features-module.js
// Sources: Goodwin (1994); Drayer (2002); Sónia Indigo system
// ══════════════════════════════════════════════════════════════

const NUM_MASTER = new Set([11, 22, 33, 44]);

function numReduce(n) {
  while (n > 9 && !NUM_MASTER.has(n)) {
    n = String(n).split('').reduce((a, d) => a + parseInt(d), 0);
  }
  return n;
}

  const MEANINGS = {
    1: {
      title: 'New Beginnings',
      theme: 'Initiation & Leadership',
      energy: 'Yang · Active · Pioneering',
      guidance: 'Start something new. Focus on work. Welcome new cycles.',
      shadow: 'Avoid impulsiveness; channel drive into clear intention.',
      keywords: ['initiation', 'independence', 'willpower', 'originality'],
      best_for: ['launching projects', 'solo work', 'setting intentions', 'new contracts'],
      special: false
    },
    2: {
      title: 'Partnership',
      theme: 'Union & Receptivity',
      energy: 'Yin · Receptive · Harmonising',
      guidance: 'Everything related to couples, relationships, partnership, union, gentleness, tenderness, helping and assisting others.',
      shadow: 'Watch for people-pleasing; true partnership requires honest presence.',
      keywords: ['cooperation', 'diplomacy', 'sensitivity', 'balance'],
      best_for: ['negotiations', 'collaborations', 'counselling', 'relationship conversations'],
      special: false
    },
    3: {
      title: 'Creative Expression',
      theme: 'Communication & Connection',
      energy: 'Expressive · Social · Generative',
      guidance: 'Great moment to be creative and artistic, to deal with relationships in general, meetings, connections with people, marketing, social media.',
      shadow: 'Scattered energy, commit to one creative focus.',
      keywords: ['creativity', 'communication', 'joy', 'self-expression'],
      best_for: ['creative projects', 'social media', 'presentations', 'networking events'],
      special: false
    },
    4: {
      title: 'Foundation',
      theme: 'Structure & Integrity',
      energy: 'Grounding · Disciplined · Honest',
      guidance: 'Time to work hard with honesty. Truth, correction, integrity, morality, fairness, uprightness.',
      shadow: 'Rigidity, build structure without becoming inflexible.',
      keywords: ['discipline', 'stability', 'honesty', 'perseverance'],
      best_for: ['system building', 'planning', 'due diligence', 'truth-telling conversations'],
      special: false
    },
    5: {
      title: 'Freedom & Intelligence',
      theme: 'Change & Learning',
      energy: 'Dynamic · Curious · Versatile',
      guidance: 'Intelligence, learning new things, relationships, connections with people, meetings, marketing, social media.',
      shadow: 'Restlessness, embrace change without abandoning depth.',
      keywords: ['freedom', 'adaptability', 'curiosity', 'movement'],
      best_for: ['learning', 'travel', 'pivots', 'diverse meetings', 'new research'],
      special: false
    },
    6: {
      title: 'Harmony & Care',
      theme: 'Beauty, Family & Service',
      energy: 'Nurturing · Artistic · Responsible',
      guidance: 'Art, creativity, gentleness, tenderness, helping, assisting and being kind with others. Good day to be in family, couple or among friends.',
      shadow: 'Over-giving, nourish others from fullness, not depletion.',
      keywords: ['compassion', 'beauty', 'responsibility', 'home'],
      best_for: ['family time', 'creative arts', 'community', 'healing conversations'],
      special: false
    },
    7: {
      title: '✦ Karmic Portal',
      theme: 'Mystery, Depth & Inner Knowing',
      energy: 'Introspective · Mystical · Intense',
      guidance: 'The Portals of the Universal Forces Are Open. This is a karmic and magical number. This day tends to be intense, either challenging or amazing depending on how attuned you are with your true Self. An opportunity to connect with the highest realms, enjoy aloneness and creativity.',
      shadow: 'Isolation and over-analysis, open to the mystical without retreating entirely.',
      keywords: ['wisdom', 'solitude', 'investigation', 'spiritual depth'],
      best_for: ['deep research', 'meditation', 'solo creative work', 'inner guidance'],
      special: true,
      special_label: 'Portal Day'
    },
    8: {
      title: 'Power & Abundance',
      theme: 'Business, Karma & Mastery',
      energy: 'Ambitious · Executive · Karmic',
      guidance: 'Excellent day to deal with projects, business, focus, trades, career, work, structuring, money.',
      shadow: 'Power misused returns as obstacle, act with integrity.',
      keywords: ['success', 'authority', 'abundance', 'karma'],
      best_for: ['business deals', 'financial planning', 'career moves', 'executive decisions'],
      special: false
    },
    9: {
      title: '✦ Cosmic Portal',
      theme: 'Completion & Universal Love',
      energy: 'Transcendent · Compassionate · Cosmic',
      guidance: 'The Portals of the Universal Forces and Cosmic Energies Are Open. This is a very special day. Favorable for resting, channeling higher sources, being alone, enjoying a peaceful and flowing day. Special meetings might happen.',
      shadow: 'Difficulty releasing the old, trust that completion creates space.',
      keywords: ['completion', 'compassion', 'release', 'universal wisdom'],
      best_for: ['completion of cycles', 'acts of service', 'spiritual practice', 'letting go'],
      special: true,
      special_label: 'Cosmic Portal Day'
    },
    11: {
      title: '✦✦ Master Number 11. The Illuminator',
      theme: 'Spiritual Insight & Higher Vision',
      energy: 'Illuminating · Intuitive · Elevated',
      guidance: 'Master Number Day. The Portals of the Universal Forces Are Open. Can be a magic and different experience; be aware of the energy of this day. Depending on how attuned you are with your true Self, this day can be challenging or amazing. An opportunity to connect with the highest realms, enjoy aloneness, have special meetings. This is definitely a special and unique day.',
      shadow: 'Nervous system overload, ground the vision in practical small steps.',
      keywords: ['illumination', 'intuition', 'inspiration', 'higher ideals'],
      best_for: ['inspired creative leaps', 'visionary planning', 'spiritual practices', 'channeling insights'],
      special: true,
      special_label: 'Master 11 Day',
      master: true,
      base_energy: 2
    },
    22: {
      title: '✦✦ Master Number 22. The Master Builder',
      theme: 'Visionary Structure & World Work',
      energy: 'Architectural · Disciplined · Transcendent',
      guidance: 'Master Number Day. The Portals of the Universal Forces Are Open. This day brings an energy related to projects, business and work, it carries a similar energy of the number 4. Depending on how attuned you are with your true Self, this day can be challenging or amazing. An opportunity to connect with the highest realms, to enjoy aloneness, to have special meetings. This is definitely a special and unique day.',
      shadow: 'Paralysis by perfectionism, begin the build even if the blueprint is incomplete.',
      keywords: ['mastery', 'legacy', 'architecture', 'vision made real'],
      best_for: ['major project launches', 'strategic architecture', 'legacy decisions', 'building systems'],
      special: true,
      special_label: 'Master 22 Day',
      master: true,
      base_energy: 4
    },
    33: {
      title: '✦✦ Master Number 33. The Master Teacher',
      theme: 'Compassionate Service & Cosmic Teaching',
      energy: 'Selfless · Healing · Divinely Creative',
      guidance: 'Master Number Day. The Portals of the Universal Forces Are Open. This day tends to be intense, either karmic/challenging or amazing depending on how attuned you are. An opportunity to connect with the highest realms, enjoy aloneness and have special meetings. Favorable for channeling higher sources and listening to your intuition.',
      shadow: 'Martyrdom, teach by illumination, not self-sacrifice.',
      keywords: ['compassion', 'healing', 'teaching', 'creative mastery'],
      best_for: ['teaching', 'healing arts', 'community leadership', 'inspired creative work'],
      special: true,
      special_label: 'Master 33 Day',
      master: true,
      base_energy: 6
    },
    44: {
      title: '✦✦ Master Number 44. The Master Manifestor',
      theme: 'Material Mastery & Cosmic Business',
      energy: 'Grounding · Manifesting · Divinely Structured',
      guidance: 'Master Number Day. The Portals of the Universal Forces Are Open. This number carries the energy of number 8 (profoundly related to business, project, work and money. This day tends to be intense) either challenging or amazing. An opportunity to connect with the highest realms, be surprised by special unexpected meetings. Favorable for channeling higher sources and paying close attention to your intuition, especially when related to work, business and projects.',
      shadow: 'Over-materialisation, remember the cosmic thread running through all of it.',
      keywords: ['manifestation', 'mastery', 'cosmic business', 'legacy wealth'],
      best_for: ['major financial decisions', 'long-term strategic moves', 'building for legacy', 'inspired business'],
      special: true,
      special_label: 'Master 44 Day',
      master: true,
      base_energy: 8
    }
  };

  /**
   * Calculate the THREE numerological energies for any date
   *
   * Layer 1, Day Energy:       just the day number (dd)
   * Layer 2, Month Energy:     day + month (dd + mm)
   * Layer 3, Full Date Energy: day + month + year (dd + mm + yyyy)
   *
   * @param {Date|string} date
   * @returns {{ day, month, full, raw }}
   */
  function threeLayerEnergy(date) {
    const d = date instanceof Date ? date : new Date(date);
    const dd = d.getUTCDate();
    const mm = d.getUTCMonth() + 1;
    const yyyy = d.getUTCFullYear();

    const dayRaw  = dd;
    const monthRaw = dd + mm;
    const fullRaw  = dd + mm + Math.floor(yyyy / 1000)
                    + Math.floor((yyyy % 1000) / 100)
                    + Math.floor((yyyy % 100) / 10)
                    + (yyyy % 10);
    // Better full-date sum: sum ALL digits
    const fullDigitSum = String(dd).split('').concat(
      String(mm).split(''),
      String(yyyy).split('')
    ).reduce((a, c) => a + parseInt(c), 0);

    return {
      day:   { raw: dayRaw,      reduced: reduce(dayRaw),      meaning: MEANINGS[reduce(dayRaw)] },
      month: { raw: monthRaw,    reduced: reduce(monthRaw),    meaning: MEANINGS[reduce(monthRaw)] },
      full:  { raw: fullDigitSum, reduced: reduce(fullDigitSum), meaning: MEANINGS[reduce(fullDigitSum)] }
    };
  }

  /**
   * Calculate personal day, month, year energies overlaid on birth numerology
   * @param {Date} date  , the calendar date
   * @param {Date} dob   , date of birth
   */
  function personalEnergies(date, dob) {
    const d  = date instanceof Date ? date : new Date(date);
    const b  = dob instanceof Date ? dob : new Date(dob);
    const dd = d.getUTCDate(), mm = d.getUTCMonth() + 1, yyyy = d.getUTCFullYear();
    const bm = b.getUTCMonth() + 1, bd = b.getUTCDate();

    // Personal Year = birth-day + birth-month + current-year digits
    const pyRaw = bd + bm + String(yyyy).split('').reduce((a,c) => a+parseInt(c), 0);
    const personalYear = reduce(pyRaw);

    // Personal Month = personal year + current month
    const personalMonth = reduce(personalYear + mm);

    // Personal Day = personal month + current day
    const personalDay = reduce(personalMonth + dd);

    return {
      personalYear:  { reduced: personalYear,  meaning: MEANINGS[personalYear] },
      personalMonth: { reduced: personalMonth, meaning: MEANINGS[personalMonth] },
      personalDay:   { reduced: personalDay,   meaning: MEANINGS[personalDay] }
    };
  }

  /** Life Path calculation (reduces full DOB, master-safe) */
  function lifePath(dob) {
    const b = dob instanceof Date ? dob : new Date(dob);
    const sum = String(b.getUTCFullYear()).split('')
      .concat(String(b.getUTCMonth()+1).split(''), String(b.getUTCDate()).split(''))
      .reduce((a,c) => a + parseInt(c), 0);
    return { reduced: reduce(sum), raw: sum, meaning: MEANINGS[reduce(sum)] };
  }

  /** Quick label for calendar badge */
  function calendarBadge(date) {
    const { full } = threeLayerEnergy(date);
    const n = full.reduced;
    if (MASTER_NUMBERS.has(n)) return { label: `M${n}`, type: 'master', color: '#c9a227' };
    if (n === 7) return { label: '7✦', type: 'portal', color: '#7b5ea7' };
    if (n === 9) return { label: '9✦', type: 'cosmic', color: '#4a90d9' };
    return { label: String(n), type: 'normal', color: null };
  }


// Three-layer numerology (Day / Day+Month / Full Date)
function threeLayerNumerology(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dd = d.getUTCDate(), mm = d.getUTCMonth() + 1;
  const yyyy = d.getUTCFullYear();
  const dayRaw = dd;
  const monthRaw = dd + mm;
  const fullRaw = String(dd).split('').concat(String(mm).split(''), String(yyyy).split(''))
    .reduce((a,c) => a + parseInt(c), 0);
  const dayR = numReduce(dayRaw);
  const monthR = numReduce(monthRaw);
  const fullR = numReduce(fullRaw);
  return {
    day:   { n: dayR,   meaning: MEANINGS[dayR]   },
    month: { n: monthR, meaning: MEANINGS[monthR] },
    full:  { n: fullR,  meaning: MEANINGS[fullR],  isMaster: NUM_MASTER.has(fullR) }
  };
}

// Personal numerology enrichment
function personalNumerology(dateStr, birthDay, birthMonth, birthYear) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const mm = d.getUTCMonth() + 1;
  const yyyyDigits = String(d.getUTCFullYear()).split('').reduce((a,c)=>a+parseInt(c),0);
  const py = numReduce(parseInt(birthDay) + parseInt(birthMonth) + yyyyDigits);
  const pm = numReduce(py + mm);
  const pd = numReduce(pm + d.getUTCDate());
  return { personalYear: py, personalMonth: pm, personalDay: pd,
    pyMeaning: MEANINGS[py], pmMeaning: MEANINGS[pm], pdMeaning: MEANINGS[pd] };
}

// Moon enrichment, Julian Day based, adds Black Moon + Shiva Moon labels
function moonEnrichment(dateStr) {
  function toJD(y,m,d) {
    if (m<=2){y--;m+=12;}
    const A=Math.floor(y/100),B=2-A+Math.floor(A/4);
    return Math.floor(365.25*(y+4716))+Math.floor(30.6001*(m+1))+d+B-1524.5;
  }
  const dt = new Date(dateStr + 'T12:00:00Z');
  const jd = toJD(dt.getUTCFullYear(), dt.getUTCMonth()+1, dt.getUTCDate()+0.5);
  const age = ((jd - 2451550.259) % 29.53058867 + 29.53058867) % 29.53058867;
  const toNew = 29.53058867 - age;
  const isBlack = toNew >= 0.6 && toNew <= 2.6;
  const isShiva = age >= 1.0 && age <= 2.5;
  return {
    age: parseFloat(age.toFixed(2)),
    toNew: parseFloat(toNew.toFixed(2)),
    isBlackMoon: isBlack,
    isShivaMoon: isShiva,
    blackMoonGuidance: isBlack ? 'Black Moon window, liminal, tricky, reflective. Avoid major initiations; review, release, prepare. Discernment essential.' : null,
    shivaMoonGuidance: isShiva ? 'Shiva Moon window, blissful renewal after the reset. Fertile for new intentions and inspired beginnings.' : null
  };
}

// MOON PHASE, USNO verified new moon Jan 17, 2026 02:02 UTC
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// MOON, USNO 2026 phase table (verified accurate to within ~2 minutes)
// AUTHORITATIVE SOURCE: U.S. Naval Observatory ephemeris
// (https://aa.usno.navy.mil/data/MoonPhases) cross-verified with
// timeanddate.com, royal-observatory-greenwich.com, theskylive.com
//
// Previous server used a naive synodic-month calculation anchored on
// 17 Jan 2026 02:02 UTC. Sonia flagged moon phases as 2 days early.
// Verified: actual New Moon Jan 2026 was 18 Jan 19:52 UTC (not 17 Jan).
// Plus, real lunation period varies ±15 hours from mean cycle, so
// pure arithmetic accumulates error across the year.
//
// v32 fix: phase-table approach. Each named-phase calendar date is the
// labelled phase. For dates between named phases, interpolate using
// fraction of cycle from prior new moon to next new moon.
// ══════════════════════════════════════════════════════════════════
const LUNAR=29.53058867;

// USNO-derived 2026 lunar phases (UTC). Cross-verified against multiple sources.
const PHASES_2026 = {
  newMoons: [
    '2026-01-18T19:52:00Z','2026-02-17T12:01:00Z','2026-03-19T01:23:00Z',
    '2026-04-17T11:51:00Z','2026-05-16T20:01:00Z','2026-06-15T02:54:00Z',
    '2026-07-14T09:43:00Z','2026-08-12T17:36:00Z','2026-09-11T03:27:00Z',
    '2026-10-10T15:50:00Z','2026-11-09T07:01:00Z','2026-12-09T00:51:00Z'
  ],
  firstQuarters: [
    '2026-01-26T05:48:00Z','2026-02-24T15:28:00Z','2026-03-26T01:18:00Z',
    '2026-04-24T11:32:00Z','2026-05-23T22:53:00Z','2026-06-22T11:55:00Z',
    '2026-07-22T02:55:00Z','2026-08-20T20:40:00Z','2026-09-19T16:46:00Z',
    '2026-10-18T13:13:00Z','2026-11-17T08:48:00Z','2026-12-17T03:09:00Z'
  ],
  fullMoons: [
    '2026-01-03T10:02:00Z','2026-02-01T22:09:00Z','2026-03-03T11:38:00Z',
    '2026-04-02T01:11:00Z','2026-05-01T16:23:00Z','2026-05-31T08:45:00Z',
    '2026-06-29T23:57:00Z','2026-07-29T13:36:00Z','2026-08-28T03:18:00Z',
    '2026-09-26T16:49:00Z','2026-10-26T07:12:00Z','2026-11-24T15:53:00Z',
    '2026-12-24T01:28:00Z'
  ],
  lastQuarters: [
    '2026-01-10T15:48:00Z','2026-02-09T07:43:00Z','2026-03-10T19:25:00Z',
    '2026-04-09T05:51:00Z','2026-05-09T16:11:00Z','2026-06-08T03:01:00Z',
    '2026-07-07T15:30:00Z','2026-08-06T05:51:00Z','2026-09-04T22:33:00Z',
    '2026-10-04T17:12:00Z','2026-11-03T11:20:00Z','2026-12-03T03:54:00Z'
  ]
};

// Pre-2026 fallback: 20 Dec 2025 new moon (USNO)
const FALLBACK_PRE2026_NEW = new Date('2025-12-20T01:43:00Z');

function _sameUTCDay(a, b) {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function getMoon(dateStr){
  const d=new Date(dateStr+'T12:00:00Z');

  // 1. Exact named-phase dates (calendar-day match) take precedence
  for(const ns of PHASES_2026.newMoons) if(_sameUTCDay(new Date(ns),d))
    return _moonResult('New Moon','🌑','Dark time, seed intention in silence',0,d);
  for(const fs of PHASES_2026.fullMoons) if(_sameUTCDay(new Date(fs),d))
    return _moonResult('Full Moon','🌕','Illumination, what is real becomes visible',14.77,d);
  for(const fq of PHASES_2026.firstQuarters) if(_sameUTCDay(new Date(fq),d))
    return _moonResult('First Quarter','🌓','Decisive action, push through resistance',7.38,d);
  for(const lq of PHASES_2026.lastQuarters) if(_sameUTCDay(new Date(lq),d))
    return _moonResult('Last Quarter','🌗','Reassess, release what no longer serves',22.15,d);

  // 2. Find most recent new moon BEFORE target, and next new moon AFTER target
  let lastNew=null, nextNew=null;
  for(const ns of PHASES_2026.newMoons){
    const n=new Date(ns);
    if(n<=d) lastNew=n;
    else { nextNew=n; break; }
  }
  if(!lastNew) lastNew=FALLBACK_PRE2026_NEW;
  if(!nextNew) nextNew=new Date(lastNew.getTime()+LUNAR*86400000);

  const cyc=(d-lastNew)/86400000;
  const cycLength=(nextNew-lastNew)/86400000;
  const fraction=cyc/cycLength;  // 0 to 1

  let phase, emoji, desc;
  // Phase boundaries (fraction of cycle from new to new):
  // new       0.000
  // crescent  0.000-0.250 (first quarter at 0.250)
  // waxing-g  0.250-0.500 (full at 0.500)
  // waning-g  0.500-0.750 (last quarter at 0.750)
  // crescent  0.750-1.000 (next new at 1.000)
  if(fraction<0.06){phase='New Moon';emoji='🌑';desc='Dark time, seed intention in silence';}
  else if(fraction<0.225){phase='Waxing Crescent';emoji='🌒';desc='Build momentum, plant seeds';}
  else if(fraction<0.275){phase='First Quarter';emoji='🌓';desc='Decisive action, push through resistance';}
  else if(fraction<0.475){phase='Waxing Gibbous';emoji='🌔';desc='Refine, polish, prepare for release';}
  else if(fraction<0.525){phase='Full Moon';emoji='🌕';desc='Illumination, what is real becomes visible';}
  else if(fraction<0.725){phase='Waning Gibbous';emoji='🌖';desc='Harvest, integrate, share wisdom';}
  else if(fraction<0.775){phase='Last Quarter';emoji='🌗';desc='Reassess, release what no longer serves';}
  else if(fraction<0.94){phase='Waning Crescent';emoji='🌘';desc='Rest, reflect, prepare for rebirth';}
  else{phase='New Moon';emoji='🌑';desc='Dark time, seed intention in silence';}

  return _moonResult(phase,emoji,desc,cyc,d,fraction,cycLength);
}

function _moonResult(phase,emoji,desc,cyc,d,fraction,cycLength){
  cyc=cyc||0;
  cycLength=cycLength||LUNAR;
  fraction=fraction!=null?fraction:(cyc/cycLength);
  const pct=Math.round(fraction*100);
  // Days until next named phase (rough)
  let toNew, toFull;
  if(fraction<=0.5){toFull=(0.5-fraction)*cycLength; toNew=(1-fraction)*cycLength;}
  else{toFull=(1.5-fraction)*cycLength; toNew=(1-fraction)*cycLength;}
  // Black Moon: 2 days BEFORE new moon (toNew between 0 and 2.0)
  const isBlack=toNew>=0&&toNew<=2.0&&fraction>0.9;
  // Shiva Moon: 1.0 to 2.5 days after new moon
  const isShiva=cyc>=1.0&&cyc<=2.5&&fraction<0.1;
  const isNewMoon=phase==='New Moon';
  const isFullMoon=phase==='Full Moon';
  return{phase,emoji,desc,cycle:cyc.toFixed(1),pct,toNew:toNew.toFixed(1),toFull:toFull.toFixed(1),
    isBlack,isShiva,isNewMoon,isFullMoon};
}

// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// DREAMSPELL, anchor 8 July 2024 = Kin 1 (Magnetic Red Dragon)
// AUTHORITATIVE SOURCE: Foundation for the Law of Time canonical
// Tzolkin start, used by StarRoot calculator and Tortuga 13:20.
// THREE-SOURCE VERIFICATION (6 May 2026):
//   - StarRoot (starroot.com): "kin 146 - May 4, 2026" (direct quote)
//   - Tortuga 13:20 (tortuga1320.com): explicitly endorses StarRoot
//   - Independent calculation from FOL anchor: 6 May 2026 = Kin 148
//   All three converge on Kin 148 Overtone Yellow Star for today.
//
// Cross-check anchors:
//   - 8 Jul 2024 = Kin 1 Magnetic Red Dragon (FOL Tzolkin start)
//   - 9 Jul 2024 = Kin 2 Lunar White Wind
//   - 4 May 2026 = Kin 146 Lunar Red Earth (matches StarRoot)
//   - 6 May 2026 = Kin 148 Overtone Yellow Star (today)
//
// Dreamspell rule: Feb 29 is "Day Out of Time" / Hunab Ku, NOT a Kin day.
// Skip it when computing days between dates. (Per lawoftime.org canon.)
//
// HISTORY:
//   - v32 (4 May 2026): server anchor was 31 Mar 2026 = Kin 52 (off by 75)
//   - v33 (5 May 2026): briefly used 26 Jul 2024 = Kin 144 (off by 135)
//   - v34 (6 May 2026): switched to FOL/StarRoot verified anchor, three
//     independent sources agreed. This is the canonical Dreamspell count.
// ══════════════════════════════════════════════════════════════════
const KIN_ANCHOR_D=new Date('2024-07-08T12:00:00Z');
const KIN_ANCHOR=1;
const SEALS=['Red Dragon','White Wind','Blue Night','Yellow Seed','Red Serpent',
  'White World-Bridger','Blue Hand','Yellow Star','Red Moon','White Dog',
  'Blue Monkey','Yellow Human','Red Skywalker','White Wizard','Blue Eagle',
  'Yellow Warrior','Red Earth','White Mirror','Blue Storm','Yellow Sun'];
const TONES=['Magnetic','Lunar','Electric','Self-Existing','Overtone','Rhythmic',
  'Resonant','Galactic','Solar','Planetary','Spectral','Crystal','Cosmic'];
const KIN_COLORS=['Red','White','Blue','Yellow','Red','White','Blue','Yellow','Red','White',
  'Blue','Yellow','Red','White','Blue','Yellow','Red','White','Blue','Yellow'];
const GAP=new Set([1,20,22,39,43,50,51,58,64,69,72,77,85,88,93,96,
  106,107,108,109,110,111,112,113,114,115,
  146,147,148,149,150,151,152,153,154,155,
  165,168,173,176,184,189,192,197,203,210,211,218,222,239,241,260]);

function getKin(dateStr){
  const d=new Date(dateStr+'T12:00:00Z');
  let days=Math.round((d-KIN_ANCHOR_D)/86400000);
  // Subtract Feb 29s falling between anchor and target (Dreamspell skips them)
  const startYear=KIN_ANCHOR_D.getUTCFullYear();
  const endYear=d.getUTCFullYear();
  const lo=Math.min(startYear,endYear),hi=Math.max(startYear,endYear);
  let leapAdj=0;
  for(let y=lo;y<=hi;y++){
    const isLeap=(y%4===0&&y%100!==0)||y%400===0;
    if(!isLeap) continue;
    const feb29=new Date(y+'-02-29T12:00:00Z');
    if(d>=KIN_ANCHOR_D&&feb29>KIN_ANCHOR_D&&feb29<=d) leapAdj--;
    else if(d<KIN_ANCHOR_D&&feb29<KIN_ANCHOR_D&&feb29>=d) leapAdj++;
  }
  days+=leapAdj;
  const kin=((KIN_ANCHOR-1+days)%260+260)%260+1;
  const si=(kin-1)%20;
  const ti=(kin-1)%13;
  const col=KIN_COLORS[si];
  // v34 fix: SEALS[si] already begins with the colour (e.g. "Blue Monkey"),
  // so prefixing ${col} caused duplication ("Kin 151 Blue Galactic Blue Monkey").
  // Correct format: "Kin {N} {Tone} {Color Seal}".
  return{kin,tone:TONES[ti],toneNum:ti+1,seal:SEALS[si],color:col,isGAP:GAP.has(kin),
    full:`Kin ${kin} ${TONES[ti]} ${SEALS[si]}`};
}

// Week-ahead helper
function getWeekAhead(startDateStr){
  const result=[];
  for(let i=0;i<7;i++){
    const d=new Date(startDateStr+'T12:00:00Z');
    d.setUTCDate(d.getUTCDate()+i);
    const ds=d.toISOString().slice(0,10);
    const k=getKin(ds);
    const[y,m,day]=ds.split('-').map(Number);
    const udRaw=m+day+String(y).split('').reduce((a,b)=>a+parseInt(b),0);
    let ud=udRaw;
    const masters=new Set([11,22,33,44]);
    while(ud>9&&!masters.has(ud))ud=String(ud).split('').reduce((a,b)=>a+parseInt(b),0);
    result.push({date:ds,dayStr:d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'numeric'}),kin:k.full,ud,isGAP:k.isGAP});
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════
// NUMEROLOGY, Three Energies of the Day
// Morning = Personal Day (microcosm, today's precise frequency)
// Afternoon = Personal Month (mid-range context, monthly arc)
// Evening = Personal Year (macrocosm, annual arc and life theme)
// Universal Day = reduce(day + month + year digits)
// Month Energy = reduce(month number)
// Year Energy = reduce(year digits)
// Special days: 7 (introspection/wisdom), 9 (completion/compassion)
// Master days: 11, 22, 33, 44, do NOT reduce further
// ══════════════════════════════════════════════════════════════════
function reduce(n){
  while(n>9&&n!==11&&n!==22&&n!==33&&n!==44)
    n=String(n).split('').reduce((a,b)=>a+parseInt(b),0);
  return n;
}
const NUM={
  1:{n:'New Beginnings',k:'Initiation · leadership · independence',
    morning:'Morning calls for bold initiation, begin something, assert your direction with confidence.',
    afternoon:'Afternoon sustains the initiating impulse. Push independently through resistance.',
    evening:'Evening resonates with independence. Reflect on what you have started and what leadership asks of you.'},
  2:{n:'Partnership',k:'Cooperation · balance · receptivity',
    morning:'Morning asks for deep listening and receptivity. Collaborate, do not compete.',
    afternoon:'Afternoon favours partnership decisions and sensitive negotiations.',
    evening:'Evening is for tending relationships, what balance needs restoring?'},
  3:{n:'Creative Expression',k:'Joy · communication · creative flow',
    morning:'Morning overflows with creative potential. Speak, write, create, the channel is open.',
    afternoon:'Afternoon sustains expressive momentum. Ideas multiply with sharing.',
    evening:'Evening calls for joyful communication, connect, share what is alive in you.'},
  4:{n:'Foundation & Order',k:'Structure · discipline · patient building',
    morning:'Morning energy is grounded and methodical. Lay foundations, build systems.',
    afternoon:'Afternoon rewards steady focus. Practical effort accumulates.',
    evening:'Evening consolidates what was built. Honour the discipline of the day.'},
  5:{n:'Freedom & Change',k:'Adventure · versatility · expansion',
    morning:'Morning sparks restlessness. Stay adaptable; the unexpected is the gift.',
    afternoon:'Afternoon accelerates change. Navigate rather than control.',
    evening:'Evening asks: what does freedom mean right now? Release rigidity.'},
  6:{n:'Love & Responsibility',k:'Harmony · family · service · care',
    morning:'Morning centres on care and responsibility. Home and relationship call for attention.',
    afternoon:'Afternoon sustains the energy of service and harmony.',
    evening:'Evening is deeply relational. Tend to those who matter most.'},
  7:{n:'Wisdom & Introspection',k:'Analysis · spiritual depth · truth-seeking',
    morning:'Morning is introspective and quiet. Inner work, research, and deep thinking are rewarded.',
    afternoon:'Afternoon opens the philosophical channel. Question beneath the surface.',
    evening:'Evening is for silence and contemplation. Answers come inward, not outward.'},
  8:{n:'Power & Abundance',k:'Authority · material mastery · accountability',
    morning:'Morning carries authority and material weight. Decisions today have consequence.',
    afternoon:'Afternoon amplifies executive capacity. Speak clearly, act decisively.',
    evening:'Evening is for taking stock, what has been built, what has been earned?'},
  9:{n:'Completion & Compassion',k:'Wisdom · generosity · release · universal love',
    morning:'Morning is open and cosmic. Special encounters and completions arrive unbidden.',
    afternoon:'Afternoon calls for generosity and letting go.',
    evening:'Evening is for release. Close cycles, forgive, and prepare for what is next.'},
  11:{n:'Master Illuminator',k:'Spiritual vision · intuition · higher purpose',master:true,
    morning:'Master Morning, the portals are open. Spiritual insight and high intuition are available before the noise of the day begins.',
    afternoon:'Master Afternoon, unusual clarity and vision. What is offered is rare.',
    evening:'Master Evening, integration of the day\'s revelations. Something important has arrived; be still enough to receive it.'},
  22:{n:'Master Builder',k:'Large-scale vision · practical idealism · manifestation',master:true,
    morning:'Master Morning, practical idealism at its peak. Major projects respond to clear, committed focus.',
    afternoon:'Master Afternoon, civilisational-scale energy is available. Build with intention.',
    evening:'Master Evening, reflect on what you are truly building over the long arc.'},
  33:{n:'Master Teacher',k:'Healing · compassion · selfless guidance',master:true,
    morning:'Master Morning, compassionate service and healing are amplified.',
    afternoon:'Master Afternoon, teach, guide, and give freely.',
    evening:'Master Evening, what has your generosity created today? Receive the reflection.'},
  44:{n:'Master Organiser',k:'Systemic mastery · material achievement · divine structure',master:true,
    morning:'Master Morning, structural clarity and material achievement are supported.',
    afternoon:'Master Afternoon, deep systems thinking opens. Pay close attention to business and money.',
    evening:'Master Evening, review the architecture of your long-term vision.'},
};

function getNumerology(dateStr,bDay,bMonth,bYear){
  const[y,m,d]=dateStr.split('-').map(Number);
  const udRaw=m+d+String(y).split('').reduce((a,b)=>a+parseInt(b),0);
  const ud=reduce(udRaw);
  const mEn=reduce(m);
  const yRaw=String(y).split('').reduce((a,b)=>a+parseInt(b),0);
  const yEn=reduce(yRaw);
  let lp=null,py=null,pm=null,pd=null;
  if(bDay&&bMonth&&bYear){
    lp=reduce(bDay+bMonth+String(bYear).split('').reduce((a,b)=>a+parseInt(b),0));
    py=reduce(bDay+bMonth+reduce(yRaw));
    pm=reduce(py+m);
    pd=reduce(pm+d);
  }
  // Three energies: morning=Personal Day (or UD if no birth), afternoon=Personal Month (or mEn), evening=Personal Year (or yEn)
  const morningNum = pd||ud;
  const afternoonNum = pm||mEn;
  const eveningNum = py||yEn;
  const threeEnergies = {
    morning: { num: morningNum, name: NUM[morningNum]?.n||'', desc: NUM[morningNum]?.morning||NUM[morningNum]?.k||'', isMaster: [11,22,33,44].includes(morningNum) },
    afternoon: { num: afternoonNum, name: NUM[afternoonNum]?.n||'', desc: NUM[afternoonNum]?.afternoon||NUM[afternoonNum]?.k||'', isMaster: [11,22,33,44].includes(afternoonNum) },
    evening: { num: eveningNum, name: NUM[eveningNum]?.n||'', desc: NUM[eveningNum]?.evening||NUM[eveningNum]?.k||'', isMaster: [11,22,33,44].includes(eveningNum) },
  };
  const isMasterDay=[11,22,33,44].includes(ud);
  const isSpecialDay=[7,9].includes(ud); // 7=introspection, 9=completion, always noteworthy
  return{ud,udM:NUM[ud],mEn,mEnM:NUM[mEn],yEn,yEnM:NUM[yEn],
    lp,lpM:lp?NUM[lp]:null,py,pyM:py?NUM[py]:null,
    pm,pmM:pm?NUM[pm]:null,pd,pdM:pd?NUM[pd]:null,
    threeEnergies,isMasterDay,isSpecialDay,
    ud3: (() => {
      try { return threeLayerNumerology(dateStr); } catch(e) { return null; }
    })()
  };
}

// ══════════════════════════════════════════════════════════════════
// ASPECTS
// ══════════════════════════════════════════════════════════════════
const ASPS=[
  {n:'conjunction',d:0,orb:8,sym:'☌'},
  {n:'opposition',d:180,orb:8,sym:'☍'},
  {n:'trine',d:120,orb:7,sym:'△'},
  {n:'square',d:90,orb:7,sym:'□'},
  {n:'sextile',d:60,orb:5,sym:'⚹'},
];

function getAspects(planets){
  const out=[];
  for(let i=0;i<planets.length;i++){
    for(let j=i+1;j<planets.length;j++){
      let diff=Math.abs(planets[i].deg-planets[j].deg);
      if(diff>180)diff=360-diff;
      for(const a of ASPS){
        const orb=Math.abs(diff-a.d);
        if(orb<=a.orb){
          const str=Math.max(1,5-Math.floor(orb/(a.orb/5)));
          out.push({p1:planets[i].name,p2:planets[j].name,aspect:a.n,sym:a.sym,
            orb:orb.toFixed(1),str,
            label:`${planets[i].name} ${a.sym} ${planets[j].name}`,
            desc:`${planets[i].name} ${getDegInSign(planets[i].deg)}° ${getSign(planets[i].deg)} ${a.n} ${planets[j].name} ${getDegInSign(planets[j].deg)}° ${getSign(planets[j].deg)} (${orb.toFixed(1)}° orb)`});
          break;
        }
      }
    }
  }
  return out.sort((a,b)=>b.str-a.str).slice(0,8);
}

// ══════════════════════════════════════════════════════════════════
// ATTACHMENT BLOCKS: turn brought-in files into model content blocks
// ══════════════════════════════════════════════════════════════════
// The Compass and the Oracle ask let a person bring in an image, a PDF,
// or a text file so the reply can consider it. The client sends a small
// wire shape; this builder validates it server-side (the client cannot be
// trusted) and returns Anthropic content blocks. Count, size, and media
// type are all bounded here. Anything unknown or oversized is skipped.
const ATT_MAX_FILES = 4;
const ATT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ATT_B64_MAX = 6_800_000;   // base64 chars, about 5MB of binary
const ATT_TEXT_MAX = 20000;      // characters of a brought-in text file

function buildAttachmentBlocks(attachments) {
  const blocks = [];
  if (!Array.isArray(attachments)) return blocks;
  let count = 0;
  for (const a of attachments) {
    if (count >= ATT_MAX_FILES) break;
    if (!a || typeof a !== 'object') continue;
    const name = (typeof a.name === 'string' ? a.name : 'attachment').slice(0, 200);
    if (a.kind === 'image') {
      if (typeof a.data !== 'string' || a.data.length === 0 || a.data.length > ATT_B64_MAX) continue;
      const mt = ATT_IMAGE_TYPES.includes(a.mediaType) ? a.mediaType : 'image/png';
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mt, data: a.data } });
      count += 1;
    } else if (a.kind === 'document') {
      if (typeof a.data !== 'string' || a.data.length === 0 || a.data.length > ATT_B64_MAX) continue;
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
      count += 1;
    } else if (a.kind === 'text') {
      if (typeof a.textContent !== 'string' || a.textContent.length === 0) continue;
      const text = a.textContent.slice(0, ATT_TEXT_MAX);
      blocks.push({ type: 'text', text: 'Attached file "' + name + '":\n\n' + text });
      count += 1;
    }
  }
  return blocks;
}

// Compose a user message that may carry attachments. When there are none, the
// plain string is returned, preserving the existing behaviour exactly.
function userContentWith(text, attachments) {
  const blocks = buildAttachmentBlocks(attachments);
  if (blocks.length === 0) return text;
  return [{ type: 'text', text }].concat(blocks);
}

// A register-aware reflection instruction, used wherever a reply may carry
// brought-in files. The person handed the Oracle something they are carrying;
// the Oracle meets it, it does not summarise or process a file. It reads what
// was brought through the lens of the day, the coordinates, and what the person
// is holding, and it answers in the active voice. The register of the file sets
// the register of the reflection.
function attachmentReflectionNote(count) {
  const noun = count === 1 ? 'a file' : count + ' files';
  return '\n\nThe person has handed you ' + noun + ' (an image, a document, or text), not for you to summarise but to meet. ' +
    'Look at what it actually contains and let your reply speak to it concretely, read through the lens of the day, the coordinates, and what the person is holding. ' +
    'Match the register of what was brought in: a deck or document invites clear, strategic reflection with only a light touch of the day energy; an image invites what it shows and what it carries; a worried or personal note invites holding before anything else. ' +
    'Speak in the active voice. Do not describe the file mechanically, and do not let it expand the length your voice already requires.';
}

// ══════════════════════════════════════════════════════════════════
// THE FIX: STREAMING API CALL
// ══════════════════════════════════════════════════════════════════
function callAPI(model, maxTok, sys, user, hardCapMs) {
  // hardCapMs (optional): per-call ceiling for total stream time.
  // Defaults to 180000 (matches v22h behaviour). Orchestrator passes 90000
  // for individual section calls. Inactivity socket timeout stays at 75s.
  const _hardCapValue = (typeof hardCapMs === 'number' && hardCapMs > 0)
                        ? hardCapMs : 180000;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: maxTok,
      stream: true,
      messages: [{role: 'user', content: user}],
      ...(sys ? {system: sys} : {})
    });

    let resolved = false;
    const req = https.request({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let buffer = '';
      let fullText = '';

      // Check for non-200 HTTP status (overloaded, auth error etc)
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', d => errBody += d.toString());
        res.on('end', () => {
          if (!resolved) {
            resolved = true;
            const msg = res.statusCode === 529 ? 'overloaded'
              : res.statusCode === 401 ? 'invalid_api_key'
              : `http_${res.statusCode}`;
            reject(new Error(msg + ': ' + errBody.slice(0, 100)));
          }
        });
        return;
      }

      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const evt = JSON.parse(data);
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              fullText += evt.delta.text;
            } else if (evt.type === 'message_stop') {
              if (!resolved) { resolved = true; resolve(fullText); }
            } else if (evt.error) {
              if (!resolved) { resolved = true; reject(new Error(evt.error.message || JSON.stringify(evt.error))); }
            }
          } catch(e) { /* partial JSON line, skip */ }
        }
      });

      res.on('end', () => {
        if (!resolved) { resolved = true; resolve(fullText); }
      });

      res.on('error', err => {
        if (!resolved) { resolved = true; reject(err); }
      });
    });

    req.on('error', err => reject(err));

    // v22h: tighter inactivity timeout (was 240s).
    // If no data arrives for 75 seconds the call is not coming back.
    req.setTimeout(75000, () => {
      req.destroy(new Error('Socket timeout after 75s'));
    });

    // v22h: hard total-request ceiling. Even if data is trickling slowly
    // enough to keep the inactivity timeout from firing, abort after the
    // configured hardCapMs (default 180s, 90s for orchestrator sections).
    // This bounds worst-case wall time for a single LLM call and was the
    // most likely cause of the multi-tens-of-minutes hangs that bypassed
    // the inactivity timeout.
    const _hardCap = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { req.destroy(new Error('Hard timeout after ' + Math.round(_hardCapValue/1000) + 's, aborting slow stream')); } catch(e) {}
        reject(new Error('hard_timeout_' + Math.round(_hardCapValue/1000) + 's'));
      }
    }, _hardCapValue);
    // Clear hardCap when the request resolves successfully or errors out
    req.on('close', () => clearTimeout(_hardCap));

    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════
// BETA 2, PROFILE CONTEXT BUILDER
// Converts user profile + reading history into a rich Oracle brief.
// Called by generateReading(), replaces the old ad-hoc profileBlock.
// ══════════════════════════════════════════════════════════════════
// Normalise saved Vessel profile fields (model.ts StoredProfile) to the names
// buildProfileContext and the compatibility route already read. Additive and
// backward compatible: a legacy field is never overwritten, nothing is dropped,
// so a profile that only carries the old shape reads exactly as before.
function normaliseProfileFields(p) {
  if (!p || typeof p !== 'object') return p;
  const n = Object.assign({}, p);
  if (n.birthDate && (!n.birthYear || !n.birthMonth || !n.birthDay)) {
    const m = String(n.birthDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      n.birthYear = n.birthYear || Number(m[1]);
      n.birthMonth = n.birthMonth || Number(m[2]);
      n.birthDay = n.birthDay || Number(m[3]);
    }
  }
  if (!n.birthLocation && n.birthPlace) n.birthLocation = n.birthPlace;
  if (!n.name && n.fullName) n.name = n.fullName;
  if (!n.relationships && n.keyPeople) n.relationships = n.keyPeople;
  if (!n.active_threads && n.projects) n.active_threads = n.projects;
  if (!n.intentions && n.currentIntentions) n.intentions = n.currentIntentions;
  return n;
}

function buildProfileContext(p, recentHistory = [], yesterdayIntention = null) {
  if (!p || Object.keys(p).length === 0) return 'No personal profile provided, give a universal reading grounded in the cosmic data.';

  p = normaliseProfileFields(p);

  const lines = [];

  // Name
  const userName = p.name || p.nickname || 'the reader';
  const firstName = p.nickname || (p.name ? p.name.split(' ')[0] : 'you');
  lines.push(`Name: ${userName}`);

  // Location
  if (p.location) lines.push(`Current Location: ${p.location}`);

  // Birth
  if (p.birthDay && p.birthMonth && p.birthYear) {
    lines.push(`Date of Birth: ${p.birthDay}/${p.birthMonth}/${p.birthYear}${p.birthTime ? ' at ' + p.birthTime : ''}${p.birthLocation ? ', born in ' + p.birthLocation : ''}`);
  }
  if (p.birthLocation) lines.push(`Place of Birth: ${p.birthLocation}`);

  // ── BETA 2: ENRICHED LIFE CONTEXT ──
  // Professional roles
  const roles = p.roles || [];
  if (roles.length > 0) {
    const rolesStr = Array.isArray(roles) ? roles.join(', ') : roles;
    lines.push(`Current roles: ${rolesStr}`);
  }

  // Key relationships
  const rels = p.relationships || {};
  if (typeof rels === 'object' && Object.keys(rels).length > 0) {
    const relStr = Object.entries(rels)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('; ');
    lines.push(`Key relationships: ${relStr}`);
  } else if (typeof rels === 'string' && rels.trim()) {
    lines.push(`Key relationships: ${rels}`);
  }

  // Active threads
  const threads = p.active_threads || p.activeThreads || [];
  if (threads.length > 0) {
    const threadStr = Array.isArray(threads) ? threads.join(', ') : threads;
    lines.push(`Active chapters / projects: ${threadStr}`);
  }

  // Intentions
  const intentions = p.intentions || [];
  if (intentions.length > 0) {
    const intentStr = Array.isArray(intentions) ? intentions.join(', ') : intentions;
    lines.push(`Current intentions: ${intentStr}`);
  }

  // Free-form context (existing field, preserved)
  if (p.context) lines.push(`Personal context: ${p.context}`);

  // Today's intention
  if (p.intention) lines.push(`Today's intention: ${p.intention}, weave this into the synthesis, priorities, and shadow work.`);

  // Hormonal phase (client-computed, privacy-safe, no raw dates sent, just phase name and Oracle guidance)
  if (p.cycleContext) {
    lines.push('');
    lines.push('HORMONAL PHASE (today): ' + p.cycleContext);
    lines.push('Integrate this meaningfully, hormonal phases are a legitimate biological rhythm that shapes energy, decision-making capacity, emotional sensitivity, and relational needs today. Reference it specifically in time windows, priorities, and shadow work.');
  }

  // Biorhythm today (if birth date available, calculate server-side)
  if (p.birthDay && p.birthMonth && p.birthYear) {
    const bDate = p.birthYear + '-' + String(p.birthMonth).padStart(2,'0') + '-' + String(p.birthDay).padStart(2,'0');
    const today = new Date().toISOString().slice(0,10);
    try {
      const bio = getBiorhythms(bDate, today);
      const bioLine = 'BIORHYTHMS TODAY: Physical ' + (bio.physical.pct > 0 ? '+' : '') + bio.physical.pct + '% (' + bio.physical.phase + ')'
        + ', Emotional ' + (bio.emotional.pct > 0 ? '+' : '') + bio.emotional.pct + '% (' + bio.emotional.phase + ')'
        + ', Intellectual ' + (bio.intellectual.pct > 0 ? '+' : '') + bio.intellectual.pct + '% (' + bio.intellectual.phase + ')'
        + ', Composite: ' + (bio.composite > 0 ? '+' : '') + bio.composite + '%.'
        + (bio.physical.isCritical ? ' Physical critical day.' : '')
        + (bio.emotional.isCritical ? ' Emotional critical day.' : '')
        + (bio.intellectual.isCritical ? ' Intellectual critical day.' : '');
      lines.push('');
      lines.push(bioLine);
      lines.push('Reference biorhythm state in time windows and energy guidance. Critical days (zero crossings) are transition points requiring particular care.');
    } catch(e) { /* biorhythm calculation failed, skip */ }
  }

  // ── BETA 2: READING HISTORY CONTINUITY ──
  // Inject last 3 reading summaries for genuine cross-session continuity
  if (recentHistory && recentHistory.length > 0) {
    lines.push('');
    lines.push('RECENT SESSIONS, use for continuity and pattern recognition:');
    recentHistory.slice(0, 3).forEach((h, i) => {
      const label = i === 0 ? 'Most recent reading' : `${i + 1} sessions ago`;
      const date = h.reading_date || h.date || '';
      const summary = h.summary || h.synthesis || '';
      if (summary) lines.push(`${label}${date ? ' (' + date + ')' : ''}: ${summary.slice(0, 400)}`);
      if (h.shadow_work) lines.push(`  Shadow question that session: ${h.shadow_work.slice(0, 200)}`);
      if (h.priority_1) lines.push(`  Primary focus: ${h.priority_1}`);
    });
    lines.push('');
  }

  // ── v22 memory continuity: yesterday's intention threads into today ──
  // The user typed an intention into the compass yesterday (or earlier today).
  // The Oracle should reference it explicitly. "Yesterday you focused on X.
  // Today asks about Y. Here is how they connect." This is the continuity surface.
  if (yesterdayIntention && typeof yesterdayIntention === 'string' && yesterdayIntention.trim()) {
    lines.push('');
    lines.push('YESTERDAY THE USER TYPED THIS INTENTION INTO THE COMPASS:');
    lines.push(`  "${yesterdayIntention.trim().slice(0, 240)}"`);
    lines.push('Reference it briefly in the synthesis or first priority. Make the bridge explicit. The user should feel that today is in conversation with yesterday, not a fresh shuffle of cards.');
    lines.push('');
  }

  return lines.filter(Boolean).join('\n');
}

// ══════════════════════════════════════════════════════════════════
// ORACLE READING, FULL SCHEMA, FULL QUALITY, BENCHMARK STANDARD
// ══════════════════════════════════════════════════════════════════
async function generateReading(dateStr, profile = {}, tier = 'oracle', recentHistory = [], _planets, _moon, _kin, _num, _aspects, _yesterdayIntention = null, jobId = null) {
  // Early abort: if job has been marked as errored (deadline), stop immediately
  if (jobId && !isJobStillValid(jobId)) {
    throw new Error('job_cancelled_by_deadline');
  }
  
  const _langNote = (profile && profile.readingLang === 'modern')
    ? '\n\nLANGUAGE MODE. MODERN SCIENTIFIC. The cosmic inputs (Dreamspell seal and tone, Kin number, personal year, personal day, transits, lunar phase) are scaffolding for you only. They must NEVER appear in the output. Do not write seal or tone names such as Red Dragon, White Wind, Crystal, Overtone. Do not write a Kin number. Do not write "personal year" or "personal day" or any bare numerology label. A line like "Crystal Red Dragon in year 22" is a failure, because it names a symbol the reader cannot act on. Instead, translate each input into one concrete, observable thing about today that the reader can do something with, then, only where it earns its place, ground that observation in plain mechanism (numerology as salience and priming, lunar phase as circadian and sleep pressure, shadow work as interoceptive signal per Barrett 2017, transits as a shift in what feels predictable). Lead every point with the observation, not the mechanism. A bare mechanism term dropped as a label ("hippocampal consolidation", "default mode network") is also a failure. If a translated line would say nothing the reader could not already feel, cut it.'
    : '';
  // Accept pre-calculated data from two-phase flow to avoid recalculating
  const planets = _planets || buildPlanets(dateStr);
  const moon = _moon || getMoon(dateStr);
  const kin = _kin || getKin(dateStr);
  const p = profile || {};
  const num = _num || getNumerology(dateStr, p.birthDay, p.birthMonth, p.birthYear);
  const aspects = _aspects || getAspects(planets);
  const weekAhead = getWeekAhead(dateStr);

  // ── DYNAMIC PROFILE, Beta 2: uses buildProfileContext ──
  const firstName = p.nickname || (p.name ? p.name.split(' ')[0] : 'you');
  const profileBlock = buildProfileContext(p, recentHistory, _yesterdayIntention);

  // Build birth kin string from calculated num
  const birthKinStr = num.birthKin ? `Kin ${num.birthKin.kin}: ${num.birthKin.full}` : 'not calculated';

  const pTable = planets.map(pl => `${pl.name}: ${pl.degStr}`).join('\n');
  const aList = aspects.slice(0,6).map(a => `${'●'.repeat(a.str)}${'○'.repeat(5-a.str)} ${a.desc}`).join('\n');

  const moonAlert = moon.isBlack
    ? `★ BLACK MOON (2 days before New Moon), tricky, introspective threshold. ${firstName} should not initiate major actions today; observe and prepare instead.`
    : moon.isShiva
      ? `★ SHIVA MOON (2 days after New Moon), blissful, regenerative. Auspicious for new actions, new conversations, and fresh starts for ${firstName}.`
      : '';

  const satNep = `Saturn ${planets[6].degStr} conjunct Neptune ${planets[8].degStr}, historically significant (Tarnas 2006): last Aries conjunction ~1522 (Magellan circumnavigation, Luther's Reformation), then 1917 (WWI/Russian Revolution), 1952, 1989 (Berlin Wall fall). In Aries = genesis, not reform. Dissolution of old structures meeting new idealism.`;

  const uranus = `Uranus ${planets[7].degStr}, approaching Gemini ingress ~April 26 2026. Financial structures, communication architectures, and valuations disrupted and liberated.`;

  const mars = planets[4].sign === 'Pisces'
    ? `Mars ${planets[4].degStr}, in Pisces, drive is inward and visionary. Physical energy best metabolised through creative and strategic work rather than force.`
    : `Mars ${planets[4].degStr}, in Aries, drive is ignited. Decisive action rewarded. Watch for overextension.`;

  const weekAheadJSON = weekAhead.map((w,i) => i===0
    ? `{"date":"${w.date}","day":"${w.dayStr}","kin":"${w.kin}","ud":${w.ud},"isGAP":${w.isGAP},"note":"<Today, 2-sentence summary>"}`
    : `{"date":"${w.date}","day":"${w.dayStr}","kin":"${w.kin}","ud":${w.ud},"isGAP":${w.isGAP},"note":"<2-sentence personalised note for ${firstName}, Dreamspell tone + UD meaning + practical pointer>"}`
  ).join(',\n    ');

  // ── TIER-SPECIFIC SCOPE ──
  const tierScope = {
    free: `TIER: Free. Generate ONLY: synthesis (1 sentence), Universal Day number + name + one sentence meaning, moon phase + sign, today's Kin, one "For Today" action. JSON must have: synthesis, numerology:{headline, body(1 paragraph)}, moon_section:{headline, body(1 paragraph)}, dreamspell:{headline}, closing_line. Nothing else. Keep total output under 500 tokens.`,
    seeker: `TIER: Seeker. Generate a focused reading. Required JSON fields: synthesis (3 sentences), numerology:{headline,body(2 sentences),three_energies:{morning,afternoon,evening each with num+name+guidance}}, moon_section:{headline,body(2 sentences)}, astrology:{main_transit_headline,main_transit_body(2 sentences)}, dreamspell:{headline,body(2 sentences)}, priorities:[3 items with title+rationale(2 sentences)+action], shadow_work(2 sentences), focus_on:[4 items], ease_off:[4 items], time_windows:{morning,afternoon,evening each 1 sentence}, closing_line, sources. NO week_ahead. NO daily_gift. Total output under 1800 tokens.

CITATION REQUIREMENT (mandatory): Mention author-year in prose for 4 to 6 specific claims across the reading. Examples that you MUST use where the topic arises: numerology body should cite Drayer 2002 or Kahn 2001; moon section circadian claims cite Cajochen 2013; astrology body cite Tarnas 2006 or Greene 1976 for symbolic claims; dreamspell body cite Argüelles 1987 for the modern Dreamspell system; shadow_work neuroscience cite Barrett 2017 or Bremer 2022; default mode network cite Bremer 2022; sleep cite Walker 2017; interoception cite Craig 2002. Write authors directly inline in the prose, like: "as Tarnas 2006 explored..." or "Drayer 2002 names this..." or "(Bremer 2022)". The server wraps these as tappable citations automatically.`,
    initiate: `TIER: Initiate. Generate full reading with all fields except: omit daily_gift.meditation and deep saturn_neptune historical analysis. Keep prose fields to 3 sentences each. Include week_ahead.

CITATION REQUIREMENT (mandatory): Mention author-year in prose for 6 to 10 specific claims across the reading. Numerology body cite Drayer 2002 or Kahn 2001; moon and circadian claims cite Cajochen 2013 or Cajochen and Schmidt 2024; astrology body cite Tarnas 2006 or Greene 1976 or Hand 2002; dreamspell body cite Argüelles 1987 (modern Dreamspell system, distinct from ancient Maya per Tedlock 1992); shadow_work and emotional claims cite Barrett 2017 or Bremer 2022; sleep cite Walker 2017; interoception cite Craig 2002; polyvagal autonomic cite Porges 2011. Write authors directly inline: "Tarnas 2006 explored..." or "(Drayer 2002)". The server wraps these as tappable citations automatically.`,
    mystic: `TIER: Mystic. Generate complete reading with all fields. Include natal chart context. Keep prose fields to 3-4 sentences. Full week_ahead. Full daily_gift.

CITATION REQUIREMENT (mandatory): Mention author-year in prose for 8 to 14 specific claims across the reading, distributed across sections. Required citations by section: numerology body must cite Drayer 2002 or Kahn 2001 or Riedweg 2005; moon and circadian must cite Cajochen 2013 and Cajochen and Schmidt 2024; astrology body must cite Tarnas 2006 and Greene 1976 and Hand 2002; dreamspell body must cite Argüelles 1987 (label as modern Dreamspell, distinct from ancient Maya per Tedlock 1992); peer-reviewed Maya astronomy cite Sprajc 2023 or Aldana 2022 or Aveni 2001; shadow_work cite Barrett 2017 and Bremer 2022; sleep cite Walker 2017; interoception cite Craig 2002; polyvagal cite Porges 2011; psychoneuroimmunology cite Bower and Kuhlman 2023 or Mengelkoch 2023; predictive processing cite Clark 2016; sceptical balance for astrology cite Carlson 1985. Write authors directly inline: "as Tarnas 2006 explored..." or "the default mode network (Bremer 2022) is most active..." The server wraps these as tappable citations automatically.`,
    oracle: `TIER: Oracle. This is the bespoke Oracle experience. The benchmark is a 25-30 page printed document. Every prose field must be FULL and RICH with multiple paragraphs. Minimum depth requirements:
- synthesis: 3-4 sentences, all four frameworks named
- numerology body: 4 full paragraphs. Universal Day, Life Path resonance, Personal Day shadow, Personal Month pressure
- moon body: 3 full paragraphs, phase quality, sign placement, exact aspects involving Moon, lunation cycle context
- main transit body: 4 full paragraphs, exact orb, peak timing, historical parallel cite Tarnas 2006 or Hand 2002 (write inline as "Tarnas 2006 explored..."), personal application
- saturn_neptune: 3 full paragraphs, civilisational context, sectoral impact, personal demand (cite Tarnas 2006)
- dreamspell body: 3 full paragraphs. Tone quality, Seal gifts, GAP amplification if applicable, wavespell position (label as Argüelles 1987 modern system)
- Each aspect: 4-5 sentences with orb, timing, personal application
- shadow_work: 4-5 italic sentences, psychologically precise, no generalities
- Each priority: 4-sentence rationale + specific concrete action
- time windows: 4-5 sentences each, numerology + astrology + Kin converging
- week_ahead: 7 days, 3-sentence personalised notes per day
- daily_gift: meditation + quote + attribution
Do NOT truncate any field. Every field in the JSON schema populated to maximum depth.

CITATION REQUIREMENT (mandatory for Oracle tier): 10 to 18 author-year citations across the reading. Required: numerology cite Drayer 2002, Kahn 2001, Riedweg 2005; moon Cajochen 2013, Cajochen and Schmidt 2024; astrology Tarnas 2006, Greene 1976, Hand 2002, Brennan 2017, Campion 2008; Maya peer-reviewed Sprajc 2023, Aldana 2022, Aveni 2001; dreamspell Argüelles 1987 (modern system), Tedlock 1992 (distinct living count); neuroscience Bremer 2022, Barrett 2017, Walker 2017, Craig 2002, Porges 2011, Clark 2016; PNI Bower and Kuhlman 2023, Mengelkoch 2023; sceptical balance Carlson 1985 and Hartmann 2006 where astrology mechanism is discussed. Write each author-year inline in the prose naturally. The server wraps these as tappable citations automatically.`
  };
  // standard mode in frontend maps to 'oracle' tier for full depth
  // Three-voice architecture: append to system prompt for oracle tier
  // v22 magazine model: three voices available at every tier, not just Oracle/Mystic.
  // The toggle and cross-voice nudges are the engagement loop, free to all users.
  // v34 (6 May 2026 evening): gate removed. Previously was
  //   (tier === 'free' || tier === 'quick') ? '' : THREE_VOICE_INSTRUCTION
  // which contradicted the comment's stated intent and meant magazine cross-voice
  // chips never appeared in quick or free readings, the very tiers where the
  // engagement loop matters most. Now generates three voices for everyone.
  const voiceInstruction = THREE_VOICE_INSTRUCTION;
  
  // ═══════════════════════════════════════════════════════════════════════════
  // iter12d: bibliography integration into the Reading prompt.
  // 
  // Until iter12d, the Reading flow had a textual "sources" line at the end
  // of the JSON schema but no structured reference plumbing. Citations were
  // present in the chip-tap drawer (iter12) but missing from the main Reading,
  // which is the substantive output users pay for.
  // 
  // iter12d wires bibliography.json into the Reading prompt with a tier-scaled
  // reference catalogue. Higher tiers get more references; the Oracle tier
  // gets the full set. The model is instructed to wrap inline citations using
  // the same <span class="v11-cite" data-ref="..."> markers as the drawer,
  // so the frontend renders citation popovers in the Reading the same way it
  // does in the drawer.
  // ═══════════════════════════════════════════════════════════════════════════
  let cdpReferencesBlock = '';
  let cdpCitationInstruction = '';
  if (CDP_BIBLIOGRAPHY && CDP_BIBLIOGRAPHY.entries && tier !== 'free') {
    const refLimit = {seeker: 12, initiate: 18, mystic: 24, oracle: 39}[tier] || 18;
    const tracksCycle = !!(p && p.tracksCycle === true && p.cycleContext);
    
    // Core references always included: peer-reviewed neuroscience, scholarly
    // astrology and Maya literature, numerology lineage, PNI synthesis, and
    // sceptical counterweights. Order matters for tier-limited slicing.
    const coreRefIds = [
      // Foundation
      'craig-2002',       // Interoception
      'porges-2011',      // Polyvagal
      'walker-2017',      // Sleep
      'barrett-2017',     // Constructed emotion
      'bremer-2022',      // DMN/salience
      'clark-2016',       // Predictive processing
      // Circadian
      'cajochen-2013',
      'cajochen-schmidt-2024',
      // Astrology scholarship
      'tarnas-2006',
      'greene-1976',
      // Maya scholarship (peer-reviewed)
      'sprajc-2023',
      'aldana-2022',
      'aveni-2001',
      // Dreamspell
      'arguelles-1987',
      'tedlock-1992',
      // Numerology lineage
      'drayer-2002',
      'kahn-2001',
      'riedweg-2005',
      // PNI
      'bower-kuhlman-2023',
      'mengelkoch-2023',
      // Sceptical balance, intellectual honesty
      'carlson-1985',
      'hartmann-2006',
      'van-dam-2018',
      // Authoritative data
      'usno',
      'law-of-time'
    ];
    
    // Add cycle-specific refs when user has opted in
    const cycleRefIds = [
      'hill-2019',
      'pope-wurlitzer-2017',
      'klusmann-2023',
      'baker-lee-2023',
      'riley-1999',
      'lange-2024',
      'jang-2025'  // The bounded null - critical for honest cycle commentary
    ];
    
    let candidateRefs = coreRefIds.slice();
    if (tracksCycle) {
      candidateRefs = candidateRefs.concat(cycleRefIds);
    }
    
    // Filter to refs that actually exist in bibliography.json (defensive)
    const validRefs = candidateRefs.filter(r => CDP_BIBLIOGRAPHY.entries[r]);
    const finalRefs = validRefs.slice(0, refLimit);
    
    const entryLines = finalRefs.map(refId => {
      const e = CDP_BIBLIOGRAPHY.entries[refId];
      const authors = Array.isArray(e.authors)
        ? e.authors.slice(0, 2).join(' and ') + (e.authors.length > 2 ? ' et al' : '')
        : (e.authors || 'Unknown');
      const where = e.journal || e.publisher || e.source || '';
      const title = (e.title || '').slice(0, 90);
      return '  ' + refId + ': ' + authors + ' (' + e.year + '). ' + title + (where ? '. ' + where : '');
    });
    
    cdpReferencesBlock = '\n\nAVAILABLE REFERENCES for inline citation:\n' + entryLines.join('\n') + '\n';
    
    const minCites = {seeker: 4, initiate: 6, mystic: 8, oracle: 10}[tier] || 6;
    const maxCites = {seeker: 8, initiate: 12, mystic: 16, oracle: 20}[tier] || 12;
    
    cdpCitationInstruction = '\n\n═══ AUTHOR ATTRIBUTION REQUIREMENT ═══\n' +
      'Your prose MUST explicitly mention the following authors and years inline, by name, ' +
      'where their work supports a claim you make. This is required for scholarly integrity ' +
      'and is a HARD requirement, not a guideline.\n\n' +
      'You must include between ' + minCites + ' and ' + maxCites + ' inline author-year mentions ' +
      'distributed across the Reading sections, drawn from the AVAILABLE REFERENCES list above.\n\n' +
      'EXAMPLES of correct inline format (any of these patterns work):\n' +
      '  - "as Bremer 2022 describes, the default mode network..."\n' +
      '  - "the practitioner framework (Hill 2019) calls this inner winter"\n' +
      '  - "per Walker 2017, sleep consolidates..."\n' +
      '  - "Tarnas 2006 explored Saturn-Neptune cycles"\n' +
      '  - "Klusmann et al 2023 documented HPA reactivity"\n' +
      '  - "Pope and Wurlitzer 2017 frame this as..."\n\n' +
      'WRITE THE AUTHORS DIRECTLY INTO YOUR PROSE. The server-side post-processor will ' +
      'wrap each author-year mention as a tappable citation marker automatically. ' +
      'You do not need to add HTML span tags yourself, just write the author and year as ' +
      'natural inline text.\n\n' +
      'WHICH AUTHORS TO CITE:\n' +
      '- Neuroscience claims (DMN, sleep, emotion, predictive processing): Bremer 2022, Walker 2017, Barrett 2017, Craig 2002, Clark 2016\n' +
      '- Circadian or lunar physiology: Cajochen 2013, Cajochen and Schmidt 2024\n' +
      '- Astrology (symbolic): Tarnas 2006, Greene 1976\n' +
      '- Astrology empirical limits (when Science voice or sceptic context): Carlson 1985, Hartmann 2006\n' +
      '- Maya astronomy (peer-reviewed): Sprajc 2023, Aldana 2022, Aveni 2001\n' +
      '- Dreamspell (modern symbolic system): Arguelles 1987\n' +
      '- Living Maya tradition: Tedlock 1992\n' +
      '- Numerology lineage: Drayer 2002, Kahn 2001, Riedweg 2005\n' +
      '- Psychoneuroimmunology: Bower and Kuhlman 2023, Mengelkoch 2023\n' +
      '- Polyvagal/autonomic: Porges 2011\n';
    if (tracksCycle) {
      cdpCitationInstruction += '- Menstrual cycle (with explicit user opt-in): Hill 2019, Pope and Wurlitzer 2017 (practitioner literature), Klusmann 2023 (HPA reactivity), Baker and Lee 2023 (sleep architecture), Riley 1999 (pain), Lange 2024 (PMDD), Jang 2025 (BOUNDED NULL on cognitive performance, always cite alongside positive findings for intellectual honesty)\n';
    }
    cdpCitationInstruction += '\n' +
      'BEFORE COMPLETING the JSON, verify that your prose contains ' + minCites + ' to ' + maxCites + ' ' +
      'inline author-year mentions. Count them. If fewer, add more where claims warrant.\n' +
      '═══════════════════════════════════════════════\n';
  }

  const scope = tierScope[tier] || tierScope.oracle;

  const sys = `You are the Oracle at Cosmic Daily Planner (cosmicdailyplanner.com), a rigorous, personalised daily cosmic planner synthesising Swiss Ephemeris astronomy, Pythagorean numerology, Western psychological astrology, and Dreamspell/Law of Time.${_langNote}

YOUR VOICE: The best Jungian analyst meets the Swiss Ephemeris. Precise. Personal. Grounded. Emotionally intelligent.

${scope}

CRITICAL RULES:
- Use ONLY the Swiss Ephemeris positions provided. Never invent planetary data.
- Address the reader by their first name (${firstName}) throughout. Use ONLY the personal context they have provided, do not invent details about their life.
- If personal context is provided (companies, family, projects, relationships, roles, active threads), reference it specifically and by name. If not provided, speak universally but still specifically to the cosmic weather.
- If RECENT SESSIONS are provided in the profile, use them for genuine continuity: reference what was present before, notice patterns, acknowledge what has shifted. The Oracle has memory.
- Dreamspell is ALWAYS labelled: Argüelles (1987) The Mayan Factor, modern 20th-century system, distinct from ancient K'iche' Maya tradition maintained by Guatemalan daykeepers.
- No deterministic predictions. Speak in possibilities and tendencies.
- Every section must be grounded in the actual planetary data and personal context provided.
- BIORHYTHMS: If BIORHYTHMS TODAY is present in the profile, integrate it meaningfully. A physical score below -60% means depleted vitality (flag it in time windows and priorities. A critical day (zero crossing) is a transition requiring care. Do not merely mention it) let it shape the energy guidance concretely.
- HORMONAL PHASE: If HORMONAL PHASE is present, treat it as a legitimate biological rhythm equal in weight to moon phase. Reference it in time windows, priorities, and shadow work, speak to how this phase shapes energy, decision-making, and relational sensitivity today.
- NATAL vs TRANSIT: Always distinguish clearly. Say "today's Moon is in X" or "the Moon transits X today" for current sky positions. Say "your natal Moon in X" for birth chart placements. Never conflate the two, this confusion destroys credibility with experienced users.
- RESPOND ONLY WITH VALID JSON. No markdown fences. No preamble. No text outside the JSON object.
- CRITICAL: The JSON MUST be syntactically complete and valid. Every opened brace and bracket must be closed. If approaching length limit, shorten EARLIER sections first, but always close the JSON properly.
- SCHOLARLY SOURCES AND FRAMEWORKS:

ASTRONOMY (verified data, cite where relevant):
Swiss Ephemeris (Koch & Treindl, Astrodienst AG), all planetary positions
JPL Horizons (NASA), authoritative ephemeris data
USNO Moon Phase API, verified lunar timing

MAYA CALENDRICS:
Šprajc, Inomata & Aveni (2023) Science Advances doi:10.1126/sciadv.abq7675. LiDAR evidence, calendar origin 1100-750 BCE
Aldana (2022) Encyclopedia of the History of Science doi:10.34758/qyyd-vx23
Milbrath (2017) Ancient Mesoamerica, agricultural cycle and Maya astronomical observations
Mendoza (2023), mathematical construction of the 260-day calendar from archaeoastronomical alignments
Parmington (2015) Bulletin of the History of Archaeology, archaeoastronomy review
Dreamspell: Argüelles (1987) The Mayan Factor, 20th-century modern system, distinct from ancient K'iche' Maya tradition (Aldana 2022; Tedlock 1992)

WESTERN ASTROLOGY:
Tarnas (2006) Cosmos and Psyche, planetary cycle correspondence with historical events
Greene (1976) Saturn: A New Look at an Old Devil, psychological astrology foundation
Hand (2002) Planets in Transit, transit interpretation reference
Brady (1999) Predictive Astrology, progressions and eclipse cycles
Brennan (2017) Hellenistic Astrology, ancient technique

NUMEROLOGY:
Drayer (2002) Numerology: The Power in Numbers
Kahn (2001) Pythagoras and the Pythagoreans
Amangeldiyev & Aldanazarova (2020), Metaphysics of numbers in Pythagorean philosophy
Schimmel (1993) The Mystery of Numbers

NEUROSCIENCE BRIDGE (Two Telescopes, science grounding):
Cajochen et al. (2013) Current Biology, peer-reviewed evidence lunar cycle influences human sleep
Wehr & Helfrich-Forster (2021) BioEssays, longitudinal evidence challenging consensus on lunar independence
Salehinejad et al. (2021) Nature Communications, cognitive functions associated with chronotype
Cajochen & Schmidt (2024) Annual Review of Psychology, circadian brain and cognition
Raichle (2015) Annual Review of Neuroscience, default mode network
Smallwood et al. (2021) Nature Reviews Neuroscience. DMN in cognition
Farb et al. (2007) Social Cognitive and Affective Neuroscience, mindfulness and self-reference
Tang, Holzel & Posner (2015) Nature Reviews Neuroscience, neuroscience of mindfulness
Barrett & Hoemann (2018) Cognition and Emotion, constructed emotion theory
Miller & Clark (2018) Synthese, predictive processing and emotion
Bortolotti et al. (2025) Frontiers in Neuroscience, supercomplexity: aesthetics and cognition
Foster & Roenneberg (2008) Current Biology, human responses to geophysical daily, annual, lunar cycles

WHERE RELEVANT: cite specific sources in readings to substantiate claims. Every factual claim traceable to a named authority. Symbolic claims explicitly labelled as symbolic.

SCHOLARLY CITATIONS:
Where the Reading makes a factual, scientific, or scholarly claim, mention the source author and year inline in the prose: "Bremer 2022", "Tarnas 2006", "Hill 2019", etc. The server-side post-processor will automatically wrap these mentions as tappable citation markers. You do not need to add HTML span tags yourself. Just write the author-year as natural inline text. Symbolic claims must be labelled as symbolic.

See the AVAILABLE REFERENCES list and AUTHOR ATTRIBUTION REQUIREMENT below for specifics.

${voiceInstruction}${cdpReferencesBlock}${cdpCitationInstruction}`;

  const user = `PROFILE:
${profileBlock}

Life Path: ${num.lp || 'not calculated'} (${num.lpM?.n || ''})
Personal Year: ${num.py || 'not calculated'} (${num.pyM?.n || ''})
Birth Kin (Dreamspell): ${birthKinStr}

DATE: ${dateStr} (${new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'})})

VERIFIED PLANETARY POSITIONS (Swiss Ephemeris ae_2026.pdf, Astrodienst AG):
${pTable}

MOON: ${moon.phase} ${moon.emoji}: ${moon.cycle} days into lunar cycle (${moon.pct}% illuminated)
${moonAlert}
Days to Next New Moon: ~${moon.toNew} | Days to Next Full Moon: ~${moon.toFull}

NUMEROLOGY:
Three Layers. Day: ${num.ud3?.day?.reduced||num.ud} (${num.ud3?.day?.meaning?.title||num.udM?.n}), Month: ${num.ud3?.month?.reduced||num.mEn} (${num.ud3?.month?.meaning?.title||num.mEnM?.n}), Full: ${num.ud3?.full?.reduced||num.ud} (${num.ud3?.full?.meaning?.title||num.udM?.n})${num.ud3?.full?.reduced&&[11,22,33,44].includes(num.ud3.full.reduced)?' ★ MASTER':''}
Universal Day: ${num.ud}: ${num.udM?.n} | ${num.udM?.k}
Month Energy (${new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-GB', {month:'long'})}): ${num.mEn}: ${num.mEnM?.n}
Year Energy (${dateStr.slice(0,4)}): ${num.yEn}: ${num.yEnM?.n}
Personal Year: ${num.py || 'n/a'} | Personal Month: ${num.pm || 'n/a'} | Personal Day: ${num.pd || 'n/a'}
THREE ENERGIES OF DAY: Morning=${num.pd || num.ud} (${NUM[num.pd || num.ud]?.n}), Afternoon=${num.pm || num.mEn} (${NUM[num.pm || num.mEn]?.n}), Evening=${num.py || num.yEn} (${NUM[num.py || num.yEn]?.n})

DREAMSPELL (Argüelles 1987, modern system):
${kin.full}${kin.isGAP ? ' ★ GALACTIC ACTIVATION PORTAL' : ''}
Tone ${kin.toneNum} (${kin.tone}) | Seal: ${kin.seal} | Color: ${kin.color}

KEY ASPECTS (Swiss Ephemeris):
${aList}

CONTEXT:
${satNep}
${uranus}
${mars}

WEEK AHEAD DATA (pre-calculated, use these exact dates, Kins, and UDs):
${weekAhead.map(w => `${w.dayStr}: ${w.kin} | UD${w.ud}${w.isGAP ? ' GAP' : ''}`).join('\n')}

Generate the FULL ORACLE READING as valid JSON (no markdown, no fences, no preamble. JSON object only):
{
  "synthesis": "<2-3 sentence italic opening, synthesise ALL four frameworks into the single deepest truth for ${firstName} today. Weave the Dreamspell Kin, Universal Day, dominant transit, and moon phase into one resonant, specific, memorable statement. This is the headline they carry all day. Where the Saturn-Neptune historical resonance is named, cite Tarnas 2006 inline.>",
  "numerology": {
    "headline": "UD ${num.ud}: ${num.udM?.n}: <one punchy, ${firstName}-specific sentence connecting their number to their current chapter>",
    "body": "<4 substantial paragraphs: (1) What Universal Day ${num.ud} (${num.udM?.n}) means specifically for ${firstName} today, named context, named chapter, named projects or relationships from their profile. Cite Drayer 2002 or Kahn 2001 inline for the Pythagorean numerology framework. (2) How UD ${num.ud} interacts with their Life Path ${num.lp || 'number'}, what tension or alignment emerges between daily energy and core soul pattern. (3) Personal Day ${num.pd || num.ud} meaning, its shadow side, and how ${firstName} can work with rather than against it. (4) How Personal Month ${num.pm || ''} colours everything this month, what it amplifies, what it challenges, what it asks ${firstName} to build or release.>",
    "three_energies": {
      "morning": {"num": ${num.pd || num.ud}, "name": "${NUM[num.pd || num.ud]?.n}", "guidance": "<3 concrete sentences for ${firstName}'s morning, specific action, specific awareness, what this energy most rewards in the first part of the day>"},
      "afternoon": {"num": ${num.pm || num.mEn}, "name": "${NUM[num.pm || num.mEn]?.n}", "guidance": "<3 concrete sentences for ${firstName}'s afternoon, how the energy shifts, what becomes available, specific advice for the middle of the day>"},
      "evening": {"num": ${num.py || num.yEn}, "name": "${NUM[num.py || num.yEn]?.n}", "guidance": "<3 concrete sentences for ${firstName}'s evening, how to close the day well, what to review, what to rest, the one habit that compounds>"}
    }
  },
  "moon_section": {
    "headline": "<${moon.phase} in ${planets[1].sign}, one evocative, ${firstName}-specific headline that names the essential tension or gift>",
    "body": "<3 substantial paragraphs: (1) What ${moon.phase} in ${planets[1].sign} specifically illuminates or asks of ${firstName}, their relationships, inner life, body, or context. Where circadian-rhythm or sleep claims arise, cite Cajochen 2013 or Walker 2017 inline. (2) Where ${moon.cycle} days into the lunar cycle places ${firstName}, what is culminating, releasing, or building. Reference the emotional arc of this specific phase position. (3) ${moonAlert ? 'Specific guidance for this BLACK MOON or SHIVA MOON threshold, what it means for decisions, timing, and energy today.' : 'Specific communication and relationship guidance for today, what to say, what to hold, what to offer.'}>"
  },
  "astrology": {
    "main_transit_headline": "<Name the single most significant active transit with precise degree notation, e.g. 'Mercury 15.5° Aries square Jupiter 15.9° Cancer. Precision Over Expansion'>",
    "main_transit_body": "<4 substantial paragraphs: (1) Precise astronomical description of this transit (planets, signs, exact orb, quality. (2) Historical and cultural context) what happened during the last time these planets made this aspect, what archetypal pattern is active. Cite Tarnas 2006 inline for the archetypal-astrology framework, and Greene 1976 inline for psychological astrology. Write the year directly in prose as 'Tarnas 2006 explored...' not in parentheses alone. (3) What this transit means for the world right now, structural, cultural, economic. (4) What this transit specifically asks of ${firstName} given their personal context and current chapter. Concrete, named, grounded.>",
    "saturn_neptune": "<3 substantial paragraphs: (1) The Saturn-Neptune cycle. Write 'Tarnas 2006' inline (not 'Tarnas (2006)' alone), and name the 1522 (Magellan circumnavigation), 1917 (WWI/Russian Revolution), 1952 (DNA discovery/early computing), 1989 (Berlin Wall/Cold War end) conjunctions with their historical significance. (2) What this current conjunction in Aries means specifically, dissolution of Saturn structures (old models, gatekeeping, rigid systems) meeting Neptunian vision (new paradigms, idealised possibilities) in the sign of pioneering initiations. How this affects the world's structures right now. (3) What this civilisational reset personally asks of ${firstName}, the impossible integration it invites, the dreamer AND architect simultaneously, how their current work or life chapter is positioned within this historical moment.>",
    "uranus_note": "<2 sentences: Uranus at ${planets[7].degStr} approaching Gemini ingress ~April 26 2026, what financial structures, communication architectures, and valuations this disrupts, and the specific implication for ${firstName}'s timing and planning.>"
  },
  "dreamspell": {
    "headline": "${kin.full}${kin.isGAP ? ' ★ GALACTIC ACTIVATION PORTAL' : ''}",
    "body": "<3-4 paragraphs: (1) Tone ${kin.toneNum} (${kin.tone}), its question, its challenge, its gift. What this tone specifically asks ${firstName} to embody or practice today. (2) The ${kin.seal} seal, its core power, its archetype, its gifts and shadow. Applied concretely to ${firstName}'s current situation and context. (3) The wavespell position and what specific invitation it carries, where ${firstName} is in the larger 13-day arc. (4) ${kin.isGAP ? 'GALACTIC ACTIVATION PORTAL: the veil between dimensions is thinner today. What specific arrivals, synchronicities, or unexpected clarity should ' + firstName + ' pay attention to? What has been seeking entrance?' : ''} Write 'Argüelles 1987' inline (not in parentheses alone) when describing the Dreamspell framework, and 'Tedlock 1992' inline when distinguishing from the living K\'iche\' tzolkʼin.>",
    "disclaimer": "Dreamspell: Argüelles (1987) The Mayan Factor, 20th-century modern system, distinct from the ancient K'iche' Maya tzolkʼin maintained continuously by Guatemalan daykeepers (Aldana 2022)."
  },
  "planetary_positions": [
    ${planets.map(pl => `{"planet":"${pl.name}","pos":"${pl.degStr}","sign":"${pl.sign}","note":"<12-15 word personalised note for ${firstName}, specific to their context and today's energy>"}`).join(',\n    ')}
  ],
  "aspects": [
    ${aspects.slice(0,6).map(a => `{"dots":${a.str},"label":"${a.desc}","body":"<3 sentences: what this specific aspect means for ${firstName} today, the tension or gift it brings, how it manifests in their actual life, one concrete way to work with it>"}`).join(',\n    ')}
  ],
  "shadow_work": "<3-4 italic sentences, the hard question ${firstName} actually needs right now. Grounded in their personal context. Not philosophical abstractions but the specific avoidance, the specific deferral, the specific unexamined assumption. Ask the question they most need to hear. Do not soften it. Where the neuroscience of self-reference or emotional construction is invoked, cite Bremer 2022 or Barrett 2017 inline.>",
  "priorities": [
    {"rank":1,"title":"<Most important priority today, specific to ${firstName}'s context and projects>","rationale":"<3-4 sentences with full cosmic rationale, which specific transits, numbers, and lunar phase support this priority today and why>","action":"<One specific, concrete, completable action for today, precise, physical, completable in a single session>"},
    {"rank":2,"title":"<Relationship or connection priority, specific person or type of connection>","rationale":"<3-4 sentences with cosmic rationale>","action":"<One specific action, what to say, who to reach, what to create>"},
    {"rank":3,"title":"<Body, health, or rest priority>","rationale":"<3-4 sentences>","action":"<One specific action with a time of day attached>"}
  ],
  "focus_on": ["<specific, named, actionable item 1>","<specific item 2>","<specific item 3>","<specific item 4>"],
  "ease_off": ["<specific, named, actionable item 1>","<specific item 2>","<specific item 3>","<specific item 4>"],
  "time_windows": {
    "morning": "<3 sentences: the precise cosmic quality of ${firstName}'s morning, what the energy supports, what it asks, specific advice for the first 4 hours of the day>",
    "afternoon": "<3 sentences: how the energy shifts in the afternoon for ${firstName}, what becomes available, what opens, what practical guidance applies>",
    "evening": "<3 sentences: how ${firstName} closes the day with integrity, what to review, what to release, the one habit or practice that compounds over weeks>"
  },
  "week_ahead": [
    ${weekAheadJSON}
  ],
  "daily_gift": {
    "quote": "<Precisely chosen quote (Jung, Marcus Aurelius, Kierkegaard, Seneca, Rilke, Rumi, or similar) that speaks exactly to ${firstName}'s current chapter. Not generic wisdom. The right sentence for this specific person at this specific moment in their life.>",
    "attribution": "<Full attribution: Author, Work, Year>",
    "reflection": "<2-3 sentences of personalised reflection on why this quote lands for ${firstName} right now, specific to their current chapter, their context, what they are building or releasing>",
    "meditation": "<3 specific, concrete, unglamorous acts for ${firstName} today (the kind of daily care that compounds over months. Physical, relational, creative. Not aspirational) actual.>"
  },
  "closing_line": "<One final sentence, italic, specific to ${firstName}, not inspirational fluff. The truth of where they actually are, spoken with warmth and precision. The sentence they will carry.>",
  "sources": "Astronomy: Swiss Ephemeris (Koch & Treindl, Astrodienst AG, ae_2026.pdf); USNO Moon Phases. Maya calendrics: Šprajc et al. (2023) Science Advances doi:10.1126/sciadv.abq7675; Aldana (2022) doi:10.34758/qyyd-vx23. Dreamspell: Argüelles (1987) The Mayan Factor. Astrology: Greene (1976) Saturn; Tarnas (2006) Cosmos & Psyche; Hand (2002) Planets in Transit; Brady (1999) Predictive Astrology; Brennan (2017) Hellenistic Astrology. Numerology: Drayer (2002); Kahn (2001) Pythagoras."
}

OUTPUT FORMAT (strict): Respond with ONLY the JSON object above, populated for ${firstName} on ${dateStr}. No markdown code fences. No preamble. No commentary before or after. The very first character of your response must be { and the very last must be }. Citations are written inline inside the prose string values, not after the JSON.

BEFORE YOU FINISH: count the author-year mentions in your prose (patterns like "Tarnas 2006", "Drayer 2002", "Bower and Kuhlman 2023", "Klusmann et al 2023"). If the count is below the tier minimum stated above in the CITATION REQUIREMENT, add more by attributing existing claims to the relevant authors named in the requirement. Do not invent claims to fit citations, attribute claims you have already made. The frameworks you are using (Pythagorean numerology, Western psychological astrology, Dreamspell, neuroscience of attention and sleep) all have named scholarly sources; use them.`;

  const maxTok = {free:800, seeker:3000, initiate:5000, mystic:8000, oracle:16000}[tier] || 8192;
  // Use Haiku for lighter tiers, much faster, still quality
  const genModel = 'claude-sonnet-4-6';
  
  // iter12d: structured timing logs for diagnosing slow Readings.
  // Each line lands in Railway logs and lets us see exactly where time went.
  const _genStart = Date.now();
  const _sysLen = sys.length;
  const _userLen = user.length;
  console.log('[reading-gen] tier=' + tier + ' model=' + genModel + ' maxTok=' + maxTok + ' sysLen=' + _sysLen + ' userLen=' + _userLen + ' jobId=' + (jobId || 'sync'));
  
  const raw = await callAPI(genModel, maxTok, sys, user);
  
  const _apiMs = Date.now() - _genStart;
  console.log('[reading-gen DONE] tier=' + tier + ' apiMs=' + _apiMs + ' rawLen=' + (raw ? raw.length : 0) + ' jobId=' + (jobId || 'sync'));

  let reading;
  try {
    // Strip markdown code fences anywhere in the text (model sometimes wraps,
    // sometimes adds trailing commentary after the JSON).
    let cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    // Extract the outermost balanced JSON object: scan forward from first '{'
    // and track brace depth (respecting strings and escapes) until depth=0.
    // This trims off any chatty prose the model appended after the JSON.
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace > -1) {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = firstBrace; i < cleaned.length; i++) {
        const c = cleaned[i];
        if (esc) { esc = false; continue; }
        if (c === '\\' && inStr) { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end > -1) cleaned = cleaned.slice(firstBrace, end + 1);
    }
    reading = JSON.parse(cleaned);
  } catch(e) {
    try {
      const stripped = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const repaired = repairJSON(stripped);
      reading = JSON.parse(repaired);
      reading._repaired = true;
    } catch(e2) {
      console.warn('[reading-gen PARSE FAIL] tier=' + tier + ' err=' + e.message + ' rawHead=' + (raw || '').slice(0, 200).replace(/\n/g, '\\n'));
      reading = {synthesis: raw, raw: true, parseError: e.message};
    }
  }

  // ── THREE-VOICE VALIDATION (oracle/mystic only) ────────────────────────────
  // The voice instruction was appended to the system prompt for these tiers.
  // Validate that the model returned tradition/science/everyday for every voiced
  // section. Failures are logged and surfaced on the response (reading._voices)
  // but never block the reading: missing voices fall back to single-voice display
  // on the frontend.
  if ((tier !== 'free' && tier !== 'quick') && reading && !reading.raw) {
    try {
      const v = validateThreeVoiceReading(reading);
      reading._voices = {
        ok: v.ok,
        missing: v.missing,
        coverage: v.ok ? 'complete' : 'partial'
      };
      if (!v.ok) {
        console.warn('[three-voice] missing in reading for ' + dateStr + ':',
          v.missing.map(m => m.section + ' (' + m.voices.join(',') + ')').join('; '));
      }
    } catch(e) {
      console.warn('[three-voice] validation error:', e.message);
    }
  }

  // ── HOUSE-STYLE SCRUBBER (all tiers) ───────────────────────────────────────
  // Belt-and-braces enforcement of CDP punctuation rules. Replaces em dashes,
  // en dashes, and exclamation marks with house-style equivalents even if the
  // model slipped despite the system-prompt instruction. Idempotent.
  if (reading && !reading.raw) {
    try {
      const scrubbed = scrubHouseStyle(reading);
      reading = scrubbed.reading;
      if (scrubbed.replacements > 0) {
        console.log('[house-style] scrubbed ' + scrubbed.replacements + ' field(s) for ' + dateStr + ' (tier=' + tier + ')');
        reading._scrubbed = scrubbed.replacements;
      }
    } catch(e) {
      console.warn('[house-style] scrub error:', e.message);
    }
  }

  // iter12f: post-process citations into v11-cite spans
  // This wraps any "Author Year" pattern in prose fields with the
  // structured citation marker so the frontend can render popovers,
  // regardless of whether the model followed the inline-citation
  // instruction in the prompt.
  try {
    const citesWrapped = postProcessCitations(reading);
    if (citesWrapped > 0) {
      console.log('[reading-gen citations] wrapped', citesWrapped, 'inline citations from bibliography');
    } else {
      console.log('[reading-gen citations] no author-year patterns found in prose');
    }
  } catch (e) {
    console.warn('[reading-gen citations] post-processor failed:', e.message);
  }
  
  return {reading, planets, moon, kin, num, aspects, weekAhead};
}

// ══════════════════════════════════════════════════════════════════
// JSON REPAIR
// ══════════════════════════════════════════════════════════════════
function repairJSON(str) {
  let s = str.trim();
  s = s.replace(/,\s*$/, '');
  let openBraces = 0, openBrackets = 0, inString = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') openBraces++;
    else if (c === '}') openBraces--;
    else if (c === '[') openBrackets++;
    else if (c === ']') openBrackets--;
  }
  if (inString) s += '"';
  while (openBrackets > 0) { s += ']'; openBrackets--; }
  while (openBraces > 0) { s += '}'; openBraces--; }
  return s;
}


// ══════════════════════════════════════════════════════════════════
// TWO-PHASE READING GENERATION
// Phase 1: Actionable core (~25s), synthesis, priorities, shadow,
//          focus/ease, time windows
// Phase 2: Deep analysis (~3-5min), numerology, astrology,
//          dreamspell, transits, week ahead, daily gift
// ══════════════════════════════════════════════════════════════════

async function generatePhase1(dateStr, profile, tier, planets, moon, kin, num, aspects, jobId) {
  // Early abort: if job has been marked as errored (deadline), stop immediately
  if (jobId && !isJobStillValid(jobId)) {
    throw new Error('job_cancelled_by_deadline');
  }
  
  const firstName = profile.nickname || (profile.name ? profile.name.split(' ')[0] : 'you');
  const profileBlock = buildProfileContext(profile, []);

  const pTable = planets.map(pl => `${pl.name}: ${pl.degStr}`).join('\n');
  const moonAlert = moon.isBlack
    ? `★ BLACK MOON, threshold day. No major launches. Observe.`
    : moon.isShiva ? `★ SHIVA MOON, auspicious. Fresh starts welcomed.` : '';

  const scope1 = {
    free: 'PHASE 1 FREE: synthesis (1 sentence), one priority, one action. Under 200 tokens.',
    seeker: 'PHASE 1 SEEKER: synthesis (2 sentences), 3 priorities with rationale and actions, shadow_work, focus_on (4 items), ease_off (4 items), time_windows. Concise, 2 sentences per field. Under 1500 tokens.',
    initiate: 'PHASE 1 INITIATE: Same as Seeker but richer. synthesis (2-3 sentences), 3 priorities with full rationale, shadow_work, focus_on, ease_off, time_windows. Under 2000 tokens.',
    mystic: 'PHASE 1 MYSTIC: synthesis (3 sentences), 3 full priorities, shadow_work (3 sentences), focus_on, ease_off, time_windows. Under 2500 tokens.',
    oracle: 'PHASE 1 ORACLE: synthesis (3 powerful sentences synthesising all 4 frameworks), 3 priorities with full 3-4 sentence rationale and specific actions, shadow_work (4 sentences, the hard question), focus_on (4 items), ease_off (4 items), time_windows (3 sentences each). Under 3000 tokens.'
  }[tier] || 'PHASE 1: synthesis, priorities, shadow_work, focus_on, ease_off, time_windows.';

  const sys1 = `You are the Oracle at Cosmic Daily Planner. PHASE 1, generate only the actionable core sections. Fast, precise, personal.
${scope1}
Rules: Address ${firstName} by name. Use only provided data. RESPOND WITH VALID JSON ONLY, no markdown, no preamble.`;

  const user1 = `DATE: ${dateStr}
PROFILE: ${profileBlock}
PLANETS: ${pTable}
MOON: ${moon.phase}: ${moon.cycle} days into cycle ${moonAlert}
NUMEROLOGY. THREE LAYERS:
• Day Energy (day digit ${num.ud3?.day?.n||num.ud}): ${num.ud3?.day?.meaning?.title||num.udM?.n}: ${num.ud3?.day?.meaning?.guidance||''}
• Month Energy (day+month → ${num.ud3?.month?.n||num.mEn}): ${num.ud3?.month?.meaning?.title||num.mEnM?.n}
• Full Date Energy (all digits → ${num.ud3?.full?.n||num.ud}): ${num.ud3?.full?.meaning?.title||num.udM?.n} ${num.ud3?.full?.isMaster?'⚠ MASTER NUMBER, do not reduce further':''}
Personal: PD${num.pd||num.ud} (${num.pdM?.n||''}), LP${num.lp||'?'}, PY${num.py||'?'}
KIN: ${kin.full}${kin.isGAP?' ★ GAP':''}

Generate ONLY these sections as valid JSON:
{
  "synthesis": "<${tier==='oracle'?'3 powerful sentences synthesising Dreamspell Kin, Universal Day, dominant transit and moon into one resonant truth for '+firstName+' today':'2-3 sentences, the essential truth for '+firstName+' today'}>",
  "priorities": [
    {"rank":1,"title":"<Most important priority, specific to ${firstName}>","rationale":"<${tier==='oracle'?'3-4':'2'} sentences with cosmic rationale, which transits/numbers/phase support this>","action":"<One specific, completable action for today>"},
    {"rank":2,"title":"<Connection/relationship priority>","rationale":"<${tier==='oracle'?'3-4':'2'} sentences>","action":"<Specific action>"},
    {"rank":3,"title":"<Body/health/rest priority>","rationale":"<${tier==='oracle'?'3-4':'2'} sentences>","action":"<Specific action with time of day>"}
  ],
  "shadow_work": "<${tier==='oracle'?'3-4':'2'} sentences, the question ${firstName} most needs right now. Grounded in their context. Not abstract. The specific avoidance or unexamined assumption.>",
  "focus_on": ["<specific named item>","<specific item>","<specific item>","<specific item>"],
  "ease_off": ["<specific named item>","<specific item>","<specific item>","<specific item>"],
  "time_windows": {
    "morning": "<${tier==='oracle'?'3':'2'} sentences, specific cosmic quality and advice for ${firstName}'s morning>",
    "afternoon": "<${tier==='oracle'?'3':'2'} sentences, how energy shifts and what becomes available>",
    "evening": "<${tier==='oracle'?'3':'2'} sentences, how ${firstName} closes the day well>"
  }
}`;

  const maxTok1 = {free:400, seeker:1800, initiate:2200, mystic:2800, oracle:3500}[tier] || 2000;
  // Use Haiku for seeker/free Phase1 (fast enough), Sonnet for deeper tiers
  const p1Model = (tier === 'free') ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';
  const raw1 = await callAPI(p1Model, maxTok1, sys1, user1);

  try {
    const cleaned = raw1.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch(e) {
    try {
      return JSON.parse(repairJSON(raw1.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()));
    } catch(e2) {
      return { synthesis: raw1, raw: true };
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════

const jobs = new Map();
function newJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function cleanOldJobs() {
  const cutoff = Date.now() - 14400000; // 4hr TTL, survives brief Railway redeploys
  for (const [id, job] of jobs) {
    if (job.startedAt < cutoff) jobs.delete(id);
  }
}
setInterval(cleanOldJobs, 600000);

// ── JOB VALIDITY CHECK ──
// Allows generation functions to exit early if the job has been
// marked as errored (e.g., by deadline timeout) rather than continuing to call the API
function isJobStillValid(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  return job.status !== 'error' && job.status !== 'complete';
}

// ── START BACKGROUND READING ──
app.post('/api/reading/start', async (req, res) => {
  const {date, profile, tier, user_id, recentHistory, threads} = req.body;
  const ds = date || new Date().toISOString().slice(0, 10);
  const jobId = newJobId();
  const activeTier = tier || 'oracle';

  // v22 memory continuity: pull yesterday-intention from server-side store.
  // Same logic as /api/reading single-shot path. Plumbed into Phase 2.
  let yesterdayIntention = null;
  try {
    const userKey = (typeof v19_userKey === 'function') ? v19_userKey(req) : null;
    if (userKey && typeof v19_intentions !== 'undefined' && v19_intentions.get) {
      const userMap = v19_intentions.get(userKey);
      if (userMap) {
        const dateNow = new Date(ds + 'T12:00:00Z');
        const dateYest = new Date(dateNow.getTime() - 86400000);
        const yIso = dateYest.toISOString().slice(0,10);
        yesterdayIntention = userMap[yIso] || null;
      }
    }
  } catch(e) { /* non-fatal */ }

  jobs.set(jobId, {
    status: 'pending',
    startedAt: Date.now(),
    date: ds,
    tier: activeTier,
    user_id: user_id || null,
    result: null,
    phase1: null,
    error: null
  });

  // Orchestrated readings: per-tier hard job deadline. Sections run in
  // parallel (concurrency cap 3-4), each with 90s per-call ceiling. Wall
  // time is dominated by the slowest section, not the sum. Deadlines below
  // are comfortable headroom: typical wall times are 10-15s (free),
  // 22-35s (seeker), 35-55s (initiate), 50-75s (mystic), 60-100s (oracle).
  // If a section retries on transient, that adds up to 90s before falling
  // back to the static stub, so we set ceilings well above typical.
  const _jobDeadlineMs = {free: 60000, seeker: 90000, initiate: 150000,
                          mystic: 210000, oracle: 300000}[activeTier] || 180000;
  setTimeout(() => {
    const _j = jobs.get(jobId);
    if (_j && _j.status !== 'complete' && _j.status !== 'error') {
      _j.status = 'error';
      _j.error = `job_deadline_exceeded_${Math.round(_jobDeadlineMs/1000)}s`;
      _j.completedAt = Date.now();
      console.error(`Job ${jobId} forcibly errored after ${_jobDeadlineMs/1000}s deadline`);
    }
  }, _jobDeadlineMs);

  res.json({ jobId, status: 'pending' });

  // ── ORCHESTRATED SECTION GENERATION ─────────────────────────────────
  // All tiers run through the per-section orchestrator. Sections run
  // in parallel, model selected per section. Phase 1 (synthesis +
  // numerology) renders to the client as soon as both arrive, typically
  // 8 to 12 seconds. Remaining sections stream into the job result as
  // they complete. Full reading lands in 30 to 75 seconds depending on
  // tier, compared to the previous 4 to 9 minutes (which routinely
  // failed at Oracle due to a 180s callAPI hard cap on a 16,000-token
  // single-shot call that physically could not complete).
  (async () => {
    try {
      // Pre-calculate framework data once. These are deterministic
      // and shared across every section composition.
      const planets = buildPlanets(ds);
      const moon = getMoon(ds);
      const kin = getKin(ds);
      const num = getNumerology(ds, profile?.birthDay, profile?.birthMonth, profile?.birthYear);
      const aspects = getAspects(planets);
      const weekAhead = getWeekAhead(ds);

      // Natal chart for natal_integration section. Only compute if we
      // have birth date; tolerate absence gracefully (orchestrator falls
      // back to Sun-sign-only natal anchor from birth date).
      let natalPlanets = null;
      try {
        if (profile?.birthDay && profile?.birthMonth && profile?.birthYear) {
          const bIso = `${profile.birthYear}-${String(profile.birthMonth).padStart(2,'0')}-${String(profile.birthDay).padStart(2,'0')}`;
          natalPlanets = buildPlanets(bIso);
        }
      } catch (e) { /* non-fatal; orchestrator falls back */ }

      // Build the shared context that threads through every section.
      // This is what makes the reading bespoke rather than generic.
      // Build B: named threads (from request body) are read as structured
      // context. The synthesis section weaves them through the day's
      // convergence; other sections may reference them where genuinely apt.
      // Falls back to profile.active_threads if no explicit threads sent.
      const buildBthreads = (Array.isArray(threads) && threads.length > 0)
                            ? threads
                            : (profile && profile.active_threads ? profile.active_threads : null);
      const sharedContext = orchestrator.buildSharedContext({
        profile: profile || {},
        dateStr: ds,
        planets, moon, kin, num, aspects,
        weekAhead,
        recentHistory: recentHistory || [],
        yesterdayIntention,
        natalPlanets,
        threads: buildBthreads
      });

      // Model map: orchestrator names models abstractly ("haiku", "sonnet"),
      // server resolves to the current Anthropic identifiers.
      const modelMap = {
        haiku: 'claude-haiku-4-5-20251001',
        sonnet: 'claude-sonnet-4-6'
      };

      // Run the orchestrator. Phase 1 callback updates the job as soon
      // as the synthesis and numerology sections arrive; the client polls
      // status every 2s and picks up phase1_complete.
      const reading = await orchestrator.composeReading({
        tier: activeTier,
        sharedContext,
        bibliography: CDP_BIBLIOGRAPHY,
        callAPIFn: callAPI,
        modelMap,
        scrubFn: (typeof scrubHouseStyle === 'function') ? scrubHouseStyle : null,
        jobId,
        onPhase1: (phase1Payload) => {
          const job = jobs.get(jobId);
          if (job && job.status !== 'complete' && job.status !== 'error') {
            // Adapt phase1 payload to legacy shape that the frontend
            // fillPhase1Sections() function consumes. Phase 1 always
            // contains synthesis and numerology sections (both flagged
            // phase1: true in the section library).
            const _voice = (profile && profile.readingLang === 'modern') ? 'science_text'
                         : (profile && profile.readingLang === 'scientific') ? 'science_text'
                         : 'tradition_text';
            const _pickVoice = (sec) => {
              if (!sec) return '';
              return sec[_voice] || sec.tradition_text || sec.everyday_text || sec.science_text || '';
            };
            const _strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const _firstSentence = (s) => {
              const txt = _strip(s);
              const m = txt.match(/^[^.!?]+[.!?]/);
              return m ? m[0].trim() : txt.slice(0, 160);
            };
            // iter13b: defensive string coercion for headline. If the model
            // ever returns a non-string headline, the frontend forEach over
            // priorities would crash and leave the panel blank.
            const _str = (v, fallback) => {
              if (v == null) return fallback || '';
              if (typeof v === 'string') return v;
              if (typeof v === 'number') return String(v);
              if (typeof v === 'object') {
                if (typeof v.tradition === 'string') return v.tradition;
                if (typeof v.science   === 'string') return v.science;
                if (typeof v.everyday  === 'string') return v.everyday;
                if (typeof v.headline  === 'string') return v.headline;
                if (typeof v.body      === 'string') return v.body;
                if (typeof v.text      === 'string') return v.text;
                return fallback || '';
              }
              return String(v);
            };
            const synth = phase1Payload.synthesis;
            const numer = phase1Payload.numerology;
            const legacyP1 = {
              synthesis: _strip(_pickVoice(synth)),
              priorities: [
                synth ? { title: _str(synth.headline, 'Today'),
                          action: _firstSentence(synth.everyday_text || synth.tradition_text || '') } : null,
                numer ? { title: _str(numer.headline, 'The day in number'),
                          action: _firstSentence(numer.everyday_text || numer.tradition_text || '') } : null
              ].filter(Boolean),
              // Sections payload preserved for the next generation of
              // the frontend to consume directly.
              sections: phase1Payload
            };
            job.phase1 = legacyP1;
            job.status = 'phase1_complete';
            console.log(`[orchestrator ${jobId}] phase1 ready at ${((Date.now() - job.startedAt)/1000).toFixed(1)}s`);
          }
        },
        onSectionComplete: (sectionId, result) => {
          // Progressive accumulation. Each section is recorded on the job as
          // it lands, so the status endpoint reports genuine progress and a
          // render can show sections arriving one by one rather than a counter
          // against nothing. Purely additive: the happy-path assembly below
          // still produces the authoritative result.
          const job = jobs.get(jobId);
          if (!job || job.status === 'complete' || job.status === 'error') return;
          if (!job.partialMap) { job.partialMap = {}; job.sectionsReady = 0; }
          if (sectionId && result && !job.partialMap[sectionId]) {
            job.partialMap[sectionId] = result;
            job.sectionsReady = Object.keys(job.partialMap).length;
          }
        }
      });

      // Post-process: also run the legacy author-year wrapper across
      // section prose, as a safety net for cases where the model used
      // inline author-year mentions in addition to (or instead of)
      // returning citation IDs. Wrapper is idempotent and cheap.
      try {
        if (typeof postProcessCitations === 'function') {
          postProcessCitations(reading);
        }
      } catch(e) { /* non-fatal */ }

      // ── BACKWARDS-COMPATIBLE LEGACY SHAPE ─────────────────────────
      // The frontend (app.html) currently consumes the legacy quickread
      // shape: reading.synthesis, reading.priorities, reading.shadow,
      // reading.focus_on, reading.ease_off, reading.time_windows,
      // reading.week_notes, reading.week_ahead. We project the section
      // payload onto those fields so the frontend renders unchanged.
      // The new section-based fields (reading.sections, reading.sectionMap,
      // reading.citationMeta) remain in the payload for the next
      // generation of the frontend to consume.
      const sm = reading.sectionMap || {};
      const legacyVoice = (profile && profile.readingLang === 'modern') ? 'science_text'
                        : (profile && profile.readingLang === 'scientific') ? 'science_text'
                        : 'tradition_text';
      const pickVoiceHtml = (sec) => {
        if (!sec) return '';
        // Prefer the explicitly requested voice; fall back to others if empty.
        return sec[legacyVoice] || sec.tradition_text || sec.everyday_text || sec.science_text || '';
      };
      const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      // iter13b: defensive string coercion. If the model returns an object
      // where a string was expected (e.g. headline as {tradition, science})
      // or returns nothing at all, we always emit a string. Without this,
      // the frontend's forEach over priorities/focus/ease can crash with
      // "(...).replace is not a function" on the first non-string field.
      const _str = (v, fallback) => {
        if (v == null) return fallback || '';
        if (typeof v === 'string') return v;
        if (typeof v === 'number') return String(v);
        if (typeof v === 'object') {
          if (typeof v.tradition === 'string') return v.tradition;
          if (typeof v.science   === 'string') return v.science;
          if (typeof v.everyday  === 'string') return v.everyday;
          if (typeof v.headline  === 'string') return v.headline;
          if (typeof v.body      === 'string') return v.body;
          if (typeof v.text      === 'string') return v.text;
          return fallback || '';
        }
        return String(v);
      };

      // Map orchestrator sections to legacy fields
      reading.synthesis = stripHtml(pickVoiceHtml(sm.synthesis));
      reading.shadow = stripHtml(pickVoiceHtml(sm.shadow));
      reading.shadow_work = reading.shadow;

      // Priorities: derive three short priorities from synthesis + numerology + body
      // Each priority pairs a title from the section headline with an action
      // drawn from the first sentence of the everyday voice text.
      const firstSentence = (s) => {
        const txt = stripHtml(s);
        const m = txt.match(/^[^.!?]+[.!?]/);
        return m ? m[0].trim() : txt.slice(0, 160);
      };
      const buildPriority = (sec, fallback) => {
        if (!sec) return fallback;
        return {
          title: _str(sec.headline, fallback.title),
          action: firstSentence(sec.everyday_text || sec.tradition_text || sec.science_text || '') || fallback.action
        };
      };
      reading.priorities = [
        buildPriority(sm.synthesis, { title: 'Today', action: 'Read the synthesis above.' }),
        buildPriority(sm.numerology || sm.body, { title: 'Body and number', action: 'Notice the energy quality of the day.' }),
        buildPriority(sm.lunar || sm.transits, { title: 'Sky', action: 'Note the lunar position and any active transit.' })
      ];

      // Focus_on / ease_off: derive four-item arrays from synthesis + body
      // and shadow. Short evocative phrases.
      reading.focus_on = [
        sm.numerology ? _str(sm.numerology.headline, 'The day in number') : 'The opening of the day',
        sm.lunar ? _str(sm.lunar.headline, 'Lunar pacing') : 'Pacing',
        sm.dreamspell ? _str(sm.dreamspell.headline, 'Today\u2019s Kin') : 'Symbolic anchor',
        sm.body ? _str(sm.body.headline, 'Body as compass') : 'Body and breath'
      ];
      reading.ease_off = [
        sm.shadow ? 'Where today might catch you' : 'Forcing a result',
        'Pushing tired attention',
        'Multitasking under load',
        'Skipping the wind-down'
      ];

      // Time windows: from pacing section if present, otherwise synthesised
      // from synthesis + body. Plain text.
      if (sm.pacing) {
        const pacingText = stripHtml(pickVoiceHtml(sm.pacing));
        // Try to split into morning/afternoon/evening if those labels exist
        const morningMatch = pacingText.match(/morning[:\s]+([^.]+\.)/i);
        const afternoonMatch = pacingText.match(/afternoon[:\s]+([^.]+\.)/i);
        const eveningMatch = pacingText.match(/evening[:\s]+([^.]+\.)/i);
        reading.time_windows = {
          morning: morningMatch ? morningMatch[1].trim() : pacingText.slice(0, 200),
          afternoon: afternoonMatch ? afternoonMatch[1].trim() : 'Steady pace; protect the post-lunch dip.',
          evening: eveningMatch ? eveningMatch[1].trim() : 'Wind down; protect sleep onset.'
        };
      } else {
        reading.time_windows = {
          morning: 'Use the early hours for the day\u2019s most important attention.',
          afternoon: 'Steady pace; protect the post-lunch dip.',
          evening: 'Wind down; protect sleep onset.'
        };
      }

      // Week ahead notes: derive from week ahead data
      reading.week_notes = (weekAhead || []).slice(1, 7).map(w =>
        `${w.dayStr}: Universal Day ${w.ud}${w.isGAP ? ' GAP' : ''}, Kin ${w.kin}.`
      );
      reading.week_ahead = (weekAhead || []).slice(1, 7).map((w, i) => ({
        date: w.date, dayStr: w.dayStr, note: reading.week_notes[i] || ''
      }));

      reading.next_tier_teaser = activeTier === 'oracle' ? ''
        : `A higher tier reading would add ${activeTier === 'free' ? 'three more sections including lunar pacing and Kin' : activeTier === 'seeker' ? 'transits, Dreamspell depth, and body-compass sections' : activeTier === 'initiate' ? 'shadow, pacing, and body-compass sections' : 'depth synthesis and natal integration'}.`;

      // ── DEEP-SECTION LEGACY PROJECTION ────────────────────────────
      // The frontend renders these legacy section objects in fillAISections:
      //   reading.numerology     { headline, body, three_energies? }
      //   reading.astrology      { main_transit_headline, main_transit_body, saturn_neptune? }
      //   reading.dreamspell     { headline, body, disclaimer? }
      //   reading.moon_section   { headline, body }
      //   reading.body_section   { headline, body }
      //   reading.shadow_section { headline, body }
      //
      // We project each orchestrator section onto its legacy counterpart so
      // every panel in the rendered reading has prose, not just the top
      // synthesis. The picked voice for `body` follows the user's readingLang
      // preference (modern/scientific → science_text, otherwise tradition_text).
      // We also retain the multi-voice payload on each projected object so the
      // future client-side voice toggle can swap without another API call.
      const projectSection = (sec, fallbackHeadline) => {
        if (!sec) return null;
        return {
          headline: _str(sec.headline, fallbackHeadline || ''),
          body: stripHtml(pickVoiceHtml(sec)),
          tradition: stripHtml(sec.tradition_text || ''),
          science: stripHtml(sec.science_text || ''),
          everyday: stripHtml(sec.everyday_text || ''),
          citations: Array.isArray(sec.citations) ? sec.citations.slice() : []
        };
      };

      reading.numerology = projectSection(sm.numerology, 'The day in number');
      reading.dreamspell = projectSection(sm.dreamspell, kin && kin.full ? kin.full : 'Today\u2019s Kin');
      reading.moon_section = projectSection(sm.lunar, moon && moon.phase ? moon.phase : 'The moon, today');
      reading.body_section = projectSection(sm.body, 'Body, today');
      reading.shadow_section = projectSection(sm.shadow, 'Where today might catch you');
      reading.pacing_section = projectSection(sm.pacing, 'Pacing across the day');

      // Astrology has two sub-fields the frontend reads: main transit and
      // Saturn-Neptune. Map both off the transits section, putting the bulk
      // of the prose in main_transit_body and a derived short paragraph in
      // saturn_neptune if the section happens to discuss it.
      if (sm.transits) {
        const transitsBody = stripHtml(pickVoiceHtml(sm.transits));
        reading.astrology = {
          main_transit_headline: sm.transits.headline || 'The sky, this morning',
          main_transit_body: transitsBody,
          saturn_neptune: /saturn|neptune/i.test(transitsBody) ? transitsBody : '',
          tradition: stripHtml(sm.transits.tradition_text || ''),
          science: stripHtml(sm.transits.science_text || ''),
          everyday: stripHtml(sm.transits.everyday_text || ''),
          citations: Array.isArray(sm.transits.citations) ? sm.transits.citations.slice() : []
        };
      } else {
        reading.astrology = null;
      }

      // Oracle-only sections: depth synthesis and natal integration.
      // Expose as reading.depth_synthesis and reading.natal_integration so
      // the Oracle-tier render can surface them as their own panels.
      reading.depth_synthesis = projectSection(sm.depth_synthesis, 'How the frameworks converge today');
      reading.natal_integration = projectSection(sm.natal_integration, 'Today against your natal chart');

      // Three-energies block for the numerology three-square legacy render
      // (Day / Day+Month / Full-date integrated with personal year).
      // Built from the deterministic numerology data we already computed.
      if (num && reading.numerology) {
        reading.numerology.three_energies = {
          day:        { n: num.ud,            label: num.udM && num.udM.n ? 'Master ' + num.udM.n : 'Universal Day ' + num.ud },
          day_month:  { n: num.pd || num.ud,  label: 'Personal Day ' + (num.pd || num.ud) },
          full_date:  { n: num.py,            label: 'Personal Year ' + num.py }
        };
      }

      // Assemble final job payload. Frontend expects { reading, planets,
      // moon, kin, num, aspects, weekAhead } in job.result.
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'complete';
        job.result = {
          reading,
          planets, moon, kin, num, aspects,
          weekAhead,
          tier: activeTier,
          sectionTimings: reading.timings,
          generatedAt: new Date().toISOString()
        };
        job.completedAt = Date.now();
        const totalMs = job.completedAt - job.startedAt;
        const sectionCount = reading.sections.length;
        const okCount = reading.sections.filter(s => s.ok).length;
        const citeCount = reading.citationUnion.length;
        console.log(`[orchestrator ${jobId}] COMPLETE tier=${activeTier} sections=${okCount}/${sectionCount} cites=${citeCount} totalMs=${totalMs}`);
      }
    } catch(e) {
      const job = jobs.get(jobId);
      if (job) { job.status = 'error'; job.error = e.message; }
      console.error(`[orchestrator ${jobId}] FAILED:`, e.message, e.stack ? e.stack.split('\n')[1] : '');
    }
  })();
});

// ── POLL JOB STATUS ──
app.get('/api/reading/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: 'not_found' });
  if (job.status === 'complete') {
    return res.json({ status: 'complete', result: job.result,
      duration: Math.round((job.completedAt - job.startedAt) / 1000) });
  }
  if (job.status === 'error') {
    return res.json({ status: 'error', error: job.error });
  }
  // Phase 1 complete, return actionable core while phase 2 continues
  if (job.status === 'phase1_complete' && job.phase1) {
    const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
    return res.json({ status: 'phase1_complete', phase1: job.phase1, elapsed, tier: job.tier,
      sectionsReady: job.sectionsReady || 0,
      sectionsDone: job.partialMap ? Object.keys(job.partialMap) : [] });
  }
  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
  res.json({ status: 'pending', elapsed, tier: job.tier, sectionsReady: job.sectionsReady || 0 });
});

// ── LEGACY SYNC READING ──
app.post('/api/reading', async (req, res) => {
  const {date, profile, tier, recentHistory} = req.body;
  const ds = date || new Date().toISOString().slice(0, 10);
  const tStart = Date.now();
  const reqTier = tier || 'oracle';
  const userKey = (typeof v19_userKey === 'function') ? v19_userKey(req) : null;
  console.log(`[reading START] tier=${reqTier} date=${ds} user=${userKey ? userKey.slice(0,8) : 'anon'}`);
  try {
    // v22 memory continuity: try to surface yesterday's intention if available.
    // Reads from the same v19_intentions Map used by /api/compass/today.
    let yesterdayIntention = null;
    try {
      if (userKey && typeof v19_intentions !== 'undefined' && v19_intentions.get) {
        const userMap = v19_intentions.get(userKey);
        if (userMap) {
          const dateNow = new Date(ds + 'T12:00:00Z');
          const dateYest = new Date(dateNow.getTime() - 86400000);
          const yIso = dateYest.toISOString().slice(0,10);
          yesterdayIntention = userMap[yIso] || null;
          if (yesterdayIntention) console.log(`[reading] yesterday-intention found for ${yIso}`);
        }
      }
    } catch(e) { /* non-fatal */ }

    const r = await generateReading(ds, profile || {}, reqTier, recentHistory || [], undefined, undefined, undefined, undefined, undefined, yesterdayIntention);
    const elapsed = Date.now() - tStart;
    console.log(`[reading DONE] tier=${reqTier} elapsed=${elapsed}ms hasReading=${!!r} hasError=${!!r?.error}`);
    res.json(r);
  } catch(e) {
    const elapsed = Date.now() - tStart;
    console.error(`[reading ERROR] tier=${reqTier} elapsed=${elapsed}ms message=${e.message}`);
    console.error(e.stack);
    res.status(500).json({error: e.message});
  }
});

app.post('/api/cosmic', (req, res) => {
  const {date, profile} = req.body;
  const ds = date || new Date().toISOString().slice(0, 10);
  try {
    const planets = buildPlanets(ds);
    const moon = getMoon(ds);
    const kin = getKin(ds);
    const num = getNumerology(ds, profile?.birthDay, profile?.birthMonth, profile?.birthYear);
    const aspects = getAspects(planets);
    res.json({planets, moon, kin, num, aspects});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/ask', async (req, res) => {
  const {question, context, profile, readingData, systemPrompt} = req.body;
  if (!question) return res.status(400).json({error: 'No question'});
  try {
    const p = profile || {};
    const firstName = p.nickname || (p.name ? p.name.split(' ')[0] : 'the reader');

    // Beta 2: enriched profile context for ask endpoint
    const rolesCtx = (p.roles && p.roles.length)
      ? `Roles: ${Array.isArray(p.roles) ? p.roles.join(', ') : p.roles}.` : '';
    const threadsCtx = (p.active_threads && p.active_threads.length)
      ? `Active projects: ${Array.isArray(p.active_threads) ? p.active_threads.join(', ') : p.active_threads}.` : '';
    const buildingCtx = p.building ? `Currently building: ${p.building}.` : '';
    const chapterCtx = p.chapter ? `Current chapter: ${p.chapter}.` : '';
    const focusCtx = p.focus ? `Current focus: ${p.focus}.` : '';

    // Use frontend-provided systemPrompt if available, else default
    const sys = systemPrompt || `You are the Oracle at Cosmic Daily Planner, the same voice that wrote today's full reading. A reader is asking a follow-up or deeper question.

YOUR VOICE: The best Jungian analyst meets the Swiss Ephemeris. Precise. Personal. Grounded. Emotionally intelligent.

RULES:
- Address ${firstName} by name throughout.
- Speak directly from the cosmic data provided. Never invent planetary positions.
- 4-6 sentences of depth. No bullet points. No lists.
- End with one precise question for ${firstName} to sit with, the one that, if answered honestly, would move something.
- Reference their specific personal context, projects, and relationships where relevant and by name.
- Dreamspell always labelled as Argüelles (1987) modern system, distinct from ancient K'iche' tradition.
- Draw on: Tarnas (2006), Greene (1976), Hand (2002), Brady (1999), Drayer (2002) where relevant.
- If the full reading has not yet completed, respond from the raw cosmic data provided. Never say you don't have enough information.`;

    const fullContext = [
      context ? `Today's reading context: ${context}` : '',
      readingData?.synthesis ? `Oracle synthesis: ${readingData.synthesis}` : '',
      readingData?.shadow_work ? `Shadow work: ${readingData.shadow_work}` : '',
      readingData?.astrology?.main_transit_headline ? `Main transit: ${readingData.astrology.main_transit_headline}` : '',
      readingData?.numerology?.headline ? `Numerology: ${readingData.numerology.headline}` : '',
      p.context ? `Personal context: ${p.context}` : '',
      rolesCtx, threadsCtx,
      buildingCtx, chapterCtx, focusCtx,
      p.birthDay ? `Born: ${p.birthDay}/${p.birthMonth}/${p.birthYear}${p.birthTime ? ' at ' + p.birthTime : ''}${p.birthLocation ? ' in ' + p.birthLocation : ''}` : '',
    ].filter(Boolean).join('\n');

    const askAttBlocks = buildAttachmentBlocks(req.body.attachments);
    const sysWithAtt = askAttBlocks.length
      ? sys + attachmentReflectionNote(askAttBlocks.length)
      : sys;
    const askText = `${fullContext}\n\nQuestion from ${firstName}: ${question}`;
    const askContent = userContentWith(askText, req.body.attachments);
    const ans = await callAPI('claude-sonnet-4-6', 2500, sysWithAtt, askContent);
    res.json({answer: ans});
  } catch(e) {
    console.error('Ask error:', e.message);
    res.status(500).json({error: e.message});
  }
});

// Emerging patterns synthesis. Layer two of the pattern engine. It does not
// hunt raw text for patterns on its own; it is handed the substance of what the
// person brings and engages, plus any thematic memory of past readings, and its
// one job is to name what is actually emerging in that content, the through-line
// a careful reader would notice and they might not have named. Reading-style
// facts (which lens or framework lands) are deliberately kept out: that is how
// they read, not what is emerging, and must never be the subject. Observation
// only. It names the absence of a through-line as readily as the presence of one.
app.post('/api/patterns', async (req, res) => {
  try {
    const { lens, facts, items, readings } = req.body || {};
    const safeItems = Array.isArray(items)
      ? items.filter((s) => typeof s === 'string' && s.trim()).slice(0, 24)
      : [];
    const landedCount = (facts && typeof facts.landedCount === 'number') ? facts.landedCount : 0;

    // Substantive thematic memory, when it exists. Per-reading summaries hold the
    // themes and insight of past readings, which is where emergence actually
    // lives. This activates as readings persist summaries; when empty, the
    // synthesis works from the brought items alone.
    let memory = [];
    try {
      if (typeof v19_userKey === 'function' && typeof v19_summaries !== 'undefined') {
        const uid = v19_userKey(req);
        if (uid && v19_summaries.has(uid)) {
          memory = (v19_summaries.get(uid) || [])
            .slice(-12)
            .map((s) => ({ themes: Array.isArray(s.themes) ? s.themes : [], insight: (s.insight || '').trim() }))
            .filter((s) => s.insight);
        }
      }
    } catch (_e) {
      memory = [];
    }

    // Honesty before eagerness: too little substance to find a real through-line.
    if (safeItems.length < 2 && memory.length < 1 && landedCount < 3) {
      return res.json({ linked: false, observation: '' });
    }

    const voiceWord = lens === 'science' ? 'Science' : lens === 'tradition' ? 'Tradition' : 'Everyday';

    const material = [
      safeItems.length ? 'What this person has been bringing, most recent first, questions and passing comments and deliberate intentions all as equal material:\n' + safeItems.map((s, i) => (i + 1) + '. ' + s).join('\n') : '',
      memory.length ? 'Themes and insights that surfaced across their recent readings:\n' + memory.map((m, i) => (i + 1) + '. ' + (m.themes.length ? '[' + m.themes.join(', ') + '] ' : '') + m.insight).join('\n') : '',
      (Array.isArray(readings) && readings.length) ? 'Recent reading coordinates, for provenance only, not the subject:\n' + readings.slice(0, 12).join('\n') : '',
    ].filter(Boolean).join('\n\n');

    const sys = `You are the reflective intelligence of Cosmic Daily Planner, writing one short observation for the Emerging patterns panel.

What is emerging means the substance moving through what this person brings and engages: the concern they keep circling, the question that keeps returning under different surfaces, the theme that links an offhand ask to something larger they are working out. A brief or passing item is often the first surfacing of something not yet named, so treat it as a possible edge of something central rather than as noise.

Your one job is to name what is actually emerging in the content of their material, the through-line a careful reader would notice and that they might not have named themselves, and to put it in front of them as an observation they can recognise.

Constraints. Speak only from the material given. Do not make the observation about which voice, lens, framework, or telescope they prefer; that is reading style, not emergence, and it is not the subject here. Introduce no theme, fact, or claim that is not present in the material. Observation only, never a forecast, never advice, never an instruction. Do not end with a question. Do not ask the person what they are holding or carrying or sitting with, since that register is not used here. Write in the ${voiceWord} voice, plain and grounded, with no decorative or AI poetic phrasing. If there is no genuine through-line yet, do not manufacture one.`;

    const user = material + `

Return only a JSON object and nothing else, no preface and no code fence: {"linked": boolean, "observation": string}. Set linked to true only when a real through-line in the substance is present, a recurring concern or theme that connects more than one item. When nothing genuine connects yet, set linked to false and observation to an empty string. The observation, when present, is two to four sentences of plain prose naming what is emerging, observation only, with no closing question and no instruction.`;

    const raw = await callAPI('claude-sonnet-4-6', 700, sys, user);
    let out = { linked: false, observation: '' };
    try {
      const cleaned = String(raw).replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed.observation === 'string') {
        const obs = parsed.observation.trim();
        out = { linked: !!parsed.linked && obs.length > 0, observation: obs.length > 0 ? obs : '' };
      }
    } catch (_e) {
      out = { linked: false, observation: '' };
    }
    res.json(out);
  } catch (e) {
    console.error('Patterns synthesis error:', e.message);
    // Degrade silently: the deterministic floor on the client still stands.
    res.status(200).json({ linked: false, observation: '' });
  }
});

app.post('/api/calendar', (req, res) => {
  const {year, month, profile} = req.body;
  const y = year || new Date().getFullYear();
  const m = month || new Date().getMonth() + 1;
  const days = new Date(y, m, 0).getDate();
  const p = profile || {};
  const result = [];
  for (let d = 1; d <= days; d++) {
    const ds = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const moon = getMoon(ds);
    const kin = getKin(ds);
    const num = getNumerology(ds, p.birthDay, p.birthMonth, p.birthYear);
    // Master number class for calendar styling
    const masterClass = num.isMasterDay
      ? (num.ud===11?'master-11':num.ud===22?'master-22':num.ud===33?'master-33':'master-44')
      : '';
    result.push({
      d, ds,
      // Moon
      moon: { phase: moon.phase, emoji: moon.emoji, cycle: moon.cycle, pct: moon.pct,
        toNew: moon.toNew, toFull: moon.toFull,
        isBlack: moon.isBlack, isShiva: moon.isShiva,
        isNewMoon: moon.isNewMoon, isFullMoon: moon.isFullMoon },
      // Dreamspell
      kin: { kin: kin.kin, tone: kin.tone, toneNum: kin.toneNum, seal: kin.seal,
        color: kin.color, full: kin.full, isGAP: kin.isGAP },
      // Universal day numerology
      ud: num.ud, udN: num.udM?.n, udK: num.udM?.k,
      mEn: num.mEn, mEnN: num.mEnM?.n,
      yEn: num.yEn, yEnN: num.yEnM?.n,
      // Personal numerology (if birth data available)
      pd: num.pd, pdN: num.pdM?.n,
      pm: num.pm, pmN: num.pmM?.n,
      py: num.py, pyN: num.pyM?.n,
      // Three energies
      threeEnergies: num.threeEnergies,
      // Flags
      isMasterDay: num.isMasterDay,
      isSpecialDay: num.isSpecialDay,
      isGAP: kin.isGAP,
      masterClass,
    });
  }
  res.json(result);
});

// ── DAY DETAIL, full framework data for a single day ──
app.post('/api/daydetail', (req, res) => {
  const {date, profile} = req.body;
  if (!date) return res.status(400).json({error:'date required'});
  const p = profile || {};
  try {
    const planets = buildPlanets(date);
    const moon = getMoon(date);
    const kin = getKin(date);
    const num = getNumerology(date, p.birthDay, p.birthMonth, p.birthYear);
    const aspects = getAspects(planets);
    // Key aspects, top 3 for day detail
    const topAspects = aspects.slice(0,3).map(a => ({
      label: a.label, desc: a.desc, str: a.str, aspect: a.aspect }));
    res.json({
      date, planets, moon, kin, num, topAspects,
      // Highlight summary for display
      summary: {
        moonPhase: `${moon.emoji} ${moon.phase} (day ${moon.cycle} of cycle)`,
        moonAlert: moon.isBlack ? '⚠️ Black Moon, two days before New Moon. A threshold: inward, cautious, no major launches.'
          : moon.isShiva ? '✨ Shiva Moon, two days after New Moon. Auspicious, generative. Plant intentions now.'
          : moon.isNewMoon ? '🌑 New Moon, the cycle begins. Set intentions in silence.'
          : moon.isFullMoon ? '🌕 Full Moon, peak illumination. What is ready to be seen or released?'
          : '',
        kinFull: kin.full,
        gapAlert: kin.isGAP ? '★ Galactic Activation Portal, heightened sensitivity. Pay close attention to what arrives.' : '',
        universalDay: `${num.ud}${[11,22,33,44].includes(num.ud)?'★':''}: ${num.udM?.n||''}`,
        monthEnergy: `${num.mEn}: ${num.mEnM?.n||''}`,
        yearEnergy: `${num.yEn}: ${num.yEnM?.n||''}`,
        personalDay: num.pd ? `${num.pd}${[11,22,33,44].includes(num.pd)?'★':''}: ${num.pdM?.n||''}` : null,
        personalMonth: num.pm ? `${num.pm}: ${num.pmM?.n||''}` : null,
        personalYear: num.py ? `${num.py}: ${num.pyM?.n||''}` : null,
        threeEnergies: num.threeEnergies,
        masterAlert: num.isMasterDay ? `★ Master Number ${num.ud} Day (${num.udM?.n}) portals wide open` : '',
        specialAlert: num.isSpecialDay ? `✧ Day ${num.ud}: ${num.udM?.n}, a day of particular depth` : '',
      }
    });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ══════════════════════════════════════════════════════════════════
// BIORHYTHM CALCULATOR
// Classical three-cycle theory: physical 23d, emotional 28d, intellectual 33d
// All sine waves from birth date (Teltscher, Fliess, Swoboda, early 20thC)
// Critical days = zero crossings (most significant days)
// ══════════════════════════════════════════════════════════════════
function getBiorhythms(birthDateStr, targetDateStr) {
  const birth = new Date(birthDateStr + 'T12:00:00Z');
  const target = new Date(targetDateStr + 'T12:00:00Z');
  const days = Math.round((target - birth) / 86400000);

  const cycles = {
    physical:     { period: 23,  label: 'Physical',     desc: 'vitality, strength, coordination, stamina' },
    emotional:    { period: 28,  label: 'Emotional',    desc: 'mood, sensitivity, creativity, intuition' },
    intellectual: { period: 33,  label: 'Intellectual', desc: 'reasoning, memory, decision-making, alertness' },
  };

  const result = {};
  for (const [key, c] of Object.entries(cycles)) {
    const value = Math.sin((2 * Math.PI * days) / c.period);
    const pct   = Math.round(value * 100);
    // Critical day = within 1 day of zero crossing
    const nextDay = Math.sin((2 * Math.PI * (days + 1)) / c.period);
    const isCritical = (value >= 0 && nextDay < 0) || (value < 0 && nextDay >= 0)
      || Math.abs(value) < 0.13;
    const phase = isCritical ? 'critical'
      : value > 0.6  ? 'high'
      : value > 0.1  ? 'rising'
      : value > -0.1 ? 'transition'
      : value > -0.6 ? 'falling'
      : 'low';
    result[key] = { value: parseFloat(value.toFixed(3)), pct, phase, isCritical,
      period: c.period, label: c.label, desc: c.desc, dayOfCycle: days % c.period };
  }

  // Composite score: weighted average
  const composite = Math.round((result.physical.pct * 0.4) +
    (result.emotional.pct * 0.35) + (result.intellectual.pct * 0.25));

  return { ...result, composite, daysAlive: days };
}

function getBiorhythmSynastry(bioA, bioB) {
  // Compare where both people sit on their cycles today
  const out = [];
  for (const key of ['physical', 'emotional', 'intellectual']) {
    const a = bioA[key];
    const b = bioB[key];
    const diff = Math.abs(a.pct - b.pct);
    const bothCritical = a.isCritical && b.isCritical;
    const aligned = diff < 20; // within 20% of each other
    const opposed = diff > 70 && ((a.pct > 0 && b.pct < 0) || (a.pct < 0 && b.pct > 0));

    out.push({
      cycle: a.label,
      aPhase: a.phase, aPct: a.pct,
      bPhase: b.phase, bPct: b.pct,
      diff, aligned, opposed, bothCritical,
      dynamic: bothCritical ? 'Both in critical transition, take care'
        : aligned && a.pct > 30 ? 'Both running high, strong shared energy'
        : aligned && a.pct < -30 ? 'Both low, a good time to rest together, not push'
        : opposed ? 'Out of phase, one high, one low. Patience and adaptation needed'
        : 'Mixed, complement each other\'s energy today'
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
// NUMEROLOGY CROSS-ANALYSIS
// LP compatibility (Drayer 2002, Millman 1993 Life You Were Born to Live)
// ══════════════════════════════════════════════════════════════════
const LP_COMPAT = {
  '1-1': { quality: 'Resonant independence', dynamic: 'Two strong wills, inspiring when aligned, competitive when not. Leadership must be shared consciously.' },
  '1-2': { quality: 'Complementary polarity', dynamic: 'The initiator and the nurturer. Natural fit when both roles are honoured. 2 softens 1\'s edges; 1 gives 2 direction.' },
  '1-3': { quality: 'Creative momentum', dynamic: 'High-energy, expressive pairing. 1 leads, 3 brings joy and communication. Risk: both can be self-focused.' },
  '1-4': { quality: 'Vision and structure', dynamic: '1 dreams, 4 builds. Powerful if the 4 doesn\'t stifle 1\'s initiative, and the 1 respects the 4\'s need for order.' },
  '1-5': { quality: 'Freedom and fire', dynamic: 'Both love independence. Exciting but can be unstable, neither naturally prioritises the relationship.' },
  '1-6': { quality: 'Leadership and care', dynamic: '1 leads outward, 6 holds the home. Strong if 6\'s nurturing isn\'t seen as control, and 1\'s independence isn\'t abandonment.' },
  '1-7': { quality: 'Inner and outer mastery', dynamic: '1 acts, 7 reflects. They operate on different planes, potential for profound complementarity or mutual frustration.' },
  '1-8': { quality: 'Power pairing', dynamic: 'Both driven. High potential for material success together. Risk: competition and control battles.' },
  '1-9': { quality: 'The pioneer and the sage', dynamic: '1\'s new beginnings meet 9\'s wisdom and completion. 9 can guide 1; 1 can reignite 9\'s forward momentum.' },
  '2-2': { quality: 'Deep emotional resonance', dynamic: 'Highly sensitive pairing. Beautiful emotional depth, but both may wait for the other to lead.' },
  '2-3': { quality: 'Heart and voice', dynamic: '2\'s depth of feeling expressed through 3\'s communication. Warm and creative. Risk: 3 can seem superficial to 2.' },
  '2-4': { quality: 'Stability and sensitivity', dynamic: 'Very compatible. 2 brings emotional depth, 4 brings security. Strong domestic foundation.' },
  '2-5': { quality: 'The tension of need vs freedom', dynamic: '2 needs closeness; 5 needs space. This tension can be creative or exhausting depending on awareness.' },
  '2-6': { quality: 'Devotion and harmony', dynamic: 'Naturally aligned. Both care deeply, both prioritise relationship. Risk: enmeshment or avoiding necessary conflict.' },
  '2-7': { quality: 'The seen and the unseen', dynamic: '2 operates emotionally; 7 operates intellectually and spiritually. Deep potential if each accepts the other\'s mode.' },
  '2-8': { quality: 'Sensitivity meets power', dynamic: '2 feels everything 8 projects. 8 must learn care; 2 must learn not to absorb 8\'s intensity as personal.' },
  '2-9': { quality: 'Heart resonance', dynamic: 'Both compassionate, both giving. Deeply harmonious. Risk: both may sacrifice too much.' },
  '3-3': { quality: 'Joyful creative chaos', dynamic: 'Brilliant fun, creative explosion. Risk: neither grounds the other, and both can be emotionally avoidant.' },
  '3-4': { quality: 'Creativity meets structure', dynamic: '3 expands, 4 contains. Productive if 4 doesn\'t dampen 3\'s spark, and 3 respects 4\'s need for order.' },
  '3-5': { quality: 'Expression and adventure', dynamic: 'High energy, sociable, fun. Both resist routine. May lack the depth to weather difficulty.' },
  '3-6': { quality: 'Heart and hearth', dynamic: '3\'s lightness meets 6\'s warmth. Beautiful combination. 6\'s care grounds 3; 3\'s joy uplifts 6.' },
  '3-7': { quality: 'Surface and depth', dynamic: '3 skims the surface delightfully; 7 dives deep. Can complement beautifully, or talk past each other entirely.' },
  '3-8': { quality: 'Charm and authority', dynamic: '3 is social, 8 is powerful. 3 can open doors 8 cannot; 8 can provide the solidity 3 needs.' },
  '3-9': { quality: 'Creative wisdom', dynamic: 'Both generous, both expressive. 9\'s wisdom tempers 3\'s restlessness. High creative and spiritual potential.' },
  '4-4': { quality: 'The builders', dynamic: 'Stable, reliable, productive. May be too similar, can be rigid. Needs conscious injection of joy and spontaneity.' },
  '4-5': { quality: 'Structure vs freedom', dynamic: 'Significant tension. 4 needs order; 5 fights it. Both must stretch well beyond their comfort zone.' },
  '4-6': { quality: 'The foundation', dynamic: 'One of the most compatible pairings. Both responsible, both devoted. Risk: life becomes all duty and no play.' },
  '4-7': { quality: 'Pragmatism and philosophy', dynamic: '4 builds in the world; 7 seeks inner truth. Can be deeply complementary, 7 gives meaning to 4\'s efforts.' },
  '4-8': { quality: 'The power builders', dynamic: 'Both capable of great achievement together. 4 provides the plan, 8 provides the drive. Risk: all work, no intimacy.' },
  '4-9': { quality: 'The long view', dynamic: '4\'s methodical nature meets 9\'s universal perspective. 9 can inspire 4 beyond the material; 4 can help 9 manifest.' },
  '5-5': { quality: 'The free spirits', dynamic: 'Exhilarating and chaotic. Both need change. May have difficulty committing or creating lasting structure.' },
  '5-6': { quality: 'Freedom and responsibility', dynamic: '5 wants to fly; 6 wants to nest. This tension is constant. Can work beautifully if each honours the other\'s need.' },
  '5-7': { quality: 'The seekers', dynamic: 'Both restless in their different ways. 5 seeks experience; 7 seeks understanding. Interesting intellectual companionship.' },
  '5-8': { quality: 'Energy and ambition', dynamic: 'High-voltage pairing. Both driven, both capable. 5\'s versatility and 8\'s focus can be powerful together.' },
  '5-9': { quality: 'The adventurers', dynamic: 'Both expansive, both drawn to the wider world. 9\'s wisdom can give 5\'s adventures direction and meaning.' },
  '6-6': { quality: 'The devoted', dynamic: 'Deep caring and mutual commitment. Risk: over-responsibility for each other, difficulty receiving as well as giving.' },
  '6-7': { quality: 'Warmth and wisdom', dynamic: '6\'s heart and 7\'s mind. Beautiful if each accepts the other\'s mode of relating. 7 may seem cold to 6; 6 may seem needy to 7.' },
  '6-8': { quality: 'Care and command', dynamic: '6 serves, 8 leads. Works if 8 reciprocates care; risks imbalance if 6 gives and 8 takes.' },
  '6-9': { quality: 'The humanitarians', dynamic: 'Both give themselves to others. Deeply aligned in values. Risk: neither focuses enough on their own relationship.' },
  '7-7': { quality: 'The philosophers', dynamic: 'Rare depth of intellectual and spiritual understanding. Risk: both retreat inward and the relationship starves of warmth.' },
  '7-8': { quality: 'The thinker and the achiever', dynamic: '7\'s insight informs 8\'s action. Powerful if each respects the other\'s domain.' },
  '7-9': { quality: 'Depth upon depth', dynamic: 'Both oriented toward meaning and truth. Profound potential for spiritual and intellectual growth together.' },
  '8-8': { quality: 'The magnates', dynamic: 'Extraordinary potential, and extraordinary risk. Power dynamics must be managed consciously or this becomes a battle.' },
  '8-9': { quality: 'Material and spiritual', dynamic: '8 builds in the world; 9 transcends it. 9 can soften 8\'s drive; 8 can help 9 manifest their vision.' },
  '9-9': { quality: 'Universal love', dynamic: 'Deeply aligned in compassion and wisdom. Risk: both may be so oriented toward others that the relationship itself is neglected.' },
};

function getNumerologyCrossAnalysis(numA, numB, nameA, nameB) {
  if (!numA || !numB) return null;
  const lpA = numA.lp;
  const lpB = numB.lp;
  if (!lpA || !lpB) return null;

  // Normalize LP pair for lookup (always lower first)
  const key = lpA <= lpB ? (lpA + '-' + lpB) : (lpB + '-' + lpA);
  const compat = LP_COMPAT[key] || { quality: 'Unique pairing', dynamic: 'A less common Life Path combination with its own unrepeated qualities.' };

  // Personal Year interaction
  const pyA = numA.py;
  const pyB = numB.py;
  let pyDynamic = '';
  if (pyA && pyB) {
    const pySum = reduce(pyA + pyB);
    if (pyA === pyB) pyDynamic = 'Both in Personal Year ' + pyA + ' simultaneously, a year of shared themes and mirrored lessons.';
    else if (Math.abs(pyA - pyB) === 1 || Math.abs(pyA - pyB) === 8) pyDynamic = 'Personal Years ' + pyA + ' and ' + pyB + ' are adjacent phases, one slightly ahead of the other in the nine-year cycle. This creates a natural mentoring dynamic this year.';
    else if (pyA + pyB === 10 || pyA + pyB === 19) pyDynamic = 'Personal Years ' + pyA + ' and ' + pyB + ' are complementary within the cycle, what one is releasing, the other is beginning.';
    else pyDynamic = 'Personal Year ' + pyA + ' (' + nameA + ') and Personal Year ' + pyB + ' (' + nameB + '), different life themes active this year. Understanding each other\'s current chapter is essential.';
  }

  // Combined Life Path
  const combined = reduce(lpA + lpB);
  const combinedData = NUM[combined] || {};

  return {
    lpA, lpB,
    quality: compat.quality,
    dynamic: compat.dynamic,
    pyDynamic,
    combined, combinedName: combinedData.n || '',
    combinedMeaning: 'The combined energy of this relationship carries the frequency of ' + combined + ' (' + (combinedData.n || '') + '), the numerological signature of what this partnership is here to create or learn.'
  };
}

// ══════════════════════════════════════════════════════════════════
// DREAMSPELL SYNASTRY, The Five Oracle Relationships
// Arguelles (1987) The Mayan Factor
// Each Kin has four oracle relationships derived from it:
// Analog, Antipode, Occult, Guide
// ══════════════════════════════════════════════════════════════════
function getDreamspellSynastry(kinA, kinB) {
  if (!kinA || !kinB) return null;

  const kinNumA = kinA.kin;
  const kinNumB = kinB.kin;

  // Color chromatic family relationship
  const colorA = kinA.color; // Red, White, Blue, Yellow
  const colorB = kinB.color;
  const COLOR_PARTNERS = { Red: 'White', White: 'Red', Blue: 'Yellow', Yellow: 'Blue' };
  const chromatic = colorA === colorB ? 'same-tribe'
    : COLOR_PARTNERS[colorA] === colorB ? 'chromatic-partner'
    : 'cross-family';

  const chromaticDesc = {
    'same-tribe': colorA + ' tribe, you share the same chromatic family. Natural resonance in how you process and express energy. You understand each other\'s fundamental mode without explanation.',
    'chromatic-partner': colorA + ' and ' + colorB + ' are complementary partner colours. This is one of the most harmonious pairings in Dreamspell. Your energies naturally complete each other.',
    'cross-family': colorA + ' and ' + colorB + ' belong to different colour families. Your modes of engaging with reality are genuinely different, which creates richness and the need for translation.',
  }[chromatic];

  // Tonal relationship
  const toneA = kinA.toneNum;
  const toneB = kinB.toneNum;
  const toneSum = ((toneA + toneB - 1) % 13) + 1;
  const toneRelation = toneA === toneB ? 'resonant tones, you pulse at the same frequency'
    : toneSum === 14 ? 'complementary tones (sum to 14), you complete each other\'s vibrational arc'
    : 'distinct tones, each brings a different quality of intention and power';

  // Kin difference relationship
  const kinDiff = Math.abs(kinNumA - kinNumB);
  const kinSum = ((kinNumA + kinNumB - 1) % 260) + 1;

  // Are they in the same wavespell (13-day arc)?
  const wavespellA = Math.floor((kinNumA - 1) / 13);
  const wavespellB = Math.floor((kinNumB - 1) / 13);
  const sameWavespell = wavespellA === wavespellB;

  // GAP relationship
  const bothGAP = kinA.isGAP && kinB.isGAP;
  const oneGAP = (kinA.isGAP || kinB.isGAP) && !bothGAP;

  // Combined Kin
  const combinedKin = kinSum;
  const combinedSeal = SEALS[(combinedKin - 1) % 20];
  const combinedTone = TONES[(combinedKin - 1) % 13];
  const combinedColor = ['Red','White','Blue','Yellow'][(combinedKin - 1) % 4];

  return {
    kinA: kinNumA, kinB: kinNumB,
    chromatic, chromaticDesc,
    toneA, toneB, toneRelation,
    sameWavespell,
    bothGAP, oneGAP,
    combinedKin,
    combinedFull: 'Kin ' + combinedKin + ' - ' + combinedColor + ' ' + combinedTone + ' ' + combinedSeal,
    combinedMeaning: 'The combined Kin of this relationship is ' + combinedColor + ' ' + combinedTone + ' ' + combinedSeal + ' - the galactic signature of what this connection is here to embody and transmit together.',
    wavespellNote: sameWavespell ? 'You were born in the same wavespell, a rare and significant bond.' : 'Born in different wavespells, your 13-day arcs create a dynamic interplay of different intentions.'
  };
}

// ══════════════════════════════════════════════════════════════════
// NATAL MOON PHASE
// What lunar phase was active when each person was born?
// ══════════════════════════════════════════════════════════════════
const MOON_PHASE_NAMES = [
  { max: 1.5,  name: 'New Moon',         archetype: 'The Initiator, spontaneous, instinctive, driven by feeling over reflection' },
  { max: 7.5,  name: 'Waxing Crescent',  archetype: 'The Seeker, gathering energy, building toward something, full of possibility' },
  { max: 8.5,  name: 'First Quarter',    archetype: 'The Builder, decisive, action-oriented, willing to push through resistance' },
  { max: 14.5, name: 'Waxing Gibbous',   archetype: 'The Refiner, analytical, perfection-seeking, always improving' },
  { max: 16.5, name: 'Full Moon',        archetype: 'The Illuminator (relational, aware, seen and seeing) fulfillment through others' },
  { max: 22.5, name: 'Waning Gibbous',   archetype: 'The Messenger, drawn to share wisdom, teach, contribute to the larger story' },
  { max: 23.5, name: 'Last Quarter',     archetype: 'The Reorienteer, reassessing, releasing, turning away from what no longer fits' },
  { max: 30,   name: 'Waning Crescent',  archetype: 'The Mystic, finishing cycles, surrendering, deeply intuitive and contemplative' },
];

function getNatalMoonPhase(birthDateStr) {
  const moon = getMoon(birthDateStr);
  const cyc = parseFloat(moon.cycle);
  const found = MOON_PHASE_NAMES.find(p => cyc <= p.max) || MOON_PHASE_NAMES[MOON_PHASE_NAMES.length - 1];
  return {
    phase: found.name,
    archetype: found.archetype,
    cycle: cyc,
    pct: moon.pct
  };
}

function getMoonPhaseSynastry(phaseA, phaseB, nameA, nameB) {
  if (!phaseA || !phaseB) return null;

  // Phase type: waxing vs waning
  const waxingPhases = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous'];
  const aWaxing = waxingPhases.includes(phaseA.phase);
  const bWaxing = waxingPhases.includes(phaseB.phase);

  let dynamicNote = '';
  if (phaseA.phase === phaseB.phase) {
    dynamicNote = 'Born under the same lunar phase, you share a fundamental emotional rhythm and approach to relationship. This creates deep instinctive understanding.';
  } else if (aWaxing && !bWaxing) {
    dynamicNote = nameA + ' was born under a waxing moon (building energy) and ' + nameB + ' under a waning moon (integrating energy). One of you naturally initiates; the other naturally synthesises and completes. This is a powerful creative polarity.';
  } else if (!aWaxing && bWaxing) {
    dynamicNote = nameB + ' was born under a waxing moon (building energy) and ' + nameA + ' under a waning moon (integrating energy). One of you naturally initiates; the other naturally synthesises and completes. This is a powerful creative polarity.';
  } else if (aWaxing && bWaxing) {
    dynamicNote = 'Both born under waxing moons, you both naturally build, initiate, and reach toward new things. This creates momentum and possibility, with care needed around slowing down and integrating.';
  } else {
    dynamicNote = 'Both born under waning moons, you both naturally turn inward, integrate, and release. Deep shared wisdom and contemplative depth. You may need to consciously inject new energy and forward motion.';
  }

  return {
    phaseA: phaseA.phase, archetypeA: phaseA.archetype,
    phaseB: phaseB.phase, archetypeB: phaseB.archetype,
    dynamicNote
  };
}

// ══════════════════════════════════════════════════════════════════
// NATAL PLANETARY POSITIONS
// ══════════════════════════════════════════════════════════════════
// Uses J2000.0 epoch mean longitudes + mean daily motion
// Accuracy: Sun ±1°, Moon ±5°, inner planets ±5-10°, outer ±2-5°
// Sufficient for synastry interpretation; always labelled as approximate
// Source: Meeus (1998) Astronomical Algorithms, Table 31.a + 32.a
// ══════════════════════════════════════════════════════════════════
const J2000 = new Date('2000-01-01T12:00:00Z');

// [mean longitude at J2000, mean daily motion °/day]
const MEAN_MOTION = {
  Sun:     [280.46646,  0.98564736],
  Moon:    [218.31665, 13.17639648],
  Mercury: [252.25032,  4.09233445],
  Venus:   [181.97980,  1.60213034],
  Mars:    [355.45332,  0.52402068],
  Jupiter: [ 34.35148,  0.08308529],
  Saturn:  [ 50.07747,  0.03344876],
  Uranus:  [314.05501,  0.01172834],
  Neptune: [304.34867,  0.00598103],
  Pluto:   [238.92881,  0.00397057],
};

function getNatalPlanets(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const days = (d - J2000) / 86400000;
  return Object.entries(MEAN_MOTION).map(([name, [l0, motion]]) => {
    const deg = ((l0 + motion * days) % 360 + 360) % 360;
    return { name, deg, sign: getSign(deg), degStr: `${getDegInSign(deg)}° ${getSign(deg)}` };
  });
}

function getSunSign(day, month, year) {
  const d = new Date(`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T12:00:00Z`);
  const jDays = (d - J2000) / 86400000;
  const sunLon = ((280.46646 + 0.98564736 * jDays) % 360 + 360) % 360;
  return { sign: getSign(sunLon), deg: sunLon, degStr: `${getDegInSign(sunLon)}° ${getSign(sunLon)}` };
}

function getSynastryAspects(planetsA, planetsB) {
  // Cross-aspects: each of A's planets vs each of B's key planets
  const keyB = ['Sun','Moon','Venus','Mars','Saturn'];
  const keyA = ['Sun','Moon','Venus','Mars','Saturn','Mercury','Jupiter'];
  const out = [];
  for (const a of planetsA.filter(p => keyA.includes(p.name))) {
    for (const b of planetsB.filter(p => keyB.includes(p.name))) {
      let diff = Math.abs(a.deg - b.deg);
      if (diff > 180) diff = 360 - diff;
      for (const asp of ASPS) {
        const orb = Math.abs(diff - asp.d);
        if (orb <= asp.orb) {
          const str = Math.max(1, 5 - Math.floor(orb / (asp.orb / 5)));
          out.push({
            pA: a.name, pB: b.name, aspect: asp.n, sym: asp.sym,
            orb: orb.toFixed(1), str,
            label: `${a.name} (A) ${asp.sym} ${b.name} (B)`,
            desc: `${a.name} ${a.degStr} ${asp.n} ${b.name} ${b.degStr} (${orb.toFixed(1)}° orb)`
          });
          break;
        }
      }
    }
  }
  return out.sort((a, b) => b.str - a.str).slice(0, 8);
}

// ── COMPATIBILITY ENDPOINT ──
app.post('/api/compatibility', async (req, res) => {
  const { personA, personB, topic, customContext } = req.body;
  if (!personA || !personB) return res.status(400).json({ error: 'Both people required' });

  try {
    const pA = normaliseProfileFields(personA);
    const pB = normaliseProfileFields(personB);

    const today = new Date().toISOString().slice(0, 10);

    // Build birth date strings
    const dateA = pA.birthYear && pA.birthMonth && pA.birthDay
      ? `${pA.birthYear}-${String(pA.birthMonth).padStart(2,'0')}-${String(pA.birthDay).padStart(2,'0')}`
      : null;
    const dateB = pB.birthYear && pB.birthMonth && pB.birthDay
      ? `${pB.birthYear}-${String(pB.birthMonth).padStart(2,'0')}-${String(pB.birthDay).padStart(2,'0')}`
      : null;

    // ── CHINESE ZODIAC (6th framework) ──
    const _CAN = ['Rat','Ox','Tiger','Rabbit','Dragon','Snake','Horse','Goat','Monkey','Rooster','Dog','Pig'];
    const _CEL = ['Metal','Metal','Water','Water','Wood','Wood','Fire','Fire','Earth','Earth'];
    const _CNY = {1950:[1,27],1951:[2,6],1952:[1,27],1953:[2,14],1954:[2,3],1955:[1,24],1956:[2,12],
      1957:[1,31],1958:[2,18],1959:[2,8],1960:[1,28],1961:[2,15],1962:[2,5],1963:[1,25],1964:[2,13],
      1965:[2,2],1966:[1,21],1967:[2,9],1968:[1,30],1969:[2,17],1970:[2,6],1971:[1,27],1972:[2,15],
      1973:[2,3],1974:[1,23],1975:[2,11],1976:[1,31],1977:[2,18],1978:[2,7],1979:[1,28],1980:[2,16],
      1981:[2,5],1982:[1,25],1983:[2,13],1984:[2,2],1985:[2,20],1986:[2,9],1987:[1,29],1988:[2,17],
      1989:[2,6],1990:[1,27],1991:[2,15],1992:[2,4],1993:[1,23],1994:[2,10],1995:[1,31],1996:[2,19],
      1997:[2,7],1998:[1,28],1999:[2,16],2000:[2,5],2001:[1,24],2002:[2,12],2003:[2,1],2004:[1,22],
      2005:[2,9],2006:[1,29],2007:[2,18],2008:[2,7],2009:[1,26],2010:[2,14],2011:[2,3],2012:[1,23],
      2013:[2,10],2014:[1,31],2015:[2,19],2016:[2,8],2017:[1,28],2018:[2,16],2019:[2,5],2020:[1,25],
      2021:[2,12],2022:[2,1],2023:[1,22],2024:[2,10],2025:[1,29],2026:[2,17]};
    function _chSign(y,bm,bd){
      let e=parseInt(y);
      if(bm&&bd&&_CNY[e]){const[cm,cd]=_CNY[e];if(parseInt(bm)<cm||(parseInt(bm)===cm&&parseInt(bd)<cd))e--;}
      return{animal:_CAN[((e-1900)%12+12)%12],element:_CEL[((e-1900)%10+10)%10],year:e};
    }
    // 12-animal affinity/clash system (Three Harmonies + Six Clashes)
    const _CC = {
      'Rat-Dragon':{t:'Affinity',q:'Natural strategic alliance, shared ambition and drive',d:'Rat\'s cleverness amplifies Dragon\'s vision. Formidable together.'},
      'Rat-Monkey':{t:'Affinity',q:'Brilliant inventive partnership',d:'Both quick-witted and adaptable. Risk: each may outmanoeuvre the other.'},
      'Rat-Ox':{t:'Best Match',q:'Deeply complementary, the most stable pairing',d:'Rat\'s intelligence + Ox\'s dependability = enduring foundation.'},
      'Rat-Horse':{t:'Clash',q:'Opposing core needs',d:'Rat needs closeness; Horse needs freedom. Growth comes from honouring both.'},
      'Rat-Rabbit':{t:'Neutral',q:'Different rhythms, genuine warmth possible',d:'Rat active and strategic; Rabbit gentle and artistic. Complementary if patient.'},
      'Tiger-Horse':{t:'Affinity',q:'Adventurous, bold, mutually inspiring',d:'Both independent spirits. High energy; must consciously build shared ground.'},
      'Tiger-Dog':{t:'Affinity',q:'Loyal, idealistic, deeply aligned in values',d:'Profound trust and shared humanitarian outlook.'},
      'Tiger-Monkey':{t:'Clash',q:'Fundamental difference of approach',d:'Tiger direct; Monkey tactical. Productive if approached consciously.'},
      'Rabbit-Goat':{t:'Affinity',q:'Gentle, artistic, naturally harmonious',d:'Shared sensitivity and appreciation for beauty and peace.'},
      'Rabbit-Pig':{t:'Affinity',q:'Warm, loyal, mutually supportive',d:'Both value comfort, honesty, and genuine feeling.'},
      'Rabbit-Rooster':{t:'Clash',q:'Contrasting sensibilities',d:'Rabbit seeks peace; Rooster seeks precision. Complementary if each accepts the other\'s rhythm.'},
      'Dragon-Monkey':{t:'Affinity',q:'Dynamic, inventive, ambitious',d:'Shared drive; risk of competing for the stage.'},
      'Dragon-Rat':{t:'Affinity',q:'Powerful natural alliance',d:'Dragon\'s vision + Rat\'s strategy, formidable.'},
      'Dragon-Dog':{t:'Clash',q:'Philosophical opposition',d:'Dragon expansive; Dog questioning. Honest dialogue is the bridge.'},
      'Snake-Rooster':{t:'Affinity',q:'Sophisticated, refined, deeply intuitive',d:'Shared depth, patience, and aesthetic intelligence.'},
      'Snake-Ox':{t:'Affinity',q:'Grounded and enduring',d:'Snake\'s insight + Ox\'s persistence = lasting structures.'},
      'Snake-Pig':{t:'Clash',q:'Contrasting inner orientations',d:'Snake analytical; Pig open-hearted. Bridges built through honest warmth.'},
      'Horse-Tiger':{t:'Affinity',q:'Bold, freedom-loving, mutually inspiring',d:'Both independent; must consciously build shared ground.'},
      'Horse-Dog':{t:'Affinity',q:'Freedom and loyalty in balance',d:'Horse leads; Dog stands by. Natural companionship and ease.'},
      'Goat-Pig':{t:'Affinity',q:'Creative, emotionally resonant, joyful',d:'Both feeling-oriented; genuine warmth and mutual acceptance.'},
      'Goat-Rabbit':{t:'Affinity',q:'Artistic, warm, naturally understanding',d:'Deep emotional compatibility and shared aesthetic sensibility.'},
      'Goat-Ox':{t:'Clash',q:'Different life rhythms',d:'Goat intuitive and flexible; Ox methodical and fixed. Growth through mutual respect.'},
      'Monkey-Rat':{t:'Affinity',q:'Clever, stimulating, adaptable',d:'Strong mental connection; emotional depth work beneficial.'},
      'Monkey-Dragon':{t:'Affinity',q:'Inventive, ambitious, dynamic',d:'Shared drive for achievement and originality.'},
      'Rooster-Ox':{t:'Affinity',q:'Diligent, dependable, productive',d:'Both hardworking; naturally complement each other\'s focus.'},
      'Rooster-Snake':{t:'Affinity',q:'Refined, intelligent, discriminating',d:'Shared depth, high standards, and sophisticated sensibility.'},
      'Dog-Tiger':{t:'Affinity',q:'Loyal, principled, deeply aligned',d:'Shared values; both protective of those they love.'},
      'Dog-Horse':{t:'Affinity',q:'Freedom and loyalty in balance',d:'Natural ease and mutual respect.'},
      'Pig-Rabbit':{t:'Affinity',q:'Harmonious, warm, naturally close',d:'Both seek genuine connection and peace.'},
      'Pig-Goat':{t:'Affinity',q:'Creative, emotionally open, joyful',d:'Easy warmth and deep mutual acceptance.'},
    };
    function _chCompat(a,b){const k1=a+'-'+b,k2=b+'-'+a;return _CC[k1]||_CC[k2]||{t:'Neutral',q:'A unique pairing',d:'Neither natural affinity nor inherent clash, shaped primarily by the individuals themselves.'};}
    const chineseA = pA.birthYear ? _chSign(pA.birthYear, pA.birthMonth, pA.birthDay) : null;
    const chineseB = pB.birthYear ? _chSign(pB.birthYear, pB.birthMonth, pB.birthDay) : null;
    const chineseCompat = (chineseA && chineseB) ? _chCompat(chineseA.animal, chineseB.animal) : null;
    const chineseText = (chineseA && chineseB)
      ? `CHINESE ASTROLOGY (6th framework, solar year signs, CNY-corrected):\n${pA.name||'Person A'}: ${chineseA.element} ${chineseA.animal}\n${pB.name||'Person B'}: ${chineseB.element} ${chineseB.animal}\nRelationship: ${chineseCompat.t}: ${chineseCompat.q}\nDynamic: ${chineseCompat.d}`
      : 'Chinese astrology: birth year data insufficient';

    // ── ALL SIX FRAMEWORKS ──
    const natalA    = dateA ? getNatalPlanets(dateA) : null;
    const natalB    = dateB ? getNatalPlanets(dateB) : null;
    const kinA      = dateA ? getKin(dateA) : null;
    const kinB      = dateB ? getKin(dateB) : null;
    const numA      = dateA ? getNumerology(dateA, pA.birthDay, pA.birthMonth, pA.birthYear) : null;
    const numB      = dateB ? getNumerology(dateB, pB.birthDay, pB.birthMonth, pB.birthYear) : null;
    const moonPhaseA = dateA ? getNatalMoonPhase(dateA) : null;
    const moonPhaseB = dateB ? getNatalMoonPhase(dateB) : null;

    // ── CROSS-ANALYSIS (pre-computed, structured) ──
    const synAspects      = (natalA && natalB) ? getSynastryAspects(natalA, natalB) : [];
    const numCross        = getNumerologyCrossAnalysis(numA, numB, pA.name || pA.nickname || 'Person A', pB.name || pB.nickname || 'Person B');
    const dreamspellCross = (kinA && kinB) ? getDreamspellSynastry(kinA, kinB) : null;
    const moonPhaseCross  = getMoonPhaseSynastry(moonPhaseA, moonPhaseB, pA.name || pA.nickname || 'Person A', pB.name || pB.nickname || 'Person B');

    // ── BIORHYTHMS TODAY ──
    const bioA      = dateA ? getBiorhythms(dateA, today) : null;
    const bioB      = dateB ? getBiorhythms(dateB, today) : null;
    const bioSynastry = (bioA && bioB) ? getBiorhythmSynastry(bioA, bioB) : null;

    const nameA = pA.nickname || pA.name || 'Person A';
    const nameB = pB.nickname || pB.name || 'Person B';

    const formatNatal = (natal, kin, num, moonPhase, person) => {
      if (!natal) return (person.name || 'Person') + ': birth details not provided';
      return 'Name: ' + (person.name || person.nickname || 'unknown') + '\n'
        + 'Born: ' + person.birthDay + '/' + person.birthMonth + '/' + person.birthYear
        + (person.birthTime ? ' at ' + person.birthTime : '')
        + (person.birthLocation ? ' in ' + person.birthLocation : '') + '\n'
        + 'Sun: ' + natal[0].degStr + ' | Moon: ' + natal[1].degStr + ' | Venus: ' + natal[3].degStr + ' | Mars: ' + natal[4].degStr + '\n'
        + 'Mercury: ' + natal[2].degStr + ' | Jupiter: ' + natal[5].degStr + ' | Saturn: ' + natal[6].degStr + '\n'
        + 'Life Path: ' + (num ? num.lp : '?') + ' (' + (num && num.lpM ? num.lpM.n : '') + ') | Personal Year: ' + (num ? num.py : '?') + '\n'
        + 'Dreamspell Birth Kin: ' + (kin ? kin.full : '?') + (kin && kin.isGAP ? ' (GAP, portal day birth)' : '') + '\n'
        + 'Natal Moon Phase: ' + (moonPhase ? moonPhase.phase + ' - ' + moonPhase.archetype : 'unknown');
    };

    const aspectList = synAspects.map(a =>
      '●'.repeat(a.str) + '○'.repeat(5-a.str) + ' ' + a.desc
    ).join('\n');

    // Format cross-analysis as structured text for Oracle
    const numCrossText = numCross
      ? 'NUMEROLOGY CROSS-ANALYSIS:\n'
        + 'Life Path ' + numCross.lpA + ' and ' + numCross.lpB + ' - ' + numCross.quality + '\n'
        + numCross.dynamic + '\n'
        + (numCross.pyDynamic ? numCross.pyDynamic + '\n' : '')
        + 'Combined relationship frequency: ' + numCross.combined + ' (' + numCross.combinedName + '), ' + numCross.combinedMeaning
      : 'Numerology: insufficient birth data';

    const dreamspellCrossText = dreamspellCross
      ? 'DREAMSPELL SYNASTRY:\n'
        + dreamspellCross.chromaticDesc + '\n'
        + 'Tonal relationship: ' + dreamspellCross.toneRelation + '\n'
        + (dreamspellCross.sameWavespell ? 'Born in the same wavespell, rare and significant.\n' : '')
        + (dreamspellCross.bothGAP ? 'Both born on Galactic Activation Portal days, extraordinary portal-day connection.\n' : '')
        + 'Combined Kin: ' + dreamspellCross.combinedFull + ' - ' + dreamspellCross.combinedMeaning
      : 'Dreamspell: insufficient data';

    const moonPhaseCrossText = moonPhaseCross
      ? 'NATAL MOON PHASE SYNASTRY:\n'
        + nameA + ' born at ' + moonPhaseCross.phaseA + ' - ' + moonPhaseCross.archetypeA + '\n'
        + nameB + ' born at ' + moonPhaseCross.phaseB + ' - ' + moonPhaseCross.archetypeB + '\n'
        + moonPhaseCross.dynamicNote
      : 'Natal moon phase: insufficient data';

    const bioText = bioSynastry
      ? 'BIORHYTHM CROSS-ANALYSIS TODAY (' + today + '):\n'
        + bioSynastry.map(b =>
            b.cycle + ': ' + nameA + ' at ' + b.aPct + '% (' + b.aPhase + '), '
            + nameB + ' at ' + b.bPct + '% (' + b.bPhase + '), ' + b.dynamic
          ).join('\n')
      : '';

    const topicMap = {
      romance:       'Romantic compatibility, attraction, intimacy, long-term potential, physical chemistry, emotional resonance',
      communication: 'Communication, how they think, speak, argue, listen, and understand each other',
      conflict:      'Conflict and growth edges, where they clash, why, and what those tensions are trying to build',
      parenting:     'Parenting together, how they parent as a team, where they align and diverge, how to be consistent',
      business:      'Business and creative partnership, complementary strengths, blind spots, decision-making dynamics',
      friendship:    'Friendship, the nature of the bond, what sustains it, what deepens it over time',
      children:      'Understanding a child, how to connect with, motivate, nurture, and support this child',
      fun:           'Where they click best, shared pleasures, compatible rhythms, what brings out the best in each other',
    };
    const topicDesc = topicMap[topic] || topicMap.romance;

    // Pre-compute string values for safe concatenation
    const kinAStr = kinA ? kinA.full : 'not calculated';
    const kinBStr = kinB ? kinB.full : 'not calculated';
    const lpAStr  = numA ? String(numA.lp) : 'unknown';
    const lpBStr  = numB ? String(numB.lp) : 'unknown';
    const lpAnm   = (numA && numA.lpM) ? numA.lpM.n : '';
    const lpBnm   = (numB && numB.lpM) ? numB.lpM.n : '';
    // Lived personal context, treated as a primary input alongside the six
    // symbolic frameworks. Consumes the full saved profile when present and is
    // backward compatible: when only .context exists it reads as it did before.
    // Accepts both the saved-profile field names and the legacy ones.
    function richContext(pp) {
      const bits = [];
      const roles = pp.roles;
      if (roles) bits.push('Roles in life: ' + (Array.isArray(roles) ? roles.join(', ') : roles));
      const proj = pp.projects || pp.active_threads || pp.activeThreads;
      if (proj) bits.push('What they are carrying now: ' + (Array.isArray(proj) ? proj.join(', ') : proj));
      const ints = pp.currentIntentions || pp.intentions;
      if (ints) bits.push('Current intentions: ' + (Array.isArray(ints) ? ints.join(', ') : ints));
      const kp = pp.keyPeople || pp.relationships;
      if (kp) {
        const kpStr = (typeof kp === 'object' && !Array.isArray(kp))
          ? Object.keys(kp).map(function(k) { return k + ': ' + (Array.isArray(kp[k]) ? kp[k].join(', ') : kp[k]); }).join('; ')
          : (Array.isArray(kp) ? kp.join(', ') : kp);
        bits.push('People who matter to them: ' + kpStr);
      }
      if (pp.location) bits.push('Lives in: ' + pp.location);
      if (pp.context) bits.push('In their own words and the user notes: ' + pp.context);
      return bits.length ? bits.join('\n') : '';
    }
    const ctxA    = richContext(pA);
    const ctxB    = richContext(pB);
    const relationship = (req.body.relationship || pB.relationship || pA.relationship || '').toString().trim();
    const relLine = relationship ? 'STATED RELATIONSHIP: ' + nameB + ' is ' + relationship + ' to ' + nameA + '.' : '';
    const userCtx = customContext ? 'WHAT THE USER WROTE ABOUT THIS CONNECTION: ' + customContext : '';
    const aspList = aspectList || 'Insufficient birth data for precise aspects';
    const aspJSON = synAspects.slice(0, 5).map(function(a) {
      return '{"aspect":"' + a.desc.replace(/"/g, "'") + '","interpretation":"<3 sentences: what this cross-aspect means for ' + nameA + ' and ' + nameB + ' specifically>"}';
    }).join(',\n    ');

    const sys = 'You are the Oracle at Cosmic Daily Planner, the most sophisticated multi-framework relationship reading system in existence.\n\n'
      + 'YOUR VOICE: A Jungian analyst, a spiritual director, and the wisest friend they have ever had. Precise. Warm. Deeply honest.\n\n'
      + 'TOPIC: ' + topicDesc + '\n\n'
      + 'FRAMEWORK SOURCES (all six must be synthesised, not treated separately):\n'
      + '1. Western astrology synastry (natal planetary cross-aspects, Meeus 1998)\n'
      + '2. Pythagorean numerology (Life Path compatibility, Drayer 2002; Millman 1993)\n'
      + '3. Dreamspell synastry (chromatic family, tonal relationship, combined Kin, Arguelles 1987)\n'
      + '4. Natal lunar phase archetypes (birth emotional rhythm, Brady 1999)\n'
      + '5. Biorhythm cross-analysis today (physical, emotional, intellectual cycle synchrony)\n'
      + '6. Chinese astrology (solar year signs, CNY-corrected, three-harmony and six-clash system)\n'
      + 'PLUS the lived personal context provided below. It is a primary input, not background colour.\n\n'
      + 'RULES:\n'
      + '- You have been told real things about ' + nameA + ' and ' + nameB + ': their roles, what they are carrying, who matters to them, how they relate, and what the user wrote about this connection. Treat this lived context as a primary input. Let it shape the reading as much as the six symbolic frameworks. Where a framework illuminates something in their actual situation, connect the two explicitly by name. Never give a generic reading when specific context is present.\n'
      + '- Address ' + nameA + ' directly. Use both names. Never "Person A" or "Person B".\n'
      + '- Synthesise ALL SIX frameworks. When multiple frameworks agree on a dynamic, name that convergence explicitly, it is the most reliable signal.\n'
      + '- When frameworks diverge, name the paradox and explain what it means for this specific relationship.\n'
      + '- Chinese astrology: these are solar year signs (corrected for Chinese New Year date). Note the affinity/clash type where relevant.\n'
      + '- Be honest about challenges. Do not spiritually bypass difficulty.\n'
      + '- Planetary positions are approximate mean longitudes, label as such.\n'
      + '- RESPOND ONLY WITH VALID JSON. No markdown, no preamble.\n'
      + '- Sources: Greene (1976); Arroyo (1978); Tarnas (2006); Drayer (2002); Millman (1993); Arguelles (1987); Brady (1999).';

    const chineseAStr = chineseA ? chineseA.element + ' ' + chineseA.animal : 'unknown';
    const chineseBStr = chineseB ? chineseB.element + ' ' + chineseB.animal : 'unknown';
    const chineseCStr = chineseCompat ? chineseCompat.t + ' - ' + chineseCompat.q : 'see data';

    const user = 'PERSON A, ' + nameA + ':\n'
      + formatNatal(natalA, kinA, numA, moonPhaseA, pA) + '\n'
      + (chineseA ? 'Chinese sign: ' + chineseAStr + '\n' : '')
      + (ctxA ? 'LIVED CONTEXT for ' + nameA + ':\n' + ctxA + '\n' : '')
      + '\n'
      + 'PERSON B, ' + nameB + ':\n'
      + formatNatal(natalB, kinB, numB, moonPhaseB, pB) + '\n'
      + (chineseB ? 'Chinese sign: ' + chineseBStr + '\n' : '')
      + (ctxB ? 'LIVED CONTEXT for ' + nameB + ':\n' + ctxB + '\n' : '')
      + '\n'
      + (relLine ? relLine + '\n\n' : '')
      + 'ASTROLOGICAL CROSS-ASPECTS (approximate, Meeus 1998):\n' + aspList + '\n\n'
      + numCrossText + '\n\n'
      + dreamspellCrossText + '\n\n'
      + moonPhaseCrossText + '\n\n'
      + (bioText ? bioText + '\n\n' : '')
      + chineseText + '\n\n'
      + 'TOPIC: ' + topicDesc + '\n'
      + userCtx + '\n\n'
      + 'Generate the compatibility reading as valid JSON. Every section must draw on multiple frameworks:\n'
      + '{\n'
      + '  "headline": "<One sentence capturing the essential truth, specific, grounded in the data>",\n'
      + '  "synthesis": "<4-5 sentences synthesising ALL SIX frameworks. Name convergences explicitly.>",\n'
      + '  "framework_convergence": "<2-3 paragraphs. Where do the six frameworks AGREE? Name it. Then: where do they diverge and what does that mean?>",\n'
      + '  "chinese_connection": "<2 paragraphs: ' + chineseAStr + ' and ' + chineseBStr + '. The ' + chineseCStr + ' relationship. How does this Chinese layer confirm or nuance the other frameworks? What does it reveal about the underlying dynamic that the other systems approach differently? Note: solar year signs, CNY-corrected.>",\n'
      + '  "gifts": { "headline": "<The genuine strengths>", "body": "<3 rich paragraphs drawing on all six frameworks>" },\n'
      + '  "tensions": { "headline": "<Growth edges, honest>", "body": "<3 paragraphs naming where multiple frameworks signal friction>" },\n'
      + '  "topic_specific": { "headline": "<' + topicDesc + '>", "body": "<4 paragraphs. Concrete. Cross-framework. Practical.>" },\n'
      + '  "key_aspects": [\n    ' + aspJSON + '\n  ],\n'
      + '  "biorhythm_today": "<2 paragraphs: biorhythm positions TODAY, what is good, what to navigate>",\n'
      + '  "dreamspell_connection": "<2 paragraphs: ' + kinAStr + ' and ' + kinBStr + '. Chromatic, tonal, combined Kin.>",\n'
      + '  "numerology_connection": "<2 paragraphs: LP ' + lpAStr + ' (' + lpAnm + ') and ' + lpBStr + ' (' + lpBnm + ').>",\n'
      + '  "natal_moon_connection": "<2 paragraphs: how their birth moon phases interact emotionally.>",\n'
      + '  "for_them": {\n'
      + '    "for_a": "<4 sentences for ' + nameA + ' - genuine insight, not advice>",\n'
      + '    "for_b": "<4 sentences for ' + nameB + '>"\n'
      + '  },\n'
      + '  "a_question_to_sit_with": "<One question for them both, not rhetorical, but genuinely open. The question that, if they sat with it honestly together, would unlock something important. It should feel slightly uncomfortable to ask.>",\n'
      + '  "closing": "<One final sentence, the deepest truth of this connection. Warm, precise, honest.>",\n'
      + '  "sources": "Astrology: approximate natal positions Meeus (1998) Astronomical Algorithms. Synastry: Greene (1976); Arroyo (1978); Sasportas (1989); Tarnas (2006). Numerology: Drayer (2002); Millman (1993). Dreamspell: Arguelles (1987) modern system. Biorhythms: Teltscher, Fliess, Swoboda (classical three-cycle theory). Natal moon phase archetypes."\n'
      + '}';

    const raw = await callAPI('claude-sonnet-4-6', 12000, sys, user);
    let reading;
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      reading = JSON.parse(cleaned);
    } catch(e) {
      try {
        reading = JSON.parse(repairJSON(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()));
        reading._repaired = true;
      } catch(e2) {
        reading = { synthesis: raw, raw: true };
      }
    }

    res.json({
      reading,
      natalA: natalA ? natalA.slice(0, 7) : null,
      natalB: natalB ? natalB.slice(0, 7) : null,
      kinA, kinB, numA, numB,
      moonPhaseA, moonPhaseB,
      chineseA, chineseB, chineseCompat,
      bioA: bioA ? { physical: bioA.physical, emotional: bioA.emotional, intellectual: bioA.intellectual, composite: bioA.composite } : null,
      bioB: bioB ? { physical: bioB.physical, emotional: bioB.emotional, intellectual: bioB.intellectual, composite: bioB.composite } : null,
      bioSynastry,
      numCross, dreamspellCross, moonPhaseCross,
      synAspects,
      nameA, nameB, topic
    });

  } catch(e) {
    console.error('Compatibility error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH ENDPOINT, used by frontend wake check and Railway monitors ──
app.get('/api/debug/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: 'not_found' });
  res.json({
    status: job.status,
    error: job.error || null,
    elapsed: job.startedAt ? Math.round((Date.now() - job.startedAt)/1000) + 's' : null,
    phase1: job.phase1 ? 'present' : null,
    resultKeys: job.result ? Object.keys(job.result) : null,
    readingKeys: job.result?.reading ? Object.keys(job.result.reading) : null,
  });
});

// ── QUICK READ, fast Haiku reading ──
app.post('/api/quickread', async (req, res) => {
  const {date, profile} = req.body;
  const ds = date || new Date().toISOString().slice(0,10);
  const p = profile || {};
  const fn = p.nickname || (p.name ? p.name.split(' ')[0] : 'you');
  const planets = buildPlanets(ds);
  const moon = getMoon(ds);
  const kin = getKin(ds);
  const num = getNumerology(ds, p.birthDay, p.birthMonth, p.birthYear);
  const ctx = [p.context,p.building,p.chapter,
    p.active_threads?(Array.isArray(p.active_threads)?p.active_threads.join(', '):p.active_threads):null,
    p.birthDay?('Born '+p.birthDay+'/'+p.birthMonth+'/'+p.birthYear):null
  ].filter(Boolean).join('. ');
  const moonNote = moon.isBlack?'BLACK MOON, do not initiate.':moon.isShiva?'SHIVA MOON, plant with intention.':'';
  const sys = 'You are the Oracle at Cosmic Daily Planner. Respond ONLY with valid JSON. No markdown, no preamble. JSON schema: {"synthesis":"string","priorities":[{"title":"string","action":"string"},{"title":"string","action":"string"},{"title":"string","action":"string"}],"shadow":"string","focus_on":["string","string","string"],"ease_off":["string","string","string"]}. Max 700 tokens. Be specific to the person by name.';
  const user = 'Person: '+fn+'. Date: '+ds+'. Moon: '+moon.phase+(moonNote?' '+moonNote:'')+'. UD: '+num.ud+' ('+((num.udM&&num.udM.n)||'')+'), PD: '+(num.pd||num.ud)+'. Kin: '+kin.full+(kin.isGAP?' GAP PORTAL':'')+'. '+ctx+'. Saturn-Neptune Aries 2026 (Tarnas). Generate the daily reading for '+fn+'.';
  try {
    const start = Date.now();
    const raw = await callAPI('claude-haiku-4-5-20251001', 1400, sys, user);
    const ms = Date.now()-start;
    console.log('Quick read '+ms+'ms');
    const cleaned = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    let reading;
    try { reading = JSON.parse(cleaned); } catch(e) { reading = {synthesis:raw,raw:true}; }
    res.json({reading, planets, moon, kin, num, ms});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});


app.get('/api/test', async (req, res) => {
  const start = Date.now();
  try {
    const result = await callAPI('claude-haiku-4-5-20251001', 50,
      'Respond with exactly: {"ok":true}',
      'Say {"ok":true} and nothing else.');
    const ms = Date.now() - start;
    res.json({ ok: true, ms, response: result.slice(0,50) });
  } catch(e) {
    res.json({ ok: false, error: e.message, ms: Date.now()-start });
  }
});

app.get('/api/health', (req, res) => {
  const hasKey = !!(process.env.ANTHROPIC_API_KEY);
  res.json({
    status: 'ok',
    version: 'CDP v9',
    time: new Date().toISOString(),
    apiKey: hasKey ? 'present' : 'MISSING, readings will fail',
    jobs: jobs.size,
    uptime: Math.round(process.uptime()) + 's'
  });
});

// ── SELF-PING KEEPALIVE, prevents Railway hobby plan sleeping ──
// Pings own health endpoint every 10 minutes
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/health`
  : null;

if (SELF_URL) {
  setInterval(() => {
    https.get(SELF_URL, (res) => {
      res.resume(); // drain response
      console.log(`Keepalive ping → ${res.statusCode}`);
    }).on('error', (e) => {
      console.warn('Keepalive ping failed:', e.message);
    });
  }, 10 * 60 * 1000); // every 10 minutes
  console.log(`Keepalive enabled → ${SELF_URL}`);
}

// ── JOB CLEANUP, remove completed/errored jobs after 4 hours ──
setInterval(() => {
  const cutoff = Date.now() - (4 * 60 * 60 * 1000);
  let cleaned = 0;
  for (const [id, job] of jobs.entries()) {
    if (job.startedAt < cutoff) { jobs.delete(id); cleaned++; }
  }
  if (cleaned > 0) console.log(`Cleaned ${cleaned} stale jobs`);
}, 30 * 60 * 1000); // every 30 minutes

// ── SPA ROUTING ─────────────────────────────────────────────────────────────
// /app → Oracle app (app.html)
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
// /the-thinking → premise page (the-thinking.html), served explicitly so the
// catch-all below does not return index.html for this path.
app.get('/the-thinking', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'the-thinking.html'));
});
// Catch-all → landing page (index.html)
// Must come AFTER all API routes
// ── FEEDBACK endpoint ────────────────────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  const { text, user, date, tier, readingSynthesis, rating } = req.body;
  if (!text) return res.status(400).json({error: 'No feedback text'});
  console.log('\n=== CDP FEEDBACK ===');
  console.log(`From: ${user || 'anonymous'} | Tier: ${tier || 'unknown'} | ${date || new Date().toISOString()}`);
  if (rating) console.log(`Rating: ${rating}/5`);
  console.log(`Text: ${text}`);
  if (readingSynthesis) console.log(`Reading context: ${readingSynthesis}`);
  console.log('====================\n');
  res.json({ok: true});
});

// ── ANALYTICS event endpoint ──────────────────────────────────────────────
app.post('/api/analytics', async (req, res) => {
  const { event, props, session_id } = req.body;
  if (event) {
    console.log(`[Analytics] ${event} | session:${session_id || 'anon'} | ${JSON.stringify(props || {})}`);
  }
  res.json({ok: true});
});


// ── BEST DAY endpoint (legacy /api/bestday alias) ────────────────────────────
// Uses best-day.js module via the module-scope astroService. The newer
// /api/best-day endpoint (defined further down) is the canonical name; this
// route is kept for backward compatibility with older frontends.
app.post('/api/bestday', async (req, res) => {
  const { profile, intent, monthStart, monthEnd } = req.body;
  if (!intent) return res.status(400).json({ error: 'intent required' });

  try {
    const result = await bestDay.findBestDays({
      userProfile: profile || {},
      intent,
      monthStart: monthStart || new Date().toISOString().slice(0,8) + '01',
      monthEnd: monthEnd || new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).toISOString().slice(0,10),
      astroService,
      topN: 5
    });
    res.json(result);
  } catch(e) {
    console.error('bestday error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Helper: GAP kin detection
function isGAPKin(kin) {
  const gaps = new Set([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,
    24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,
    48,49,50,51,52,53,54,55,56,57,58,59,60,61,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,
    84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,
    108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,
    128,129,130,131,132,133,134,135,136,137,138,139,144,145,146,147,148,149,150,151,152,153,154,155,156,157,
    162,163,164,165,166,167,168,169,170,171,172,173,174,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,
    198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,218,219,220,221,222,223,224,225,226,227,228,229,230,231,
    236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255,256,257,258,259,260]);
  return gaps.has(kin);
}


// ── MODULE-SCOPE ASTRO SERVICE ───────────────────────────────────────────────
// Lifted out of the bestday handler so all routes (month-data, day-data, test-kin)
// can share one astronomical bridge. Wraps existing server-internal helpers
// (getKin, isGAPKin, lunar maths) into the interface best-day.js expects.
const astroService = {
  getMoonPhase: (dateIso) => {
    try {
      const known = new Date('2000-01-06T18:14:00Z');
      const syn = 29.53058867;
      const d = new Date(dateIso + 'T00:00:00Z');
      const diff = (d - known) / 86400000;
      const pos = ((diff % syn) + syn) % syn;
      const phases = [
        {max:1.85, phase:'new_moon'},      {max:7.38,  phase:'waxing_crescent'},
        {max:9.22, phase:'first_quarter'}, {max:14.77, phase:'waxing_gibbous'},
        {max:16.61, phase:'full_moon'},    {max:22.15, phase:'waning_gibbous'},
        {max:23.99, phase:'last_quarter'}, {max:29.53, phase:'waning_crescent'}
      ];
      const p = phases.find(ph => pos < ph.max) || phases[0];
      const toNew = ((syn - pos) + syn) % syn;
      return {
        phase: p.phase,
        illumination: Math.round(Math.abs(Math.sin((pos / syn) * Math.PI)) * 100),
        isBlackMoon: toNew <= 2 && toNew > 0.05,
        isShivaMoon: pos >= 1 && pos <= 2
      };
    } catch(e) {
      return { phase: 'unknown', illumination: 50, isBlackMoon: false, isShivaMoon: false };
    }
  },
  getKin: (dateIso) => {
    try {
      // P0-01 fix: delegate to the canonical getKin (Foundation for the Law of
      // Time anchor, 8 Jul 2024 = Kin 1, leap days excluded) so the calendar,
      // day-data and best-day surfaces use the SAME count as the reading. The
      // previous body used a separate 1987-07-26 base and a divergent GAP set,
      // which left these surfaces a constant 227 off from the reading.
      const k = getKin(dateIso);
      const seals = ['dragon','wind','night','seed','serpent','worldbridger','hand','star','moon','dog','monkey','human','skywalker','wizard','eagle','warrior','earth','mirror','storm','sun'];
      return { kin: k.kin, seal: seals[(k.kin - 1) % 20], tone: k.toneNum, isGAP: k.isGAP };
    } catch(e) {
      return { kin: 1, seal: 'dragon', tone: 1, isGAP: false };
    }
  },
  getTransits: (dateIso, natal) => {
    // Placeholder; populated by Swiss Ephemeris elsewhere in the reading pipeline
    return [];
  }
};

// ── MONTH DATA endpoint ──────────────────────────────────────────────────────
// Returns per-day kin, tone, seal, GAP flag, moon phase, and special-moon flags
// for every date in the requested range. Used by the calendar grid.
app.get('/api/month-data', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const days = {};
    const startDate = new Date(start + 'T00:00:00Z');
    const endDate   = new Date(end   + 'T00:00:00Z');
    if (isNaN(startDate) || isNaN(endDate)) {
      return res.status(400).json({ error: 'invalid date format, expected YYYY-MM-DD' });
    }

    for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateIso = d.toISOString().slice(0, 10);
      try {
        const moonData = astroService.getMoonPhase(dateIso);
        const kinData  = astroService.getKin(dateIso);
        days[dateIso] = {
          kin:            kinData.kin,
          tone:           kinData.tone,
          seal:           kinData.seal,
          isGAP:          kinData.isGAP,
          moonPhase:      moonData.phase,
          moonPhaseLabel: humanMoonPhase(moonData),
          isBlackMoon:    moonData.isBlackMoon,
          isShivaMoon:    moonData.isShivaMoon,
          illumination:   moonData.illumination
        };
      } catch (err) {
        days[dateIso] = { error: err.message };
      }
    }
    res.json({ start, end, days });
  } catch (err) {
    console.error('month-data error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── DAY DATA endpoint ────────────────────────────────────────────────────────
// Single-day equivalent of month-data. Used by the day-detail panel.
app.get('/api/day-data', async (req, res) => {
  try {
    const { date, natal } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });
    let natalObj = {};
    if (natal) {
      try { natalObj = JSON.parse(Buffer.from(natal, 'base64').toString('utf-8')); }
      catch (e) { /* best effort */ }
    }
    const moonData = astroService.getMoonPhase(date);
    const kinData  = astroService.getKin(date);
    const transits = astroService.getTransits(date, natalObj);
    res.json({
      date,
      kin:            kinData.kin,
      tone:           kinData.tone,
      seal:           kinData.seal,
      isGAP:          kinData.isGAP,
      moonPhase:      moonData.phase,
      moonPhaseLabel: humanMoonPhase(moonData),
      isBlackMoon:    moonData.isBlackMoon,
      isShivaMoon:    moonData.isShivaMoon,
      illumination:   moonData.illumination,
      transits:       transits || []
    });
  } catch (err) {
    console.error('day-data error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── TEST KIN endpoint ────────────────────────────────────────────────────────
// Diagnostic: confirms the Dreamspell anchor is correct.
// Calling /api/test-kin?date=2024-07-08 must return Kin 1.
app.get('/api/test-kin', async (req, res) => {
  try {
    const date = req.query.date || '2024-07-08';
    const k = astroService.getKin(date);
    const expected = (date === '2024-07-08') ? 1 : null;
    res.json({
      date,
      kin:    k.kin,
      tone:   k.tone,
      seal:   k.seal,
      isGAP:  k.isGAP,
      anchorCheck: expected !== null
        ? (k.kin === expected ? 'PASS' : 'FAIL: expected ' + expected)
        : 'no expected value'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BEST DAY (hyphenated) alias ──────────────────────────────────────────────
// The frontend (app.html v6) calls /api/best-day. Keep /api/bestday working too
// by aliasing both to the same handler. No behaviour change for existing callers.
app.post('/api/best-day', async (req, res) => {
  // Accept both new and old request shapes for resilience
  const body = req.body || {};
  const profile     = body.userProfile || body.profile || {};
  const intent      = body.intent;
  const monthStart  = body.monthStart;
  const monthEnd    = body.monthEnd;
  const topN        = body.topN || 5;
  if (!intent) return res.status(400).json({ error: 'intent required' });
  try {
    const result = await bestDay.findBestDays({
      userProfile: profile,
      intent,
      monthStart: monthStart || new Date().toISOString().slice(0,8) + '01',
      monthEnd:   monthEnd   || new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).toISOString().slice(0,10),
      astroService,
      topN
    });
    res.json(result);
  } catch(e) {
    console.error('best-day error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── humanMoonPhase helper ────────────────────────────────────────────────────
// Used by month-data and day-data to convert internal phase keys into
// reader-friendly labels. Special-moon flags take precedence.
function humanMoonPhase(moonData) {
  if (!moonData) return 'Unknown';
  if (moonData.isBlackMoon) return 'Black Moon (two days before New Moon)';
  if (moonData.isShivaMoon) return 'Shiva Moon (two days after New Moon)';
  const map = {
    new:              'New Moon',
    new_moon:         'New Moon',
    waxing_crescent:  'Waxing Crescent',
    first_quarter:    'First Quarter',
    waxing_gibbous:   'Waxing Gibbous',
    full:             'Full Moon',
    full_moon:        'Full Moon',
    waning_gibbous:   'Waning Gibbous',
    last_quarter:     'Last Quarter',
    waning_crescent:  'Waning Crescent'
  };
  return map[moonData.phase] || moonData.phase || 'Unknown';
}

// ══════════════════════════════════════════════════════════════════
// ── v18 ENDPOINTS (added 5 May 2026) ──────────────────────────────
// ══════════════════════════════════════════════════════════════════
// In FALLBACK MODE: invitations stored in-memory only. Lost on instance
// restart. This is acceptable for dev/beta testing while Supabase
// service-role credentials are not yet configured. To upgrade to
// persistent storage, add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// to Railway env vars and swap this block for the persistent version.
// ══════════════════════════════════════════════════════════════════

const v18_invitations = new Map(); // token -> invitation record
const v18_crypto = require('crypto');

function v18_generateToken() {
  return 'inv_' + v18_crypto.randomBytes(18).toString('base64url');
}

// POST /api/invitations
app.post('/api/invitations', (req, res) => {
  try {
    const {
      invitee_first_name,
      inviter_user_id,
      inviter_first_name,
      relationship_context,
      inviter_profile,
    } = req.body || {};

    if (!invitee_first_name || typeof invitee_first_name !== 'string') {
      return res.status(400).json({ error: 'invitee_first_name required' });
    }
    if (invitee_first_name.length > 80) {
      return res.status(400).json({ error: 'invitee_first_name too long' });
    }

    const token = v18_generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const record = {
      token,
      inviter_user_id: inviter_user_id || null,
      inviter_first_name: (inviter_first_name || 'A friend').slice(0, 80),
      inviter_profile: inviter_profile || null,
      invitee_first_name: invitee_first_name.slice(0, 80),
      relationship_context: relationship_context ? String(relationship_context).slice(0, 200) : null,
      status: 'pending',
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    };
    v18_invitations.set(token, record);

    const origin = req.get('origin') || req.get('referer') || '';
    const baseUrl = origin
      ? origin.replace(/\/$/, '')
      : `https://${req.get('host')}`;
    const shareUrl = `${baseUrl}/?invite=${encodeURIComponent(token)}`;

    console.log(`[v18 invitation_generated] token=${token.slice(0,12)}... invitee=${record.invitee_first_name}`);
    return res.json({ token, share_url: shareUrl, expires_at: expiresAt });
  } catch (e) {
    console.error('[POST /api/invitations exception]', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/invitations/:token
app.get('/api/invitations/:token', (req, res) => {
  try {
    const { token } = req.params;
    if (!token || token.length > 64) return res.status(400).json({ error: 'Invalid token' });

    const record = v18_invitations.get(token);
    if (!record) return res.status(404).json({ error: 'Not found' });

    if (record.status === 'expired' || new Date(record.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Invitation expired' });
    }

    console.log(`[v18 invitation_visited] token=${token.slice(0,12)}...`);
    return res.json({
      token: record.token,
      inviter_first_name: record.inviter_first_name,
      relationship_context: record.relationship_context,
      inviter_profile: record.inviter_profile,
      invitee_first_name: record.invitee_first_name,
      expires_at: record.expires_at,
      status: record.status,
    });
  } catch (e) {
    console.error('[GET /api/invitations/:token exception]', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/invitations/:token/redeem
app.post('/api/invitations/:token/redeem', (req, res) => {
  try {
    const { token } = req.params;
    const { invitee_profile } = req.body || {};

    if (!invitee_profile || typeof invitee_profile !== 'object') {
      return res.status(400).json({ error: 'invitee_profile required' });
    }
    if (!invitee_profile.firstName || !invitee_profile.dob || !invitee_profile.birthPlace) {
      return res.status(400).json({ error: 'firstName, dob, birthPlace required' });
    }

    const record = v18_invitations.get(token);
    if (!record) return res.status(404).json({ error: 'Not found' });
    if (record.status === 'expired' || new Date(record.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Invitation expired' });
    }
    if (record.status === 'redeemed') return res.status(409).json({ error: 'Already redeemed' });

    record.invitee_partial_profile = invitee_profile;
    record.status = 'redeemed';
    record.redeemed_at = new Date().toISOString();
    v18_invitations.set(token, record);

    console.log(`[v18 invitation_birth_data_complete] token=${token.slice(0,12)}... time_known=${!!invitee_profile.birthTime}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/invitations/redeem exception]', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/crisis-event, server-side log only; never blocks the user
app.post('/api/crisis-event', (req, res) => {
  try {
    const { user_id, category, tier, surface, mode, text_length } = req.body || {};
    if (!category || !tier || !mode) return res.status(400).json({ error: 'category, tier, mode required' });
    console.warn(`[v18 crisis_detected] cat=${category} tier=${tier} surface=${surface} mode=${mode} len=${text_length||0} user=${user_id||'anon'}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/crisis-event exception]', e);
    return res.status(200).json({ ok: false });
  }
});

console.log('[v18] Endpoints attached: /api/invitations, /api/invitations/:token, /api/invitations/:token/redeem, /api/crisis-event (FALLBACK MODE: in-memory storage)');

// ══════════════════════════════════════════════════════════════════
// ── /v18 ENDPOINTS ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// ── v19 ENDPOINTS (added 5 May 2026) ──────────────────────────────
// Retention layer: morning compass, streak counter, continuity of
// memory foundation, in-app email capture.
//
// In FALLBACK MODE (current): all v19 storage uses in-memory Maps,
// same pattern as v18 invitations. Acceptable for dev/beta and for
// founder-and-collaborator stress testing. Move to Supabase by
// running migration_v19.sql and swapping this block for the
// persistent version.
//
// Endpoints added:
//   GET  /api/compass/today            Today's compass context for a user
//   POST /api/compass/intention        Save user's intention for today
//   GET  /api/streak                   Read user's current streak state
//   POST /api/streak/visit             Record a daily visit (idempotent per day)
//   POST /api/memory/summary           Store post-reading summary (continuity layer)
//   GET  /api/memory/recent            Retrieve recent summaries for a user
//   POST /api/email/capture            Capture opted-in email + timezone
//   GET  /api/v19/health               Health check for v19 surfaces
// ══════════════════════════════════════════════════════════════════

const v19_streaks = new Map();      // userId -> { current, longest, lastVisit, history[] }
const v19_intentions = new Map();   // userId -> { date -> intentionText }
const v19_summaries = new Map();    // userId -> array of summary records
const v19_emails = new Map();       // userId -> { email, timezone, capturedAt }
const v19_compassCache = new Map(); // userId+date -> compass context

// Day 13: cost-audit metrics. Bounded ring buffer of recent context
// builds so we can compute p50/p95 token counts and watch for cost
// runaway. Replace with proper observability when Supabase migration
// lands.
const V19_METRICS_BUFFER_SIZE = 1000;
const v19_metrics = {
  contextBuilds: [],     // { ts, tokens, summaries_count, budget }
  summaryStores: [],     // { ts, themes_count, insight_chars }
  readingPrompts: [],    // { ts, base_tokens, context_tokens, total_tokens }
  recordContextBuild(tokens, summariesCount, budget) {
    this.contextBuilds.push({ ts: Date.now(), tokens, summaries_count: summariesCount, budget });
    if (this.contextBuilds.length > V19_METRICS_BUFFER_SIZE) {
      this.contextBuilds.splice(0, this.contextBuilds.length - V19_METRICS_BUFFER_SIZE);
    }
  },
  recordSummaryStore(themesCount, insightChars) {
    this.summaryStores.push({ ts: Date.now(), themes_count: themesCount, insight_chars: insightChars });
    if (this.summaryStores.length > V19_METRICS_BUFFER_SIZE) {
      this.summaryStores.splice(0, this.summaryStores.length - V19_METRICS_BUFFER_SIZE);
    }
  },
  recordReadingPrompt(baseTokens, contextTokens) {
    this.readingPrompts.push({
      ts: Date.now(), base_tokens: baseTokens,
      context_tokens: contextTokens, total_tokens: baseTokens + contextTokens,
    });
    if (this.readingPrompts.length > V19_METRICS_BUFFER_SIZE) {
      this.readingPrompts.splice(0, this.readingPrompts.length - V19_METRICS_BUFFER_SIZE);
    }
  },
  percentile(arr, key, p) {
    if (arr.length === 0) return 0;
    const sorted = arr.map(x => x[key]).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  },
  snapshot() {
    const cb = this.contextBuilds;
    const rp = this.readingPrompts;
    return {
      context_builds: {
        count: cb.length,
        median_tokens: this.percentile(cb, 'tokens', 50),
        p95_tokens: this.percentile(cb, 'tokens', 95),
        avg_summaries_per_build: cb.length === 0 ? 0
          : Math.round(cb.reduce((s, x) => s + x.summaries_count, 0) / cb.length * 100) / 100,
      },
      summary_stores: { count: this.summaryStores.length },
      reading_prompts: {
        count: rp.length,
        median_total: this.percentile(rp, 'total_tokens', 50),
        p95_total: this.percentile(rp, 'total_tokens', 95),
        median_context_share_pct: rp.length === 0 ? 0
          : Math.round(rp.reduce((s, x) => s + (x.context_tokens / Math.max(1, x.total_tokens)) * 100, 0) / rp.length),
      },
    };
  },
};

// ── Helpers ────────────────────────────────────────────────────────

function v19_userKey(req) {
  // userId from body/query, or fall back to a stable cookie-equivalent
  // header. Anonymous users get a session-stable hash, signed-in users
  // get their actual userId. The dual-track storage decision lives at
  // the client; the server treats both equivalently.
  return (req.body && req.body.user_id)
      || (req.query && req.query.user_id)
      || (req.headers['x-cdp-anon-id'])
      || null;
}

function v19_dayString(date, timezone) {
  // Returns YYYY-MM-DD in the given IANA timezone, with UTC fallback.
  // The streak engine uses this so a user travelling across timezones
  // does not accidentally double-count or lose a day.
  //
  // Day 4 spec: a user in NYC reading at 11pm EST then in London at
  // 9am GMT next day should register as a 2-day streak. This is
  // achieved by always rendering the day string in the user's saved
  // timezone (or browser-detected fallback) so the boundary logic is
  // consistent across visits.
  const d = date instanceof Date ? date : new Date(date);
  if (!timezone) {
    // UTC fallback
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  try {
    // Intl.DateTimeFormat with an IANA timezone produces date parts
    // in that zone. Native, no library needed.
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    // en-CA gives YYYY-MM-DD natively
    return fmt.format(d);
  } catch (e) {
    // Bad timezone string; fall back to UTC
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

function v19_userTimezone(req, fallback) {
  // Resolve a user's timezone from request body, query, header, or
  // captured-email record. Falls back to UTC if nothing available.
  const fromBody = req.body && req.body.timezone;
  const fromQuery = req.query && req.query.timezone;
  const fromHeader = req.headers['x-cdp-timezone'];
  const userId = v19_userKey(req);
  const fromCapture = userId && v19_emails.get(userId) && v19_emails.get(userId).timezone;
  return fromBody || fromQuery || fromHeader || fromCapture || fallback || null;
}

function v19_daysBetween(dayA, dayB) {
  // dayA and dayB are YYYY-MM-DD strings. Returns absolute difference
  // in calendar days. Used by the gentle-resume logic.
  const a = new Date(dayA + 'T00:00:00Z');
  const b = new Date(dayB + 'T00:00:00Z');
  return Math.round(Math.abs((b - a) / 86400000));
}

function v19_compassContextForHour(hour) {
  // Light personalisation by time of day. Per Vol 16 spec section 1.2.
  if (hour < 11)  return { greeting: 'Good morning',  cta: 'Begin today',          voiceFocus: 'opening' };
  if (hour < 14)  return { greeting: 'Hello',         cta: 'Reset for the afternoon', voiceFocus: 'midday' };
  if (hour < 18)  return { greeting: 'Afternoon',     cta: 'Reorient',             voiceFocus: 'midday' };
  if (hour < 21)  return { greeting: 'Evening',       cta: 'Reflect on today',     voiceFocus: 'closing' };
  return            { greeting: 'Late evening', cta: 'A reading before sleep', voiceFocus: 'closing' };
}

// ── /api/compass/today ─────────────────────────────────────────────
// Returns the compass context for today, including time-of-day
// adaptation. The compass content (kin, moon, numerology, voice quote)
// is generated by the existing reading pipeline elsewhere in this
// server; the compass endpoint composes a lightweight response that
// the client renders as the sub-30-second surface.
app.get('/api/compass/today', (req, res) => {
  try {
    const userId = v19_userKey(req);
    const tz = v19_userTimezone(req);
    const hour = parseInt(req.query.hour, 10);
    const safeHour = (Number.isFinite(hour) && hour >= 0 && hour < 24) ? hour : new Date().getUTCHours();
    const today = v19_dayString(new Date(), tz);

    // Yesterday's intention, if any, so the compass can pre-fill.
    let yesterdayIntention = null;
    if (userId) {
      const userIntentions = v19_intentions.get(userId);
      if (userIntentions) {
        const yesterday = v19_dayString(new Date(Date.now() - 86400000), tz);
        yesterdayIntention = userIntentions[yesterday] || null;
      }
    }

    const context = v19_compassContextForHour(safeHour);

    res.json({
      ok: true,
      date: today,
      hour: safeHour,
      greeting: context.greeting,
      cta: context.cta,
      voice_focus: context.voiceFocus,
      yesterday_intention: yesterdayIntention,
    });

    if (userId) console.log(`[v19 compass_viewed] user=${userId.slice(0,8)} hour=${safeHour}`);
  } catch (e) {
    console.error('[GET /api/compass/today exception]', e);
    res.status(500).json({ error: 'compass context failed' });
  }
});

// ── /api/compass/intention ─────────────────────────────────────────
// Save the user's intention for today. Optional input. If saved, it
// pre-fills tomorrow's compass field as 'yesterday_intention' which
// is a small but psychologically real continuity-of-memory signal.
app.post('/api/compass/intention', (req, res) => {
  try {
    const userId = v19_userKey(req);
    const tz = v19_userTimezone(req);
    const { intention } = req.body || {};

    if (!userId) return res.status(400).json({ error: 'user_id required' });
    if (typeof intention !== 'string') return res.status(400).json({ error: 'intention must be a string' });
    if (intention.length > 240) return res.status(400).json({ error: 'intention too long (max 240 chars)' });

    const today = v19_dayString(new Date(), tz);
    if (!v19_intentions.has(userId)) v19_intentions.set(userId, {});
    v19_intentions.get(userId)[today] = intention.trim();

    console.log(`[v19 intention_saved] user=${userId.slice(0,8)} chars=${intention.length}`);
    res.json({ ok: true, date: today });
  } catch (e) {
    console.error('[POST /api/compass/intention exception]', e);
    res.status(500).json({ error: 'intention save failed' });
  }
});

// =====================================================================
// CDP COMPASS REPLY ENDPOINT v2 (revised honest prompt)
// =====================================================================
// Drop into server.js after /api/compass/intention, before /api/streak.
//
// What changed from v1:
//   - The prompt no longer assumes the four traditions and neuroscience
//     converge on every intention. It lets the model lead with whichever
//     lens genuinely speaks to what the user wrote.
//   - Voice is now register-of-language, not source-of-authority. Tradition
//     voice can draw on archetypes, philosophy, named wisdom traditions.
//     Science voice can draw on neuroscience, CBT, mindfulness research,
//     attachment theory, behavioural psychology, schema therapy. Everyday
//     voice draws from the same wells but speaks plainly.
//   - The prompt explicitly permits "today's framework does not speak
//     directly to this; here is what does" rather than forcing convergence.
//   - The prompt frames inputs as metaphors, in keeping with the user's
//     stated philosophy: "any input is almost as a metaphor whether true
//     science or something way out spiritually... the help is in having
//     a framework that can take their input and provide meaningful
//     reflection to move forward."
//
// Cost / latency identical to v1: ~2-5 seconds, ~$0.01-0.03 per call.
// =====================================================================

let referencesClause;
try { ({ referencesClause } = require('./lib/reply-references')); }
catch (_e) { referencesClause = function () { return ''; }; }

app.post('/api/compass/reply', async (req, res) => {
  try {
    const { intention, voice, name, context } = req.body || {};

    // Input validation
    if (!intention || typeof intention !== 'string') {
      return res.status(400).json({ ok: false, error: 'intention required' });
    }
    const cleanIntention = intention.trim().slice(0, 500);
    if (cleanIntention.length < 2) {
      return res.status(400).json({ ok: false, error: 'intention too short' });
    }

    const validVoices = ['tradition', 'science', 'everyday'];
    const safeVoice = validVoices.includes(voice) ? voice : 'tradition';

    const safeName = (name && typeof name === 'string')
      ? name.trim().slice(0, 60)
      : '';

    const ctx = (context && typeof context === 'object') ? context : {};
    const ctxKin = String(ctx.kin || '').slice(0, 120);
    const ctxMoon = String(ctx.moon || '').slice(0, 80);
    const ctxPersonalDay = ctx.personal_day ? String(ctx.personal_day).slice(0, 6) : '';
    const ctxPersonalYear = ctx.personal_year ? String(ctx.personal_year).slice(0, 6) : '';
    const ctxUniversalYear = ctx.universal_year ? String(ctx.universal_year).slice(0, 6) : '';
    const ctxDateStr = String(ctx.date_str || '').slice(0, 60);
    const ctxIsGAP = !!ctx.is_gap;
    const ctxIsBlackMoon = !!ctx.is_black_moon;
    const ctxIsShivaMoon = !!ctx.is_shiva_moon;

    // ─── BASE PROMPT ─────────────────────────────────────────────
    // The prompt is the product. Iterate carefully.
    const baseSystem = `You are the Compass voice of Cosmic Daily Planner. A user has typed a brief intention, question, challenge, or need at the start (or middle) of their day. Your reply is the daily micro-engagement: quick, useful, specific to what they wrote, in their chosen voice register.

CDP'S CORE PHILOSOPHY (read before responding):
A reading from any framework, ancient or modern, is most useful as a frame for reflection. The user is intelligent. They are not asking you to prove that today's Mayan Kin governs board meetings, or that neuroscience explains everything. They are asking for a useful lens through which to look at what they wrote. Sometimes a framework speaks directly. Sometimes the framework offers no specific guidance and what genuinely speaks is plain psychology, CBT, mindfulness, attachment theory, schema work, or simple observed wisdom. Your job is to bring the most useful lens, in the chosen voice, without overclaiming.

REPLY RULES (non-negotiable):
- 40 to 80 words. Not a sentence. Not a paragraph. A breath.
- Open by naming what the user wrote in a way that shows you understood, not in a way that mechanically paraphrases it.
- Address the user by first name if provided.
- Hold the voice register strictly (see voice rules below).
- Vary how you end, and never close two replies the same way. Most replies should end on a specific observation or a concrete thing to consider, not a question. Use a closing question only when a genuine, content-specific one truly arises, never a generic meta-question, and never a stock close such as asking what the one thing is that they do not yet have a clean answer for. Ending on a strong final sentence with nothing appended is good. Never prescribe.
- No exclamation marks. No em dashes. No en dashes. Use commas, periods, parentheses, or colons instead. House style is firm on this.
- Banned vocabulary: "manifesting", "vibrational", "highest timeline", "energy of the day" as a stock phrase, "evidence-based", "research shows", "trust the process", "the universe", "divine timing".
- Do not flatter. Do not catastrophise. Do not over-promise.
- If the intention contains genuine distress (mention of suicide, self-harm, abuse), respond with care, do not give framework-speak, and gently suggest reaching out to a trusted person or professional. Do not list helplines unless asked.

WHAT TO DRAW FROM (this matters more than the voice rules below):
You may draw on any of the following, choosing whichever genuinely speaks to what the user wrote, regardless of voice register:
- The four CDP frameworks: Pythagorean numerology, Western astrology (Greene, Tarnas, Hand, Brennan), Mayan/Dreamspell calendrics (Argüelles 1987), lunar cycles
- Contemporary psychology: CBT (Beck), schema therapy (Young), ACT (Hayes), attachment theory (Bowlby, Ainsworth), Internal Family Systems
- Neuroscience: salience network, default mode network, predictive processing (Clark 2016), interoception (Craig 2002), constructed emotion (Barrett 2017), circadian cognition (Mehrhof and Nord 2025), polyvagal (Porges 2011)
- Contemplative traditions: mindfulness research (Mind and Life Institute), Buddhist psychology, Stoic philosophy, contemplative practice
- Simple observed wisdom: what skilled friends and good coaches actually say

The voice register governs HOW you say it. The lens you draw from is governed by WHAT the user wrote. If today's Kin speaks to their intention, name it. If it does not and what speaks is a CBT frame about pre-event rumination, use that. The user is not paying for forced convergence. They are paying for a useful lens.

PERMISSION TO DECLINE FORCED CONVERGENCE:
If today's specific framework details (Kin, Moon phase, Personal Day) do not actually speak to the intention, do not pretend they do. Acknowledge it gracefully and offer what does. For example: "Today's Kin is more about [theme] than the specific question you are asking. What might be more useful here is [the actual frame that fits]." This is the move that earns trust from thoughtful users.

TODAY'S CONTEXT (use as scaffold where it genuinely helps, not as content to recite):
${ctxDateStr ? `Date: ${ctxDateStr}` : ''}
${ctxKin ? `Mayan/Dreamspell Kin: ${ctxKin}${ctxIsGAP ? ' (Galactic Activation Portal day)' : ''}` : ''}
${ctxMoon ? `Moon: ${ctxMoon}${ctxIsBlackMoon ? ' (Black Moon, two days before new moon, traditionally a tricky window)' : ''}${ctxIsShivaMoon ? ' (Shiva Moon, two days after new moon, traditionally blissful)' : ''}` : ''}
${ctxPersonalDay ? `Personal Day: ${ctxPersonalDay} (computed from user birth date and today)` : ''}
${ctxPersonalYear ? `Personal Year: ${ctxPersonalYear}` : ''}
${ctxUniversalYear ? `Universal Year: ${ctxUniversalYear}` : ''}

The user can see their Kin and Personal Day on the Compass screen. They do not need you to recite these. They need you to think with them, briefly, in light of what today is and what they wrote.`;

    // ─── VOICE REGISTER INSTRUCTIONS ─────────────────────────────
    // Voice = register of LANGUAGE, not source of WISDOM.
    // Each voice can draw on any of the listed sources above; what
    // changes is how the reply sounds.
    let voiceRules = '';
    if (safeVoice === 'tradition') {
      voiceRules = `

VOICE: TRADITION (register, not source)
You speak in the language of contemplative and symbolic traditions. You can name an archetype, a tone, a planetary influence, a number's symbolic weight, a mythic figure, a contemplative principle. You are not a guru and not a fortune-teller. You are a peer with a deep library who happens to speak in the symbolic register.

You may cite a tradition (Pythagorean, Mayan/Dreamspell, Hellenistic, Jungian, Stoic, Buddhist) by name where it sharpens the reply. You may also draw on psychology and neuroscience if those genuinely fit, but translate them into the symbolic register: "the inner observer" rather than "metacognition", "the threshold" rather than "transition state", "what wants to be seen" rather than "salience".

Avoid generic spiritual vocabulary. Reach for specific, named ideas with substance behind them.`;
    } else if (safeVoice === 'science') {
      voiceRules = `

VOICE: SCIENCE (register, not source)
You speak in the language of contemporary psychology and neuroscience: cognition, attention, salience, predictive processing, attachment, interoception, circadian biology, behavioural psychology, CBT, schema work, mindfulness research. You are a translator: you make the mechanism visible without burying the user in jargon.

You may briefly name a mechanism or a researcher where it actually illuminates the user's situation (Barrett, Clark, Porges, Bremer, Mehrhof and Nord, Walker, Beck, Young, Bowlby). You may also draw on the symbolic frameworks if they genuinely fit the situation, but translate them into mechanism: "the symbolic frame here functions as an attention anchor" rather than "the archetype guides you".

Do not say "research shows" or "evidence-based". Let the mechanism speak. Where the science genuinely does not have something to say about the user's situation, draw on practical psychology or applied wisdom; do not invent a mechanism.`;
    } else { // everyday
      voiceRules = `

VOICE: EVERYDAY (register, not source)
You speak plainly, the way a wise friend would. No tradition jargon. No neuroscience jargon. Direct, warm, unfussy. You can reference today simply ("today is a day for finishing things", "the moon is building up", "this week has been a lot"), but you do not name frameworks or cite researchers.

You are the bridge for users who find both other voices alienating. You sound like a person, not a system. Where another voice would say "the salience network calibrates", you say "what you pay attention to shapes what you notice". Where another voice would say "the threshold guardian", you say "the part of you that resists change is doing its job".

Plain language, real wisdom, no decoration.`;
    }

    const systemPrompt = baseSystem + voiceRules;

    // If the person brought files in, tell the voice to look at them and refer
    // to what they actually show, still within the breath-length reply.
    const attBlocks = buildAttachmentBlocks(req.body && req.body.attachments);
    const attachClause = attBlocks.length
      ? attachmentReflectionNote(attBlocks.length)
      : '';
    const broughtHist = Array.isArray(req.body && req.body.brought_in_history)
      ? req.body.brought_in_history
          .filter((x) => typeof x === 'string' && x.trim().length > 0)
          .slice(0, 4)
          .map((x) => x.trim().slice(0, 120))
      : [];
    const continuityClause = broughtHist.length
      ? '\n\nEarlier, this person brought in: ' + broughtHist.join('; ') + '. If it is natural and they have not raised it, you may gently ask after one of these. You know the names only and never the contents, so ask, do not assume.'
      : '';
    const refsClause = referencesClause(safeVoice, cleanIntention, req.body && req.body.context);
    const depthClause = '\n\nDepth. This is not a one line reply. Match your depth to what the person brought. A short intention deserves a focused reflection of two or three real paragraphs that say something specific and useful and close on whatever genuinely serves the person, most often a specific next move or a precise observation, and only occasionally a real and content-specific question. Do not end every reply with a question, and never repeat the same closing. If they brought a document, read it and engage its actual content, connect it to their day and to what they are weighing, and tell them something they would not get from a glance. Draw on the reference library above only where it genuinely helps. Never pad, never summarise for its own sake, and hold the house style throughout.';
    const fullSystem = systemPrompt + attachClause + continuityClause + refsClause + depthClause;

    const userMessage = safeName
      ? `${safeName} wrote: "${cleanIntention}"`
      : `The user wrote: "${cleanIntention}"`;
    const userContent = userContentWith(userMessage, req.body && req.body.attachments);
    const replyMaxTok = attBlocks.length ? 2000 : (cleanIntention.length > 160 ? 1100 : 700);

    // ─── ANTHROPIC CALL ──────────────────────────────────────────
    let replyText = '';
    try {
      replyText = await callAPI(
        'claude-sonnet-4-6',
        replyMaxTok,
        fullSystem,
        userContent
      );
    } catch (apiErr) {
      console.error('[POST /api/compass/reply anthropic error]', apiErr.message);
      if (apiErr.message && apiErr.message.includes('overloaded')) {
        return res.json({
          ok: true,
          reply: 'The Oracle is briefly overloaded. Hold the question for a moment and try again. What you have written is saved.',
          voice: safeVoice,
          fallback: true
        });
      }
      throw apiErr;
    }

    if (!replyText || !replyText.trim()) {
      return res.status(502).json({ ok: false, error: 'empty_reply' });
    }

    // House style scrubber: catch any em/en dashes or exclamation marks
    // the model slipped into the response. Belt-and-braces, since the
    // prompt forbids them but models occasionally violate.
    let finalReply = replyText.trim().replace(/\n{3,}/g, '\n\n');
    finalReply = finalReply
      .replace(/\s*\u2014\s*/g, ', ')
      .replace(/(\d)\s*\u2013\s*(\d)/g, '$1-$2')
      .replace(/\s*\u2013\s*/g, ', ')
      .replace(/!+/g, '.')
      .replace(/,\s*,/g, ',')
      .replace(/\.{2,}/g, '.')
      .replace(/,\s*\./g, '.')
      .replace(/\s+,/g, ',')
      .replace(/\s+\./g, '.');

    const userId = (typeof v19_userKey === 'function') ? v19_userKey(req) : 'anon';
    const idShort = userId ? userId.slice(0, 8) : 'anon';
    console.log(`[v19 compass_reply] user=${idShort} voice=${safeVoice} intention_len=${cleanIntention.length} reply_len=${finalReply.length}`);

    res.json({ ok: true, reply: finalReply, voice: safeVoice });
  } catch (e) {
    console.error('[POST /api/compass/reply exception]', e);
    res.status(500).json({ ok: false, error: 'reply_failed' });
  }
});


// ── /api/greeting ───────────────────────────────────────────────────
// The home centre opener. Two states, decided by the client, which owns the
// on device record. The client sends the brightest live thread it already
// holds (text, a living summary, any brought in names) as "last"; the server
// stays nameless and never stores it. When "last" is absent the home is in its
// cold orientation state and the server returns a plain account of what CDP is
// and what it is for. The line is composed for the person and the day, never a
// hardcoded string, so it reads correctly for anyone.
//
// Request body:
//   { name, voice, context: { date_str, personal_day, personal_year,
//     universal_year, kin, moon, is_gap, is_black_moon, is_shiva_moon,
//     is_master_day, deadline }, last: { text, summary, broughtIn[] } | null }
// Response: { ok, greeting, voice, cold }
app.post('/api/greeting', async (req, res) => {
  try {
    const { name, voice } = req.body || {};
    const validVoices = ['tradition', 'science', 'everyday'];
    const safeVoice = validVoices.includes(voice) ? voice : 'everyday';
    const safeName = (name && typeof name === 'string') ? name.trim().slice(0, 60) : '';

    const ctx = (req.body && typeof req.body.context === 'object' && req.body.context) ? req.body.context : {};
    const ctxDateStr = String(ctx.date_str || '').slice(0, 60);
    const ctxPersonalDay = ctx.personal_day ? String(ctx.personal_day).slice(0, 6) : '';
    const ctxPersonalYear = ctx.personal_year ? String(ctx.personal_year).slice(0, 6) : '';
    const ctxUniversalYear = ctx.universal_year ? String(ctx.universal_year).slice(0, 6) : '';
    const ctxKin = String(ctx.kin || '').slice(0, 120);
    const ctxMoon = String(ctx.moon || '').slice(0, 80);
    const ctxIsGAP = !!ctx.is_gap;
    const ctxIsBlackMoon = !!ctx.is_black_moon;
    const ctxIsShivaMoon = !!ctx.is_shiva_moon;
    const ctxIsMaster = !!ctx.is_master_day;
    const ctxDeadline = String(ctx.deadline || '').slice(0, 160);

    const last = (req.body && typeof req.body.last === 'object' && req.body.last) ? req.body.last : null;
    const lastText = last && typeof last.text === 'string' ? last.text.trim().slice(0, 280) : '';
    const lastSummary = last && typeof last.summary === 'string' ? last.summary.trim().slice(0, 280) : '';
    const lastBrought = last && Array.isArray(last.broughtIn)
      ? last.broughtIn.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3).map((x) => x.trim().slice(0, 80))
      : [];
    const isCold = !lastText && !lastSummary;

    // Shared day scaffold, used as light context, not content to recite.
    const dayLines = [
      ctxDateStr ? `Today: ${ctxDateStr}` : '',
      ctxPersonalDay ? `Personal Day: ${ctxPersonalDay}${ctxIsMaster ? ' (a master number day)' : ''}` : '',
      ctxPersonalYear ? `Personal Year: ${ctxPersonalYear}` : '',
      ctxUniversalYear ? `Universal Year: ${ctxUniversalYear}` : '',
      ctxKin ? `Kin: ${ctxKin}${ctxIsGAP ? ' (Galactic Activation Portal day)' : ''}` : '',
      ctxMoon ? `Moon: ${ctxMoon}${ctxIsBlackMoon ? ' (Black Moon, two days before new moon)' : ''}${ctxIsShivaMoon ? ' (Shiva Moon, two days after new moon)' : ''}` : '',
      ctxDeadline ? `A date the person flagged: ${ctxDeadline}` : '',
    ].filter(Boolean).join('\n');

    const voiceNote = safeVoice === 'tradition'
      ? 'Voice: warm and plainspoken, with the lightest symbolic colour where it helps. No jargon, no framework names at the door.'
      : safeVoice === 'science'
        ? 'Voice: warm and plainspoken, grounded in plain psychology where it helps. No mechanism names at the door, no citations.'
        : 'Voice: a wise, plainspoken friend. No tradition jargon, no neuroscience jargon, no citations.';

    let system;
    let userMessage;
    if (isCold) {
      system = `You are the opening line of Cosmic Daily Planner, met by someone arriving for the first time. Say plainly what CDP is and what it is for: a quiet place to find the signal in a noisy day and decide how to meet it, read through two lenses, one ancient and one modern, that point at the same thing. Invite, do not instruct. ${voiceNote}

Rules: two or three short sentences, 35 to 60 words. No exclamation marks. No em dashes. No en dashes. Use commas, periods, or colons. Do not ask the person a question. Do not use the word concerns; use what matters, what is alive, or intentions. Do not name frameworks or researchers. Return only the line.`;
      userMessage = dayLines
        ? `Compose the first time orientation line. Today's coordinates, as light background only, not to recite:\n${dayLines}`
        : 'Compose the first time orientation line for a new arrival.';
    } else {
      system = `You are the home of Cosmic Daily Planner greeting a returning person. Compose one short, pragmatic opener: a brief nod to what last mattered to them, then a pivot to what is alive for them today, then a light, open door to start something new instead. Meet them, do not interrogate them. ${voiceNote}

Rules: two or three short sentences, 35 to 65 words. Address them by first name once if given. No exclamation marks. No em dashes. No en dashes. Use commas, periods, or colons. Do not ask a generic meta question, and never ask what they are holding. Do not use the word concerns; use what matters, what is alive, or intentions. Do not name frameworks or researchers. Return only the line.`;
      const broughtClause = lastBrought.length
        ? `\nThey earlier brought in: ${lastBrought.join('; ')} (you know the names only, never the contents).`
        : '';
      userMessage = `${safeName ? safeName + ' is returning.' : 'A returning person.'}
What last mattered to them: "${lastSummary || lastText}"${broughtClause}
Today's coordinates, as light background only, not to recite:
${dayLines || '(none provided)'}`;
    }

    let text = '';
    try {
      text = await callAPI('claude-sonnet-4-6', 320, system, userMessage);
    } catch (apiErr) {
      console.error('[POST /api/greeting anthropic error]', apiErr.message);
      const fallback = isCold
        ? 'Cosmic Daily Planner is a quiet place to find the signal in a noisy day, and to choose how you meet it. It reads the day through two lenses, one ancient and one modern, that point at the same thing.'
        : `${safeName ? safeName + ', welcome back. ' : 'Welcome back. '}Pick up where you left off, or start something new below.`;
      return res.json({ ok: true, greeting: fallback, voice: safeVoice, cold: isCold, fallback: true });
    }

    if (!text || !text.trim()) {
      return res.status(502).json({ ok: false, error: 'empty_greeting' });
    }

    // House style scrubber, same belt and braces as the reply route.
    let greeting = text.trim().replace(/\n{3,}/g, '\n\n');
    greeting = greeting
      .replace(/\s*\u2014\s*/g, ', ')
      .replace(/(\d)\s*\u2013\s*(\d)/g, '$1-$2')
      .replace(/\s*\u2013\s*/g, ', ')
      .replace(/!+/g, '.')
      .replace(/,\s*,/g, ',')
      .replace(/\.{2,}/g, '.')
      .replace(/,\s*\./g, '.')
      .replace(/\s+,/g, ',')
      .replace(/\s+\./g, '.');

    res.json({ ok: true, greeting, voice: safeVoice, cold: isCold });
  } catch (e) {
    console.error('[POST /api/greeting exception]', e);
    res.status(500).json({ ok: false, error: 'greeting_failed' });
  }
});


// ── /api/compass/coordinate-drawer ─────────────────────────────────
// iter12: when a user taps a chip on the Compass surface, return
// Oracle-generated, bibliography-anchored prose for that chip in their
// current voice. Falls back to graceful static content if the
// Anthropic call fails or the bibliography is unavailable.
//
// Request body:
//   {
//     chip: "time" | "lunar" | "symbol" | "body",
//     voice: "tradition" | "science" | "everyday",
//     coordinates: { pd, ud, personalYear, moonPhase, moonAge,
//                    kinSeal, kinTone, kinNumber, isGAP, isMasterDay,
//                    cyclePhase },
//     userProfile: { firstName, lifePath, birthKin, hasCycleData, tier }
//   }
//
// Response:
//   { title, body_html, citations[], voice, chip, source, ms }
// ─────────────────────────────────────────────────────────────────────

// Voice register instructions (Two Telescopes architecture).
const CDP_DRAWER_VOICES = {
  tradition: "Speak in the TRADITION voice. This is the symbolic-archetypal register.\n" +
    "You draw on Pythagorean numerology, Mayan/Dreamspell calendrics, lunar wisdom across\n" +
    "contemplative traditions, psychological astrology, and contemporary women's-health\n" +
    "practitioner literature. The day is read symbolically as a quality, an invitation, a\n" +
    "season. Practitioner literature (Hill 2019, Pope & Wurlitzer 2017, Greene 1976, Tarnas\n" +
    "2006) is cited authentically when symbolic claims are made. Maya/Dreamspell references\n" +
    "ALWAYS clearly distinguish Argüelles 1987 Dreamspell from the living K'iche' tzolk'in\n" +
    "(Tedlock 1992). Tone: reflective, layered, evocative without being mystical-hype. Never\n" +
    "overclaim. Never use phrases like 'the universe wants', 'manifest', 'vibration', or\n" +
    "'energy' as physical claims.",
  science: "Speak in the SCIENCE voice. This is the empirically-grounded register.\n" +
    "You draw on peer-reviewed cognitive neuroscience (Bremer 2022, Walker 2017, Barrett\n" +
    "2017, Clark 2016), affective neuroscience (Craig 2002, Porges 2011), circadian biology\n" +
    "(Cajochen 2013, Cajochen & Schmidt 2024), psychoneuroimmunology (Bower & Kuhlman 2023,\n" +
    "Mengelkoch 2023), psychoneuroendocrinology (Klusmann 2022, 2023), pain neuroscience\n" +
    "(Riley 1999, Morales-Lalaguna 2025), sleep medicine (Baker & Lee 2023), and clinical\n" +
    "psychology (Lange 2024 on PMDD/PMS). You are HONEST about what is established, what is\n" +
    "suggestive, what is null. When a high-quality null exists you CITE IT (Jang 2025 on\n" +
    "cycle/cognition is the model case: the cycle does not measurably alter cognitive\n" +
    "performance on standardised tasks, BUT it modulates the systems within which cognition\n" +
    "operates, HPA reactivity, sleep architecture, pain perception, mood, inflammation,\n" +
    "all of which are documented). For astrology and symbolic frames you cite Carlson 1985\n" +
    "Nature and Hartmann 2006 as honest counterweights. Tone: precise, calibrated, with\n" +
    "effect-size language where available, never wellness-overclaim. Symbolic frameworks are\n" +
    "clearly labelled as contemplative-anchor rather than predictive mechanism.",
  everyday: "Speak in the EVERYDAY voice. This is the plain-speech register. No jargon\n" +
    "from either side. Same content as the other voices, named in language a smart friend\n" +
    "would use over coffee. Cite occasionally and only where it adds weight; you can also\n" +
    "simply say 'the research suggests' or 'the practitioner tradition holds' without a full\n" +
    "citation. Tone: warm, direct, practical. Never patronising. Never hedging or wishy-washy.\n" +
    "The reader is a sophisticated adult who wants to know what today is for and what to\n" +
    "notice."
};

const CDP_DRAWER_CHIPS = {
  time: "The TIME chip is about TODAY'S NUMEROLOGICAL/CYCLICAL SIGNATURE, the quality\n" +
    "of attention this specific day asks for. Personal Day numerology is the primary input.\n" +
    "If today is a master number day (11, 22, 33, 44) flag that with its specific quality.",
  lunar: "The LUNAR chip is about WHERE WE ARE IN THE LUNAR CYCLE. Moon phase, days\n" +
    "since new moon, proximity to full or new moon. CDP-specific concepts: Black Moon (2\n" +
    "days before new moon, a tricky preparatory window) and Shiva Moon (2 days after new\n" +
    "moon, a blissful settling window) are part of the lunar lexicon when relevant.",
  symbol: "The SYMBOL chip is about TODAY'S DREAMSPELL KIN, the symbolic-archetypal\n" +
    "day-quality from Argüelles 1987. Tone (1-13) names the developmental position in a\n" +
    "13-day wavespell. Seal (the named archetype like Red Skywalker, White Wind, Blue Hand)\n" +
    "carries the archetypal quality. Galactic Activation Portals (GAP days, 52 canonical\n" +
    "entries) deserve specific note when present.",
  body: "The BODY chip is about WHAT THE BODY IS DOING TODAY and how to read it as a\n" +
    "compass. Interoception is the empirical backbone. If cycle data is available, hormonal\n" +
    "phase is the primary input AND is treated honestly: the cycle modulates the systems\n" +
    "within which cognition operates (HPA, sleep, pain, mood, inflammation) even when\n" +
    "cognitive performance on objective tasks does not measurably shift (Jang 2025). The\n" +
    "four-seasons framing (inner winter/spring/summer/autumn) is practitioner literature\n" +
    "(Hill 2019, Pope & Wurlitzer 2017) and labelled as such."
};

// In-memory response cache, TTL 1 hour, soft cap 500 entries.
const CDP_DRAWER_CACHE = new Map();
const CDP_DRAWER_CACHE_TTL_MS = 60 * 60 * 1000;

function cdpDrawerCacheKey(chip, voice, coords, profile) {
  const c = coords || {};
  const p = profile || {};
  return [
    chip, voice,
    c.pd || '', c.moonPhase || '', c.kinTone || '', c.kinSeal || '',
    c.cyclePhase || '', c.isGAP ? '1' : '0', c.isMasterDay ? '1' : '0',
    (p.firstName || '').slice(0, 16)
  ].join('|');
}

function cdpResolveReferences(chip, voice, coords) {
  if (!CDP_BIBLIOGRAPHY || !CDP_BIBLIOGRAPHY.entries) return [];
  const key = chip + '_' + voice;
  const defaults = (CDP_BIBLIOGRAPHY.voice_chip_default_refs || {})[key] || [];
  const refs = [...defaults];
  const claimToEntries = CDP_BIBLIOGRAPHY.claim_to_entries || {};
  if (chip === 'body' && coords && coords.cyclePhase) {
    (claimToEntries['systems_cycle_affects'] || []).forEach(r => {
      if (!refs.includes(r)) refs.push(r);
    });
  }
  if (chip === 'time' && coords && coords.isMasterDay) {
    (claimToEntries['pythagorean_lineage'] || []).forEach(r => {
      if (!refs.includes(r)) refs.push(r);
    });
  }
  if (chip === 'symbol' && coords && coords.isGAP) {
    (claimToEntries['maya_astronomy'] || []).forEach(r => {
      if (!refs.includes(r)) refs.push(r);
    });
  }
  return refs.filter(r => CDP_BIBLIOGRAPHY.entries[r]);
}

function cdpBuildDrawerPrompt(chip, voice, coords, profile, refIds) {
  const voiceInstr = CDP_DRAWER_VOICES[voice] || CDP_DRAWER_VOICES.tradition;
  const chipRole = CDP_DRAWER_CHIPS[chip] || CDP_DRAWER_CHIPS.time;
  const refsBlock = refIds.map(refId => {
    const e = CDP_BIBLIOGRAPHY.entries[refId];
    if (!e) return '';
    const authors = Array.isArray(e.authors) ? e.authors.join('; ') : (e.authors || '');
    const where = e.journal || e.publisher || '';
    return '  ' + refId + ': ' + authors + ' (' + e.year + '). ' + e.title + '. ' + where + '. ' + (e.note || '');
  }).filter(Boolean).join('\n');
  
  const c = coords || {};
  const coordsLines = [];
  if (c.pd) coordsLines.push('Personal Day: ' + c.pd);
  if (c.ud) coordsLines.push('Universal Day: ' + c.ud);
  if (c.personalYear) coordsLines.push('Personal Year: ' + c.personalYear);
  if (c.moonPhase) coordsLines.push('Moon phase: ' + c.moonPhase + (c.moonAge ? ' (day ' + c.moonAge + ' of cycle)' : ''));
  if (c.kinTone && c.kinSeal) coordsLines.push('Dreamspell Kin: ' + c.kinTone + ' ' + c.kinSeal + (c.kinNumber ? ' (Kin ' + c.kinNumber + ')' : ''));
  if (c.isGAP) coordsLines.push('Galactic Activation Portal day');
  if (c.isMasterDay) coordsLines.push('Master number day (carries amplified quality)');
  if (c.cyclePhase) coordsLines.push('Hormonal phase: ' + c.cyclePhase);
  
  const p = profile || {};
  const profileLines = [];
  if (p.firstName) profileLines.push("Reader's name: " + p.firstName);
  if (p.lifePath) profileLines.push("Reader's Life Path: " + p.lifePath);
  
  return 'You are composing the ' + chip.toUpperCase() + ' drawer for the Cosmic Daily Planner\n' +
    'Compass surface. CDP synthesises Pythagorean numerology, Western psychological astrology,\n' +
    'Mayan/Dreamspell calendrics, and lunar cycles into a daily personalised reading. The\n' +
    "central premise is Two Telescopes: ancient contemplative traditions and modern\n" +
    'neuroscience are not competing explanations, they point at the same coordinates from\n' +
    'different epistemic positions.\n\n' +
    voiceInstr + '\n\n' +
    chipRole + '\n\n' +
    "TODAY'S COORDINATES:\n" + coordsLines.join('\n') + '\n\n' +
    'READER CONTEXT:\n' + (profileLines.join('\n') || '(no profile-specific data provided)') + '\n\n' +
    'AVAILABLE REFERENCES (cite by id using <span class="v11-cite" data-ref="REF_ID">Display Text</span>):\n' +
    refsBlock + '\n\n' +
    'OUTPUT RULES:\n' +
    '- Output STRICTLY a single JSON object with exactly these keys: title, body_html.\n' +
    '- title: 4-9 words. Names the coordinate concretely. No quotes inside the title.\n' +
    '- body_html: 100-160 words of prose in valid HTML. Use <p> tags for paragraphs. Wrap\n' +
    '  citation markers as <span class="v11-cite" data-ref="ref-id">Author Year</span>.\n' +
    '  Use 2-4 distinct citations. Cite only refs from the AVAILABLE REFERENCES list above.\n' +
    '- Voice register MUST match the voice instruction above.\n' +
    '- No em-dashes (U+2014) or en-dashes (U+2013) anywhere, use commas, colons, or\n' +
    '  restructure the sentence.\n' +
    '- No exclamation marks anywhere.\n' +
    '- No \'manifest\', \'vibration\', \'energy field\', \'the universe wants you\', \'evidence-based\'\n' +
    '  as a marketing word.\n' +
    '- If the topic is the menstrual cycle in the Science voice, you MUST be honest about\n' +
    '  what the empirical literature does and does not show. The cycle modulates many\n' +
    '  systems (HPA, sleep, pain, mood, inflammation) but Jang 2025 found no robust effect\n' +
    '  on cognitive performance tasks specifically, that nuance is required.\n' +
    '- If the topic involves astrology in the Science voice, you MUST acknowledge the\n' +
    '  sceptical literature (Carlson 1985 Nature, Hartmann 2006) appropriately.\n\n' +
    'OUTPUT FORMAT (JSON only, no preamble, no markdown fences):\n' +
    '{"title":"...","body_html":"<p>...</p>"}';
}

function cdpExtractCitations(bodyHtml) {
  const cites = [];
  if (!bodyHtml || !CDP_BIBLIOGRAPHY) return cites;
  const re = /<span\s+class="v11-cite"\s+data-ref="([^"]+)"[^>]*>([^<]+)<\/span>/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(bodyHtml)) !== null) {
    const refId = m[1];
    if (seen.has(refId)) continue;
    seen.add(refId);
    const e = CDP_BIBLIOGRAPHY.entries[refId];
    if (!e) continue;
    cites.push({
      ref: refId,
      display: m[2],
      authors: Array.isArray(e.authors) ? e.authors.join(', ') : (e.authors || ''),
      year: e.year,
      title: e.title,
      journal: e.journal || null,
      publisher: e.publisher || null,
      doi: e.doi || null,
      url: e.url || null,
      type: e.type || null,
      lineage: e.lineage || null
    });
  }
  return cites;
}

function cdpSanitiseDrawerHtml(s) {
  if (!s) return '';
  let out = s.replace(/\u2014/g, ', ').replace(/\u2013/g, ', ');
  out = out.replace(/!/g, '.');
  out = out.replace(/,\s*,/g, ',');
  out = out.replace(/,\s*\./g, '.');
  return out;
}

function cdpFallbackDrawer(chip, voice, coords) {
  const c = coords || {};
  const cite = (refId, text) => {
    if (!CDP_BIBLIOGRAPHY || !CDP_BIBLIOGRAPHY.entries || !CDP_BIBLIOGRAPHY.entries[refId]) return text;
    return '<span class="v11-cite" data-ref="' + refId + '">' + text + '</span>';
  };
  const F = {
    time: {
      tradition: {
        title: 'Personal Day ' + (c.pd || '?') + ' in the Pythagorean count',
        body_html: '<p>In Pythagorean numerology today reduces to ' + (c.pd || '?') + '. Each number carries a specific quality of attention. ' + cite('drayer-2002', 'Drayer 2002') + ' offers the practitioner depth; ' + cite('kahn-2001', 'Kahn 2001') + ' anchors the historical lineage in the school at Croton. Read today as a quality, not a script.</p>'
      },
      science: {
        title: 'Cognitive rhythm signature today',
        body_html: '<p>Personal-day signatures correlate loosely with shifts in default-mode network activity versus salience-network engagement, per ' + cite('bremer-2022', 'Bremer 2022') + '. Hippocampal consolidation favours reflective windows, per ' + cite('walker-2017', 'Walker 2017') + '. One input among many, not a deterministic claim.</p>'
      },
      everyday: {
        title: "Today's quality",
        body_html: '<p>Today has a specific feel. Easier to do some things, harder to do others. Work with the day rather than around it.</p>'
      }
    },
    lunar: {
      tradition: {
        title: (c.moonPhase || 'Moon') + ' tonight',
        body_html: '<p>The moon is in ' + (c.moonPhase || 'transition') + '. Lunar wisdom across traditions reads this phase as a turning point in the cycle. CDP draws phase timing from ' + cite('usno', 'USNO') + '.</p>'
      },
      science: {
        title: 'Lunar position and sleep',
        body_html: '<p>Lunar phase has measurable effects on melatonin and sleep architecture in controlled conditions, per ' + cite('cajochen-2013', 'Cajochen et al 2013') + '. Subtle but real; one input alongside circadian timing and sleep history.</p>'
      },
      everyday: {
        title: (c.moonPhase || 'Moon') + ' tonight',
        body_html: '<p>The moon is in ' + (c.moonPhase || 'transition') + '. Notice your sleep, your patience, your appetite this week.</p>'
      }
    },
    symbol: {
      tradition: {
        title: (c.kinTone || '') + ' ' + (c.kinSeal || 'Kin'),
        body_html: '<p>The Dreamspell synthesis is ' + cite('arguelles-1987', 'Arguelles 1987') + ", distinct from the living K'iche' tzolk'in documented by " + cite('tedlock-1992', 'Tedlock 1992') + '. Read symbolically, not as prediction.</p>'
      },
      science: {
        title: 'Symbolic anchor for today',
        body_html: '<p>The Dreamspell Kin is a 260-day symbolic count, ' + cite('arguelles-1987', 'Arguelles 1987') + ', used here as a contemplative anchor. For empirical claims about natal astrology, the sceptical literature includes ' + cite('carlson-1985', 'Carlson 1985') + '.</p>'
      },
      everyday: {
        title: (c.kinTone || '') + ' ' + (c.kinSeal || 'today'),
        body_html: '<p>CDP uses a 13-day symbolic count. Take it as a lens, not a prediction.</p>'
      }
    },
    body: {
      tradition: {
        title: c.cyclePhase ? (c.cyclePhase + ' phase') : 'Body as compass',
        body_html: c.cyclePhase
          ? "<p>Hormonal phase: " + c.cyclePhase + ". Across contemplative women's-health practitioner literature (" + cite('hill-2019', 'Hill 2019') + ', ' + cite('pope-wurlitzer-2017', 'Pope and Wurlitzer 2017') + '), each phase carries its own quality of energy, attention, and relational sensitivity.</p>'
          : '<p>The body is the first signal. ' + cite('porges-2011', 'Porges 2011') + ' on neuroception offers the bridge between contemplative attention and physiological reading.</p>'
      },
      science: {
        title: c.cyclePhase ? (c.cyclePhase + ' phase signature') : 'Interoception today',
        body_html: c.cyclePhase
          ? '<p>The cycle modulates the systems within which cognition operates. ' + cite('klusmann-2023', 'Klusmann 2023') + ' shows higher HPA reactivity in luteal phase. ' + cite('baker-lee-2023', 'Baker and Lee 2023') + ' documents sleep architecture changes. ' + cite('riley-1999', 'Riley 1999') + ' shows phase-dependent pain perception. ' + cite('jang-2025', 'Jang 2025') + ' finds no robust effect on cognitive performance tasks specifically, even as these underlying systems shift.</p>'
          : '<p>The genuine body signal is interoception, ' + cite('craig-2002', 'Craig 2002') + ': noticing internal state directly.</p>'
      },
      everyday: {
        title: c.cyclePhase ? (c.cyclePhase + ' phase') : 'How is your body today?',
        body_html: c.cyclePhase
          ? '<p>You are in ' + c.cyclePhase + '. Some phases are for output, some for integration, per ' + cite('hill-2019', 'Hill 2019') + '. Adjust the day to match.</p>'
          : '<p>Take 30 seconds. Where is energy in your body. Where is tension. The answer matters.</p>'
      }
    }
  };
  return (F[chip] && F[chip][voice]) || F.time.tradition;
}

app.post('/api/compass/coordinate-drawer', async (req, res) => {
  const t0 = Date.now();
  try {
    const body = req.body || {};
    const chip = String(body.chip || '').toLowerCase();
    const voice = String(body.voice || 'tradition').toLowerCase();
    const coords = body.coordinates || {};
    const profile = body.userProfile || {};
    
    const VALID_CHIPS = ['time', 'lunar', 'symbol', 'body'];
    const VALID_VOICES = ['tradition', 'science', 'everyday'];
    if (!VALID_CHIPS.includes(chip)) {
      return res.status(400).json({ error: 'invalid chip', valid: VALID_CHIPS });
    }
    if (!VALID_VOICES.includes(voice)) {
      return res.status(400).json({ error: 'invalid voice', valid: VALID_VOICES });
    }
    if (!CDP_BIBLIOGRAPHY) {
      return res.status(500).json({ error: 'bibliography unavailable on server' });
    }
    
    // iter12c PRIVACY GATE: strip cyclePhase unless the user has explicitly
    // opted in via userProfile.tracksCycle. This is the second line of defence;
    // the frontend strips cyclePhase too. Two defences because cycle data is
    // sensitive and applying it to the wrong user is a serious product failure.
    if (coords && coords.cyclePhase && profile.tracksCycle !== true) {
      console.log('[coordinate-drawer] stripping cyclePhase, tracksCycle not set');
      delete coords.cyclePhase;
    }
    
    // Cache check
    const cacheKey = cdpDrawerCacheKey(chip, voice, coords, profile);
    const cachedEntry = CDP_DRAWER_CACHE.get(cacheKey);
    if (cachedEntry && (Date.now() - cachedEntry.t) < CDP_DRAWER_CACHE_TTL_MS) {
      return res.json(Object.assign({}, cachedEntry.payload, { cached: true, ms: Date.now() - t0 }));
    }
    
    const refIds = cdpResolveReferences(chip, voice, coords);
    let result;
    let source = 'oracle';
    
    if (!process.env.ANTHROPIC_API_KEY) {
      result = cdpFallbackDrawer(chip, voice, coords);
      source = 'fallback_no_apikey';
    } else {
      try {
        const sys = cdpBuildDrawerPrompt(chip, voice, coords, profile, refIds);
        const userMsg = 'Compose the drawer JSON for this chip and these coordinates. Output JSON only.';
        let raw = await callAPI('claude-sonnet-4-6', 1024, sys, userMsg);
        raw = (raw || '').replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
        
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (parseErr) {
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) {
            try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; }
          }
        }
        
        if (!parsed || !parsed.title || !parsed.body_html) {
          console.warn('[coordinate-drawer] invalid JSON shape, using fallback');
          result = cdpFallbackDrawer(chip, voice, coords);
          source = 'fallback_bad_json';
        } else {
          parsed.title = cdpSanitiseDrawerHtml(parsed.title);
          parsed.body_html = cdpSanitiseDrawerHtml(parsed.body_html);
          result = parsed;
        }
      } catch (apiErr) {
        console.error('[coordinate-drawer] Anthropic call failed:', apiErr.message);
        result = cdpFallbackDrawer(chip, voice, coords);
        source = 'fallback_api_error';
      }
    }
    
    const citations = cdpExtractCitations(result.body_html);
    const payload = {
      title: result.title,
      body_html: result.body_html,
      citations: citations,
      voice: voice,
      chip: chip,
      coordinates_echo: coords,
      generated_at: new Date().toISOString(),
      source: source
    };
    
    // Cache (with soft cap)
    CDP_DRAWER_CACHE.set(cacheKey, { t: Date.now(), payload: payload });
    if (CDP_DRAWER_CACHE.size > 500) {
      const oldest = [...CDP_DRAWER_CACHE.entries()].sort((a, b) => a[1].t - b[1].t)[0];
      if (oldest) CDP_DRAWER_CACHE.delete(oldest[0]);
    }
    
    return res.json(Object.assign({}, payload, { cached: false, ms: Date.now() - t0 }));
  } catch (e) {
    console.error('[coordinate-drawer] handler error:', e.stack || e.message);
    return res.status(500).json({ error: 'internal error', detail: e.message });
  }
});


// ── /api/streak ────────────────────────────────────────────────────
// Read the user's current streak state. Always returns a coherent
// record (zero-state for new users) so the client can render
// unconditionally.
app.get('/api/streak', (req, res) => {
  try {
    const userId = v19_userKey(req);
    const tz = v19_userTimezone(req);
    if (!userId) return res.json({
      ok: true, current: 0, longest: 0, last_visit: null, status: 'new', history_30d: []
    });

    const record = v19_streaks.get(userId);
    if (!record) return res.json({
      ok: true, current: 0, longest: 0, last_visit: null, status: 'new', history_30d: []
    });

    // history_30d: the last 30 days as a boolean array, oldest first.
    // Used by the streak page to render the calendar grid.
    const today = v19_dayString(new Date(), tz);
    const history30 = [];
    for (let i = 29; i >= 0; i--) {
      const d = v19_dayString(new Date(Date.now() - i * 86400000), tz);
      history30.push(record.history.includes(d));
    }

    res.json({
      ok: true,
      current: record.current,
      longest: record.longest,
      last_visit: record.lastVisit,
      status: record.status || 'active',
      history_30d: history30,
    });
  } catch (e) {
    console.error('[GET /api/streak exception]', e);
    res.status(500).json({ error: 'streak read failed' });
  }
});

// ── /api/streak/visit ──────────────────────────────────────────────
// Record a daily visit. Idempotent per day. Implements the gentle
// resume logic from Vol 16 spec section 2.2:
//   - Same day:        no-op (already recorded)
//   - Day +1:          increment streak normally
//   - Day +2:          gentle resume; streak preserved with a flag
//   - Day +3 or more:  soft reset; streak starts at 1 today
//
// All resets are framed as beginnings, never losses. The status field
// drives the client copy ('active' / 'gentle_resume' / 'fresh_start').
app.post('/api/streak/visit', (req, res) => {
  try {
    const userId = v19_userKey(req);
    const tz = v19_userTimezone(req);
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    const today = v19_dayString(new Date(), tz);
    let record = v19_streaks.get(userId);

    if (!record) {
      // First visit ever
      record = {
        current: 1, longest: 1, lastVisit: today,
        history: [today], status: 'active',
      };
      v19_streaks.set(userId, record);
      console.log(`[v19 streak_first_visit] user=${userId.slice(0,8)}`);
      return res.json({ ok: true, current: 1, longest: 1, status: 'active', delta: 'started' });
    }

    if (record.lastVisit === today) {
      // Already recorded today; idempotent
      return res.json({ ok: true, current: record.current, longest: record.longest, status: record.status, delta: 'noop' });
    }

    const gap = v19_daysBetween(record.lastVisit, today);
    let delta;

    if (gap === 1) {
      // Consecutive day: streak increments normally
      record.current += 1;
      record.status = 'active';
      delta = 'increment';
    } else if (gap === 2) {
      // One day missed: gentle resume, streak preserved
      record.current += 1;
      record.status = 'gentle_resume';
      delta = 'gentle_resume';
    } else {
      // Two or more days missed: streak starts fresh today
      record.current = 1;
      record.status = 'fresh_start';
      delta = 'fresh_start';
    }

    if (record.current > record.longest) record.longest = record.current;
    record.lastVisit = today;
    record.history.push(today);

    // Trim history to last 90 days to bound memory
    const cutoff = v19_dayString(new Date(Date.now() - 90 * 86400000), tz);
    record.history = record.history.filter(d => d >= cutoff);

    v19_streaks.set(userId, record);

    console.log(`[v19 streak_visit] user=${userId.slice(0,8)} current=${record.current} delta=${delta}`);
    res.json({
      ok: true,
      current: record.current,
      longest: record.longest,
      status: record.status,
      delta,
    });
  } catch (e) {
    console.error('[POST /api/streak/visit exception]', e);
    res.status(500).json({ error: 'streak visit failed' });
  }
});

// ── /api/memory/summary ────────────────────────────────────────────
// Store a compact summary of a reading. v19 ships the storage; v20
// builds the surface that uses these summaries to make readings feel
// continuous. Schema deliberately small: timestamp, themes, key
// insight (one sentence), user_state. Total target: 180-220 words.
app.post('/api/memory/summary', (req, res) => {
  try {
    const userId = v19_userKey(req);
    const { themes, insight, user_state, source_reading_id } = req.body || {};

    if (!userId) return res.status(400).json({ error: 'user_id required' });
    if (typeof insight !== 'string' || insight.length > 1200) {
      return res.status(400).json({ error: 'insight required (max 1200 chars)' });
    }

    const record = {
      created_at: new Date().toISOString(),
      themes: Array.isArray(themes) ? themes.slice(0, 8) : [],
      insight: insight.trim(),
      user_state: typeof user_state === 'string' ? user_state.slice(0, 240) : null,
      source_reading_id: source_reading_id || null,
    };

    if (!v19_summaries.has(userId)) v19_summaries.set(userId, []);
    const list = v19_summaries.get(userId);
    list.push(record);

    // Bound to 200 most recent summaries per user
    if (list.length > 200) list.splice(0, list.length - 200);

    v19_metrics.recordSummaryStore(record.themes.length, record.insight.length);

    console.log(`[v19 summary_stored] user=${userId.slice(0,8)} themes=${record.themes.length}`);
    res.json({ ok: true, count: list.length });
  } catch (e) {
    console.error('[POST /api/memory/summary exception]', e);
    res.status(500).json({ error: 'summary store failed' });
  }
});

// ── /api/v19/metrics ──────────────────────────────────────────────
// Day 13 deliverable. Snapshot of cost-audit metrics. Sophisticated
// reviewers (or Ned) can call this to verify the spec's targets:
//   - Context-injection p95 tokens stays under budget (default 500)
//   - Reading-prompt total p95 stays under model context limit
//   - Context-share-of-total stays under 25%
app.get('/api/v19/metrics', (req, res) => {
  res.json({
    ok: true,
    snapshot: v19_metrics.snapshot(),
    targets: {
      context_p95_max_tokens: 500,
      context_share_max_pct: 25,
      reading_prompt_p95_max_total: 12000, // claude-3.5 context allows much more, but we cap for cost
    },
  });
});

// ── /api/v19/record-prompt ────────────────────────────────────────
// Reading-pipeline integration hook. The existing reading pipeline
// in server.js can POST here to record prompt sizes for the metrics
// dashboard. v20 will move this to an internal call rather than a
// round-trip endpoint.
app.post('/api/v19/record-prompt', (req, res) => {
  try {
    const { base_tokens, context_tokens } = req.body || {};
    if (!Number.isFinite(base_tokens) || !Number.isFinite(context_tokens)) {
      return res.status(400).json({ error: 'base_tokens and context_tokens required' });
    }
    v19_metrics.recordReadingPrompt(base_tokens, context_tokens);
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/v19/record-prompt exception]', e);
    res.status(500).json({ error: 'metric record failed' });
  }
});

// ── /api/memory/recent ─────────────────────────────────────────────
// Retrieve recent summaries for a user. Default last 7, max 30.
// Optional theme filter. v20 will use this to inject 1-3 relevant
// past summaries into the prompt for a new reading; v19 just exposes
// the data path so the foundation is real.
app.get('/api/memory/recent', (req, res) => {
  try {
    const userId = v19_userKey(req);
    if (!userId) return res.json({ ok: true, summaries: [] });

    const limit = Math.min(parseInt(req.query.limit, 10) || 7, 30);
    const themeFilter = req.query.theme;

    const all = v19_summaries.get(userId) || [];
    let filtered = all;
    if (themeFilter) {
      filtered = all.filter(s => s.themes.some(t => t.toLowerCase() === themeFilter.toLowerCase()));
    }

    // Most recent first
    const recent = filtered.slice().reverse().slice(0, limit);

    res.json({ ok: true, count: recent.length, summaries: recent });
  } catch (e) {
    console.error('[GET /api/memory/recent exception]', e);
    res.status(500).json({ error: 'summary read failed' });
  }
});

// ── /api/memory/context ────────────────────────────────────────────
// Day 11 deliverable. Returns a prompt-ready continuity block built
// from the user's recent summaries, capped at the requested token
// budget. The reading-generation pipeline calls this before
// constructing its prompt; the returned block is concatenated into
// the system prompt so the next reading has real context.
//
// The token budget defaults to 500 and is bounded at 1500 to prevent
// runaway prompt growth. The selection algorithm prefers:
//   1. Most recent summaries first (recency bias)
//   2. Thematic relevance to the current reading (if `themes` query
//      param is provided, summaries with overlapping themes weight
//      higher)
//   3. Diversity (no two summaries from the same calendar day)
//
// Output shape:
//   {
//     ok: true,
//     block: "... formatted continuity block ...",
//     summaries_used: [{ created_at, themes }, ...],
//     estimated_tokens: 380
//   }
app.get('/api/memory/context', (req, res) => {
  try {
    const userId = v19_userKey(req);
    if (!userId) return res.json({ ok: true, block: '', summaries_used: [], estimated_tokens: 0 });

    const budget = Math.min(parseInt(req.query.budget, 10) || 500, 1500);
    const themesQuery = (req.query.themes || '').toString();
    const themesWanted = themesQuery
      ? themesQuery.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
      : [];

    const all = v19_summaries.get(userId) || [];
    if (all.length === 0) {
      return res.json({ ok: true, block: '', summaries_used: [], estimated_tokens: 0 });
    }

    // Score each summary
    const now = Date.now();
    const scored = all.map(s => {
      const ageDays = (now - new Date(s.created_at).getTime()) / 86400000;
      const recencyScore = Math.max(0, 1 - ageDays / 30); // 0..1, full at today, decays over 30 days
      const themeScore = themesWanted.length === 0 ? 0
        : s.themes.some(t => themesWanted.includes(t.toLowerCase())) ? 1 : 0;
      // Recency 70%, theme 30%
      return { summary: s, score: recencyScore * 0.7 + themeScore * 0.3, dayKey: s.created_at.slice(0, 10) };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Greedy selection with diversity (one per calendar day) and budget cap
    const selected = [];
    const usedDays = new Set();
    let runningTokens = 0;
    const TOKENS_PER_CHAR = 0.25; // rough estimate for English prose

    for (const item of scored) {
      if (usedDays.has(item.dayKey)) continue;
      const block = v19_formatSummaryForPrompt(item.summary);
      const itemTokens = Math.ceil(block.length * TOKENS_PER_CHAR);
      if (runningTokens + itemTokens > budget) break;
      selected.push(item);
      runningTokens += itemTokens;
      usedDays.add(item.dayKey);
      if (selected.length >= 5) break; // hard cap on number of summaries
    }

    // Build the continuity block
    let block = '';
    if (selected.length > 0) {
      block = '## Continuity from recent readings\n\n';
      block += 'The following summaries are from this user\'s recent CDP readings, ';
      block += 'most recent first. Use them to make today\'s reading feel continuous, ';
      block += 'thematically aware, and personally familiar. Do not name the past readings ';
      block += 'verbatim; weave their themes and threads naturally.\n\n';
      // Recency-order for the prompt (most recent first)
      const ordered = selected.slice().sort((a, b) =>
        new Date(b.summary.created_at).getTime() - new Date(a.summary.created_at).getTime()
      );
      for (const item of ordered) {
        block += v19_formatSummaryForPrompt(item.summary) + '\n';
      }
    }

    res.json({
      ok: true,
      block,
      summaries_used: selected.map(s => ({
        created_at: s.summary.created_at,
        themes: s.summary.themes,
      })),
      estimated_tokens: runningTokens,
    });
    v19_metrics.recordContextBuild(runningTokens, selected.length, budget);
  } catch (e) {
    console.error('[GET /api/memory/context exception]', e);
    res.status(500).json({ error: 'context build failed' });
  }
});

function v19_formatSummaryForPrompt(s) {
  // Compact, prompt-friendly format. One block per summary.
  // Format: ISO date, themes, insight, optional state.
  const date = s.created_at.slice(0, 10);
  let block = `[${date}]`;
  if (s.themes && s.themes.length) block += ` themes: ${s.themes.slice(0, 4).join(', ')}.`;
  if (s.insight) block += ` insight: ${s.insight}`;
  if (s.user_state) block += ` user state at the time: ${s.user_state}.`;
  return block;
}

// ── /api/email/capture ─────────────────────────────────────────────
// Capture an email + timezone for a user who has opted in to deeper
// engagement. NO BROADCAST is sent in v19; this is the storage and
// instrumentation only. v20 builds the actual morning-trigger send.
//
// The opt-in surface is presented in-product, value-coupled (e.g.
// after a meaningful reading completes), never on entry.
app.post('/api/email/capture', (req, res) => {
  try {
    const userId = v19_userKey(req);
    const { email, timezone } = req.body || {};

    if (!userId) return res.status(400).json({ error: 'user_id required' });
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'valid email required' });
    }
    if (typeof timezone !== 'string' || timezone.length > 60) {
      return res.status(400).json({ error: 'timezone required (e.g. Europe/London)' });
    }

    v19_emails.set(userId, {
      email: email.toLowerCase().trim(),
      timezone: timezone.trim(),
      capturedAt: new Date().toISOString(),
    });

    console.log(`[v19 email_captured] user=${userId.slice(0,8)} tz=${timezone}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/email/capture exception]', e);
    res.status(500).json({ error: 'email capture failed' });
  }
});

// ── /sw-v19.js ─────────────────────────────────────────────────────
// Day 5: serve the v19 service worker at the origin root so its scope
// covers the whole app. Service workers can only have scope at or
// below the path they are served from.
app.get('/sw-v19.js', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    // Try several plausible locations so this works in dev, beta and live
    const candidates = [
      path.join(__dirname, 'sw-v19.js'),
      path.join(__dirname, 'public', 'sw-v19.js'),
      path.join(process.cwd(), 'sw-v19.js'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Service-Worker-Allowed', '/');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(fs.readFileSync(p));
      }
    }
    res.status(404).send('// service worker not found');
  } catch (e) {
    console.error('[GET /sw-v19.js exception]', e);
    res.status(500).send('// service worker error');
  }
});

// ── /api/v19/health ────────────────────────────────────────────────
// Quick check that v19 surfaces are wired and counts are sane.
app.get('/api/v19/health', (req, res) => {
  res.json({
    ok: true,
    version: 'v19-fallback',
    storage: 'in-memory',
    counts: {
      streaks: v19_streaks.size,
      intentions: v19_intentions.size,
      summaries: v19_summaries.size,
      emails: v19_emails.size,
    },
    metrics: v19_metrics.snapshot(),
    capabilities: {
      compass: true,
      streak: true,
      intention_save: true,
      memory_summary: true,
      memory_context_injection: true,
      email_capture: true,
      timezone_aware: true,
      cost_audit: true,
    },
  });
});

// ── /api/v19/__test_backdate ───────────────────────────────────────
// TEST-ONLY endpoint, gated on NODE_ENV=test. Allows the test harness
// to verify the gentle-resume and fresh-start branches of the streak
// engine without manipulating the in-memory Map directly. In any
// non-test environment this endpoint returns 404.
app.post('/api/v19/__test_backdate', (req, res) => {
  if (process.env.NODE_ENV !== 'test') {
    return res.status(404).json({ error: 'not found' });
  }
  const { kind, user_id, days_ago, current, longest, intention } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  if (kind === 'intention') {
    if (!Number.isFinite(days_ago) || typeof intention !== 'string') {
      return res.status(400).json({ error: 'days_ago and intention required for intention backdate' });
    }
    const day = v19_dayString(new Date(Date.now() - days_ago * 86400000), null);
    if (!v19_intentions.has(user_id)) v19_intentions.set(user_id, {});
    v19_intentions.get(user_id)[day] = intention;
    return res.json({ ok: true, planted_date: day });
  }

  // Default: streak backdate
  if (!Number.isFinite(days_ago)) {
    return res.status(400).json({ error: 'days_ago required' });
  }
  v19_streaks.set(user_id, {
    current: current || 1,
    longest: longest || (current || 1),
    lastVisit: v19_dayString(new Date(Date.now() - days_ago * 86400000), null),
    history: [],
    status: 'active',
  });
  res.json({ ok: true });
});


console.log('[v19] Endpoints attached: compass, streak, memory, email-capture, sw, metrics, A/B, notif (FALLBACK MODE: in-memory storage)');

// ── v21 PATCH: Kin anchor diagnostic routes ───────────────────────────
// Adds /api/kin/diagnose and /api/kin/known-tests. Read-only. Does not change
// any existing calculation. See cdp-server-patch-v21.js and the v21 runbook.
try {
  require('./cdp-server-patch-v21').register(app, { astroService });
  console.log('CDP v21 patch routes registered');
} catch (e) {
  console.error('CDP v21 patch failed to register:', e.message);
}

// ── Compose-depth route: the bounded, lens-disciplined Compass reflection ─────
// POST /api/compose/depth, backed by the tested coordinates and lenses modules.
// Additive and bounded (4000 tokens, single request), so it cannot hang the way
// a long reading can. Drop coordinates.js, lenses.js, and compose-depth.js into
// the repo root alongside this file for the require to resolve.
try {
  let _composeDepth;
  try { _composeDepth = require('./lib/compose-depth'); }
  catch (_e) { _composeDepth = require('./compose-depth'); }
  _composeDepth.register(app);
  console.log('CDP compose-depth route registered');
} catch (e) {
  console.error('CDP compose-depth failed to register:', e.message);
}

// ── Catch-all SPA route ──────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CDP v9, port ${PORT}`);
  console.log(`API key: ${process.env.ANTHROPIC_API_KEY ? 'present ✓' : 'MISSING ✗, readings will fail'}`);
});

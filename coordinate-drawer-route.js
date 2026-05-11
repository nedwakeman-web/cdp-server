/* ════════════════════════════════════════════════════════════════════════════
   coordinate-drawer-route.js
   
   Standalone Express route that adds POST /api/compass/coordinate-drawer to
   your existing app. Self-contained: does its own Anthropic init, its own
   bibliography load, its own error handling.
   
   INSTALLATION:
   1. Place this file at:  cdp-server/coordinate-drawer-route.js
   2. Place bibliography.json at:  cdp-server/bibliography.json
   3. In server.js, add ONE line near where your other routes are registered
      (anywhere AFTER `const app = express();` and `app.use(express.json())`):
      
          require('./coordinate-drawer-route')(app);
      
   That is the entire integration. No other server.js changes needed.
   
   REQUIRES:
   - @anthropic-ai/sdk  (already a dependency in cdp-server for the Oracle
     reading flow)
   - ANTHROPIC_API_KEY  (environment variable, already set on Railway)
   
   Returns:
     {
       title: "...",
       body_html: "<p>...</p>",
       citations: [ { ref, authors, year, title, journal, doi, url, ... }, ... ],
       voice: "tradition" | "science" | "everyday",
       chip: "time" | "lunar" | "symbol" | "body",
       source: "oracle" | "fallback_no_anthropic" | "fallback_error",
       cached: bool,
       ms: int
     }
   ════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

/* Lazy load Anthropic so this file can be required even if the SDK is not
   yet installed at boot time. */
let _anthropic = null;
function getAnthropic() {
  if (_anthropic !== null) return _anthropic;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!key) {
      console.warn('[coordinate-drawer] ANTHROPIC_API_KEY missing; will use fallback content');
      _anthropic = false;
      return false;
    }
    _anthropic = new Anthropic({ apiKey: key });
    console.log('[coordinate-drawer] Anthropic client initialised');
    return _anthropic;
  } catch (e) {
    console.warn('[coordinate-drawer] Anthropic SDK not available:', e.message);
    _anthropic = false;
    return false;
  }
}

/* Bibliography cache (loaded once at boot) */
let _bibliography = null;
function loadBibliography() {
  if (_bibliography) return _bibliography;
  const bibPath = path.join(__dirname, 'bibliography.json');
  try {
    const raw = fs.readFileSync(bibPath, 'utf8');
    _bibliography = JSON.parse(raw);
    console.log('[coordinate-drawer] bibliography loaded:',
      Object.keys(_bibliography.entries || {}).length, 'entries from', bibPath);
    return _bibliography;
  } catch (e) {
    console.error('[coordinate-drawer] bibliography load failed:', e.message);
    console.error('[coordinate-drawer] expected at:', bibPath);
    return null;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Reference resolution
   
   Given chip + voice + coordinates, return the bibliography entry IDs that
   should be available to the Oracle.
   ────────────────────────────────────────────────────────────────────────── */
function resolveReferences(bibliography, chip, voice, coordinates) {
  if (!bibliography || !bibliography.entries) return [];
  const key = chip + '_' + voice;
  const defaults = (bibliography.voice_chip_default_refs || {})[key] || [];
  const refs = [...defaults];
  
  /* Cycle-specific augmentation for Body chip */
  if (chip === 'body' && coordinates && coordinates.cyclePhase) {
    const systemsRefs = (bibliography.claim_to_entries || {})['systems_cycle_affects'] || [];
    systemsRefs.forEach(r => { if (!refs.includes(r)) refs.push(r); });
  }
  
  /* Pythagorean lineage for master number days */
  if (chip === 'time' && coordinates && coordinates.isMasterDay) {
    const lineageRefs = (bibliography.claim_to_entries || {})['pythagorean_lineage'] || [];
    lineageRefs.forEach(r => { if (!refs.includes(r)) refs.push(r); });
  }
  
  /* Maya astronomy depth for GAP days */
  if (chip === 'symbol' && coordinates && coordinates.isGAP) {
    const mayaRefs = (bibliography.claim_to_entries || {})['maya_astronomy'] || [];
    mayaRefs.forEach(r => { if (!refs.includes(r)) refs.push(r); });
  }
  
  return refs.filter(r => bibliography.entries[r]);
}

/* ──────────────────────────────────────────────────────────────────────────
   Voice instructions and chip role descriptions
   ────────────────────────────────────────────────────────────────────────── */
const VOICE_INSTRUCTIONS = {
  tradition: `Speak in the TRADITION voice. This is the symbolic-archetypal register.
You draw on Pythagorean numerology, Mayan/Dreamspell calendrics, lunar wisdom across
contemplative traditions, psychological astrology, and contemporary women's-health
practitioner literature. The day is read symbolically as a quality, an invitation, a
season. Practitioner literature (Hill 2019, Pope & Wurlitzer 2017, Greene 1976, Tarnas
2006) is cited authentically when symbolic claims are made. Maya/Dreamspell references
ALWAYS clearly distinguish Argüelles 1987 Dreamspell from the living K'iche' tzolk'in
(Tedlock 1992). Tone: reflective, layered, evocative without being mystical-hype. Never
overclaim. Never use phrases like "the universe wants", "manifest", "vibration", or
"energy" as physical claims.`,

  science: `Speak in the SCIENCE voice. This is the empirically-grounded register.
You draw on peer-reviewed cognitive neuroscience (Bremer 2022, Walker 2017, Barrett
2017, Clark 2016), affective neuroscience (Craig 2002, Porges 2011), circadian biology
(Cajochen 2013, Cajochen & Schmidt 2024), psychoneuroimmunology (Bower & Kuhlman 2023,
Mengelkoch 2023), psychoneuroendocrinology (Klusmann 2022, 2023), pain neuroscience
(Riley 1999, Morales-Lalaguna 2025), sleep medicine (Baker & Lee 2023), and clinical
psychology (Lange 2024 on PMDD/PMS). You are HONEST about what is established, what is
suggestive, what is null. When a high-quality null exists you CITE IT (Jang 2025 on
cycle/cognition is the model case: the cycle does not measurably alter cognitive
performance on standardised tasks, BUT it modulates the systems within which cognition
operates - HPA reactivity, sleep architecture, pain perception, mood, inflammation -
all of which are documented). For astrology and symbolic frames you cite Carlson 1985
Nature and Hartmann 2006 as honest counterweights. Tone: precise, calibrated, with
effect-size language where available, never wellness-overclaim. Symbolic frameworks are
clearly labelled as contemplative-anchor rather than predictive mechanism.`,

  everyday: `Speak in the EVERYDAY voice. This is the plain-speech register. No jargon
from either side. Same content as the other voices, named in language a smart friend
would use over coffee. Cite occasionally and only where it adds weight; you can also
simply say "the research suggests" or "the practitioner tradition holds" without a full
citation. Tone: warm, direct, practical. Never patronising. Never hedging or wishy-washy.
The reader is a sophisticated adult who wants to know what today is for and what to
notice.`
};

const CHIP_ROLES = {
  time: `The TIME chip is about TODAY'S NUMEROLOGICAL/CYCLICAL SIGNATURE - the quality
of attention this specific day asks for. Personal Day numerology is the primary input.
If today is a master number day (11, 22, 33, 44) flag that with its specific quality.`,

  lunar: `The LUNAR chip is about WHERE WE ARE IN THE LUNAR CYCLE. Moon phase, days
since new moon, proximity to full or new moon. CDP-specific concepts: Black Moon (2
days before new moon, a tricky preparatory window) and Shiva Moon (2 days after new
moon, a blissful settling window) are part of the lunar lexicon when relevant.`,

  symbol: `The SYMBOL chip is about TODAY'S DREAMSPELL KIN - the symbolic-archetypal
day-quality from Argüelles 1987. Tone (1-13) names the developmental position in a
13-day wavespell. Seal (the named archetype like Red Skywalker, White Wind, Blue Hand)
carries the archetypal quality. Galactic Activation Portals (GAP days, 52 canonical
entries) deserve specific note when present.`,

  body: `The BODY chip is about WHAT THE BODY IS DOING TODAY and how to read it as a
compass. Interoception is the empirical backbone. If cycle data is available, hormonal
phase is the primary input AND is treated honestly: the cycle modulates the systems
within which cognition operates (HPA, sleep, pain, mood, inflammation) even when
cognitive performance on objective tasks does not measurably shift (Jang 2025). The
four-seasons framing (inner winter/spring/summer/autumn) is practitioner literature
(Hill 2019, Pope & Wurlitzer 2017) and labelled as such.`
};

/* ──────────────────────────────────────────────────────────────────────────
   Build the system prompt
   ────────────────────────────────────────────────────────────────────────── */
function buildSystemPrompt(chip, voice, coordinates, userProfile, references, bibliography) {
  const voiceInstruction = VOICE_INSTRUCTIONS[voice] || VOICE_INSTRUCTIONS.tradition;
  const chipRole = CHIP_ROLES[chip] || CHIP_ROLES.time;
  
  const refsBlock = references.map(refId => {
    const e = bibliography.entries[refId];
    if (!e) return '';
    const authors = Array.isArray(e.authors) ? e.authors.join('; ') : (e.authors || '');
    const where = e.journal || e.publisher || '';
    return `  ${refId}: ${authors} (${e.year}). ${e.title}. ${where}. ${e.note || ''}`;
  }).filter(Boolean).join('\n');
  
  const coordsLines = [];
  if (coordinates.pd) coordsLines.push(`Personal Day: ${coordinates.pd}`);
  if (coordinates.ud) coordsLines.push(`Universal Day: ${coordinates.ud}`);
  if (coordinates.personalYear) coordsLines.push(`Personal Year: ${coordinates.personalYear}`);
  if (coordinates.moonPhase) coordsLines.push(`Moon phase: ${coordinates.moonPhase}` + (coordinates.moonAge ? ` (day ${coordinates.moonAge} of cycle)` : ''));
  if (coordinates.kinTone && coordinates.kinSeal) coordsLines.push(`Dreamspell Kin: ${coordinates.kinTone} ${coordinates.kinSeal}` + (coordinates.kinNumber ? ` (Kin ${coordinates.kinNumber})` : ''));
  if (coordinates.isGAP) coordsLines.push('Galactic Activation Portal day');
  if (coordinates.isMasterDay) coordsLines.push('Master number day (carries amplified quality)');
  if (coordinates.cyclePhase) coordsLines.push(`Hormonal phase: ${coordinates.cyclePhase}`);
  
  const profileLines = [];
  if (userProfile && userProfile.firstName) profileLines.push(`Reader's name: ${userProfile.firstName}`);
  if (userProfile && userProfile.lifePath) profileLines.push(`Reader's Life Path: ${userProfile.lifePath}`);
  
  return `You are composing the ${chip.toUpperCase()} drawer for the Cosmic Daily Planner
Compass surface. CDP synthesises Pythagorean numerology, Western psychological astrology,
Mayan/Dreamspell calendrics, and lunar cycles into a daily personalised reading. The
central premise is "Two Telescopes": ancient contemplative traditions and modern
neuroscience are not competing explanations - they point at the same coordinates from
different epistemic positions.

${voiceInstruction}

${chipRole}

TODAY'S COORDINATES:
${coordsLines.join('\n')}

READER CONTEXT:
${profileLines.join('\n') || '(no profile-specific data provided)'}

AVAILABLE REFERENCES (cite by id using <span class="v11-cite" data-ref="REF_ID">Display Text</span>):
${refsBlock}

OUTPUT RULES:
- Output STRICTLY a single JSON object with exactly these keys: title, body_html.
- title: 4-9 words. Names the coordinate concretely. No quotes inside the title.
- body_html: 100-160 words of prose in valid HTML. Use <p> tags for paragraphs. Wrap
  citation markers as <span class="v11-cite" data-ref="ref-id">Author Year</span>.
  Use 2-4 distinct citations. Cite only refs from the AVAILABLE REFERENCES list above.
- Voice register MUST match the voice instruction above.
- No em-dashes (U+2014) or en-dashes (U+2013) anywhere - use commas, colons, or
  restructure the sentence.
- No exclamation marks anywhere.
- No "manifest", "vibration", "energy field", "the universe wants you", "evidence-based"
  as a marketing word.
- If the topic is the menstrual cycle in the Science voice, you MUST be honest about
  what the empirical literature does and does not show. The cycle modulates many
  systems (HPA, sleep, pain, mood, inflammation) but Jang 2025 found no robust effect
  on cognitive performance tasks specifically - that nuance is required.
- If the topic involves astrology in the Science voice, you MUST acknowledge the
  sceptical literature (Carlson 1985 Nature, Hartmann 2006) appropriately.

OUTPUT FORMAT (JSON only, no preamble, no markdown fences):
{"title":"...","body_html":"<p>...</p>"}`;
}

/* ──────────────────────────────────────────────────────────────────────────
   Citation extraction
   ────────────────────────────────────────────────────────────────────────── */
function extractCitations(bodyHtml, bibliography) {
  const cites = [];
  if (!bodyHtml || !bibliography) return cites;
  const re = /<span\s+class="v11-cite"\s+data-ref="([^"]+)"[^>]*>([^<]+)<\/span>/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(bodyHtml)) !== null) {
    const refId = m[1];
    if (seen.has(refId)) continue;
    seen.add(refId);
    const e = bibliography.entries[refId];
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

/* ──────────────────────────────────────────────────────────────────────────
   Sanitiser
   ────────────────────────────────────────────────────────────────────────── */
function sanitiseHtml(s) {
  if (!s) return '';
  let out = s.replace(/\u2014/g, ', ').replace(/\u2013/g, ', ');
  out = out.replace(/!/g, '.');
  out = out.replace(/,\s*,/g, ',');
  out = out.replace(/,\s*\./g, '.');
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
   Response cache (in-memory, TTL 1 hour, soft cap 500 entries)
   ────────────────────────────────────────────────────────────────────────── */
const _drawerCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function makeCacheKey(chip, voice, coordinates, userProfile) {
  const c = coordinates || {};
  const p = userProfile || {};
  return [
    chip, voice,
    c.pd || '', c.moonPhase || '', c.kinTone || '', c.kinSeal || '',
    c.cyclePhase || '', c.isGAP ? '1' : '0', c.isMasterDay ? '1' : '0',
    (p.firstName || '').slice(0, 16)
  ].join('|');
}

function getCached(key) {
  const e = _drawerCache.get(key);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_TTL_MS) {
    _drawerCache.delete(key);
    return null;
  }
  return e.payload;
}

function setCached(key, payload) {
  _drawerCache.set(key, { t: Date.now(), payload });
  if (_drawerCache.size > 500) {
    const oldest = [..._drawerCache.entries()].sort((a, b) => a[1].t - b[1].t)[0];
    if (oldest) _drawerCache.delete(oldest[0]);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Fallback content (when Anthropic call fails or unavailable)
   ────────────────────────────────────────────────────────────────────────── */
function fallbackDrawer(chip, voice, coordinates, bibliography) {
  const c = coordinates || {};
  const cite = function(refId, text) {
    if (!bibliography || !bibliography.entries || !bibliography.entries[refId]) return text;
    return `<span class="v11-cite" data-ref="${refId}">${text}</span>`;
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
        body_html: '<p>The Dreamspell synthesis is ' + cite('arguelles-1987', 'Arguelles 1987') + ', distinct from the living K\'iche\' tzolk\'in documented by ' + cite('tedlock-1992', 'Tedlock 1992') + '. Read symbolically, not as prediction.</p>'
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
          ? '<p>Hormonal phase: ' + c.cyclePhase + '. Across contemplative women\'s-health practitioner literature (' + cite('hill-2019', 'Hill 2019') + ', ' + cite('pope-wurlitzer-2017', 'Pope and Wurlitzer 2017') + '), each phase carries its own quality of energy, attention, and relational sensitivity.</p>'
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

/* ──────────────────────────────────────────────────────────────────────────
   CORS preflight (some Netlify/Railway setups need explicit OPTIONS handler)
   ────────────────────────────────────────────────────────────────────────── */
function applyCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/* ──────────────────────────────────────────────────────────────────────────
   Handler
   ────────────────────────────────────────────────────────────────────────── */
async function handleCoordinateDrawer(req, res) {
  applyCorsHeaders(res);
  const t0 = Date.now();
  try {
    const body = req.body || {};
    const chip = String(body.chip || '').toLowerCase();
    const voice = String(body.voice || 'tradition').toLowerCase();
    const coordinates = body.coordinates || {};
    const userProfile = body.userProfile || {};
    
    const VALID_CHIPS = ['time', 'lunar', 'symbol', 'body'];
    const VALID_VOICES = ['tradition', 'science', 'everyday'];
    if (!VALID_CHIPS.includes(chip)) {
      return res.status(400).json({ error: 'invalid chip', valid: VALID_CHIPS });
    }
    if (!VALID_VOICES.includes(voice)) {
      return res.status(400).json({ error: 'invalid voice', valid: VALID_VOICES });
    }
    
    const bibliography = loadBibliography();
    if (!bibliography) {
      return res.status(500).json({ error: 'bibliography unavailable' });
    }
    
    const cacheKey = makeCacheKey(chip, voice, coordinates, userProfile);
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true, ms: Date.now() - t0 });
    }
    
    const refIds = resolveReferences(bibliography, chip, voice, coordinates);
    const anthropic = getAnthropic();
    
    let payload;
    
    if (!anthropic) {
      const fb = fallbackDrawer(chip, voice, coordinates, bibliography);
      const citations = extractCitations(fb.body_html, bibliography);
      payload = {
        title: fb.title,
        body_html: fb.body_html,
        citations,
        voice, chip,
        generated_at: new Date().toISOString(),
        source: 'fallback_no_anthropic'
      };
    } else {
      const systemPrompt = buildSystemPrompt(chip, voice, coordinates, userProfile, refIds, bibliography);
      
      let result;
      try {
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{
            role: 'user',
            content: 'Compose the drawer JSON for this chip and these coordinates. Output JSON only.'
          }]
        });
        
        let textBlock = (response.content || []).find(b => b.type === 'text');
        let raw = textBlock ? textBlock.text : '';
        raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
        
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (parseErr) {
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) {
            try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; }
          }
        }
        
        if (!parsed || !parsed.title || !parsed.body_html) {
          parsed = fallbackDrawer(chip, voice, coordinates, bibliography);
          result = parsed;
        } else {
          parsed.title = sanitiseHtml(parsed.title);
          parsed.body_html = sanitiseHtml(parsed.body_html);
          result = parsed;
        }
      } catch (apiErr) {
        console.error('[coordinate-drawer] Anthropic call failed:', apiErr.message);
        result = fallbackDrawer(chip, voice, coordinates, bibliography);
      }
      
      const citations = extractCitations(result.body_html, bibliography);
      payload = {
        title: result.title,
        body_html: result.body_html,
        citations,
        voice, chip,
        coordinates_echo: coordinates,
        generated_at: new Date().toISOString(),
        source: result.source || 'oracle'
      };
    }
    
    setCached(cacheKey, payload);
    return res.json({ ...payload, cached: false, ms: Date.now() - t0 });
  } catch (e) {
    console.error('[coordinate-drawer] handler error:', e.stack || e.message);
    applyCorsHeaders(res);
    return res.status(500).json({ error: 'internal error', detail: e.message });
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Export the registration function
   
   Usage in server.js:
       require('./coordinate-drawer-route')(app);
   ────────────────────────────────────────────────────────────────────────── */
module.exports = function registerRoute(app) {
  if (!app || typeof app.post !== 'function') {
    throw new Error('coordinate-drawer-route: requires Express app');
  }
  
  /* Warm-load at boot so any issues surface immediately, not on first request */
  loadBibliography();
  getAnthropic();
  
  /* CORS preflight */
  app.options('/api/compass/coordinate-drawer', (req, res) => {
    applyCorsHeaders(res);
    res.status(204).end();
  });
  
  app.post('/api/compass/coordinate-drawer', handleCoordinateDrawer);
  
  console.log('[coordinate-drawer] registered: POST /api/compass/coordinate-drawer');
};

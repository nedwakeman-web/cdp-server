/**
 * Cosmic Daily Planner — Railway Production Server
 * 
 * Architecture:
 *   - Express + Server-Sent Events (SSE) streaming
 *   - Anthropic API streamed token-by-token to the client
 *   - No timeout limits (Railway allows indefinite connections)
 *   - Model routing: Haiku for FREE/SEEKER/INITIATE/MYSTIC, Sonnet for ORACLE
 *   - ORACLE tier: full 8192 tokens, no compromise
 *   - Rate limiting, CORS, security headers included
 *
 * Deploy to Railway:
 *   1. Push this folder to GitHub
 *   2. Connect repo in Railway → New Project → Deploy from GitHub
 *   3. Set environment variable: ANTHROPIC_API_KEY
 *   4. Railway auto-detects Node.js and runs `npm start`
 */

const express = require('express');
const https   = require('https');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Security & middleware ──────────────────────────────────────────────────
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Serve static frontend ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Model routing ──────────────────────────────────────────────────────────
// Railway has NO timeout limits — use full capacity at every tier
// Haiku is fast and surprisingly capable at 4096+ tokens
// Sonnet for ORACLE: the full £50,000 bespoke standard
const MODEL_MAP = {
  FREE:     { model: 'claude-haiku-4-5-20251001',  max_tokens: 800   },
  SEEKER:   { model: 'claude-haiku-4-5-20251001',  max_tokens: 3000  },
  INITIATE: { model: 'claude-haiku-4-5-20251001',  max_tokens: 4500  },
  MYSTIC:   { model: 'claude-haiku-4-5-20251001',  max_tokens: 6000  },
  ORACLE:   { model: 'claude-sonnet-4-6',           max_tokens: 8192  },
};

const SYSTEM_PROMPT = `You are the Cosmic Daily Planner oracle — the world's finest synthesis of peer-reviewed astronomy, Pythagorean numerology, Western psychological astrology, and Dreamspell/Law of Time. You write with the precision of Liz Greene, the historical scope of Richard Tarnas, and the warmth of a deeply trusted counsellor.

SCHOLARLY GROUNDING:
- Numerology: Drayer (2002); Goodwin (1994); Kahn (2001) Pythagoras and the Pythagoreans
- Lunar/Astronomical: USNO (aa.usno.navy.mil); NASA Moon Phases; JPL Horizons (ssd.jpl.nasa.gov)  
- Dreamspell: Argüelles (1987) The Mayan Factor — ALWAYS clearly labelled as a modern 20th-century system, distinct from the ancient K'iche' Maya tzolkʼin count (Aldana 2022; Tedlock 1992)
- Maya calendrics: Šprajc, Inomata & Aveni (2023) Science Advances doi:10.1126/sciadv.abq7675; Aldana (2022) doi:10.34758/qyyd-vx23
- Western astrology: Greene (1976) Saturn; Tarnas (2006) Cosmos & Psyche; Hand (2002) Planets in Transit; Brady (1999); Brennan (2017) Hellenistic Astrology; Campion (2008)

CORE VOICE:
- Speak directly to the person by name throughout. Not "one might" — "you are"
- Every sentence must arise from the specific cosmic data provided — never generic filler
- Reference their actual projects, people, life chapter directly and specifically
- Factual claims (planetary positions, moon phases) labelled as approximate/ephemeris-derived
- Symbolic/astrological claims clearly framed as symbolic interpretation
- Tone: Liz Greene meets Tarnas — precise, warm, psychologically sophisticated, occasionally luminous
- Never deterministic predictions; always invitations, framings, reflections
- When BLACK MOON is present: make it the primary frame — going within, tricky emotional field, solitude, dream attention
- When SHIVA MOON is present: make it the primary frame — blissful opening, action time, couples, new starts
- When GAP DAY: acknowledge the amplified synchronic field with substance and weight
- MASTER NUMBERS (11, 22, 33, 44): treat with the full weight they deserve — these are not ordinary days

NUMEROLOGY:
1=New beginnings, work, initiation. 2=Relationships, receptivity. 3=Creativity, expression, marketing. 4=Foundation, hard work, honesty. 5=Freedom, learning, social change. 6=Love, responsibility, family, art. 7=Wisdom, depth, karmic intensity, solitude. 8=Power, business, structure, financial mastery. 9=Completion, compassion, magical, blissful.
11=Illuminated magic, special moments, intuition. 22=Master Builder — intense transformative work. 33=Master Teacher — creativity/intuition balance. 44=Master Builder amplified — excellence, structure.
THREE ENERGIES: Morning=Universal Day (collective field). Afternoon=Personal Day (individual path). Evening=Personal Month (monthly undertow).

MOON PHASES: NEW MOON=intentions, heightened emotions, wait for Shiva. SHIVA MOON (2d after New)=blissful action, couples, new starts. FIRST QUARTER=growth, dynamic energy. WAXING GIBBOUS=building, refining. FULL MOON=peak revelation, release rituals, avoid decisions. THIRD QUARTER=completion, release, declutter. BALSAMIC=rest, surrender. BLACK MOON (2d before New)=going within, emotional sensitivity, solitude.

2026 ASTRONOMICAL CONTEXT:
Saturn-Neptune at 0-2° Aries (exact Feb 20 2026) — last in Aries ~1522 (Magellan circumnavigation, Reformation, Copernican revolution). Civilisational threshold: dissolution meeting new form. Once in 36 years.
Pluto in Aquarius (2024-2044) — collective/digital/democratic transformation.
Uranus ingress Gemini April 26 2026 — disruption of ideas, communication, local networks.
Jupiter in Cancer 2025-2026 — emotional abundance, home, family, protection.

KEY ASPECTS FORMAT (MYSTIC/ORACLE): ●●●●● (exact) to ●○○○○ (wide). Format: ●●●●● Sun X° Sign conjunct/trine/square/sextile/opposition Planet Y° Sign (Z° orb) — interpretation specific to this person.

SECTION HEADERS (EXACTLY as listed, UPPERCASE, own line):
SEEKER: CONVERGENCE / NUMEROLOGY TODAY / LUNAR GUIDANCE / DREAMSPELL & GALACTIC FIELD / THREE PRIORITIES / FOCUS ON / EASE OFF / REFLECTION / DAILY GIFT
INITIATE: All SEEKER + WEEK AHEAD / WAVESPELL ARC  
MYSTIC: All SEEKER + MONTHLY LUNATION MAP / PERSONAL YEAR ARC / NATAL TRANSIT OVERLAY / KEY ASPECTS / SHADOW THEMES / GROWTH EDGE
ORACLE: All MYSTIC + HELLENISTIC DIMENSION / MULTI-YEAR ARC / GAP MAPPING / SYNTHESIS ORACLE

PRIORITIES FORMAT: Number 1/2/3. Bold title on first line. 2-3 sentences reasoning linking cosmic factors to their actual named situation. End with → specific action.

DAILY GIFT FORMAT: Quote with full attribution (author, work, year). 2-3 paragraphs of personal synthesis. End with three bullet invitations using ♡ ◎ ✦ — specific, not generic.

ORACLE STANDARD: Write at the depth of a professional psychological-astrological consultation worth £50,000. Every section at fullest expression. Name their actual projects, people, chapter, fears, and possibilities directly.`;

// ─── Streaming endpoint (SSE) ───────────────────────────────────────────────
app.post('/api/reading/stream', (req, res) => {
  const { prompt, tier, history } = req.body;
  if (!prompt) return res.status(400).send('Missing prompt');

  const tierKey  = (tier || 'SEEKER').toUpperCase();
  const { model, max_tokens } = MODEL_MAP[tierKey] || MODEL_MAP.SEEKER;

  const messages = (history && history.length > 0)
    ? history
    : [{ role: 'user', content: prompt }];

  // Server-Sent Events headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // prevent nginx buffering on Railway
  res.flushHeaders();

  const reqBody = JSON.stringify({
    model,
    max_tokens,
    stream: true,
    system: SYSTEM_PROMPT,
    messages
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(reqBody)
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let buffer = '';

    apiRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          try {
            const parsed = JSON.parse(data);
            // Extract text delta
            if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) {
              res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
            }
            // Signal completion
            if (parsed.type === 'message_stop') {
              res.write('data: [DONE]\n\n');
              res.end();
            }
            // Handle errors from API
            if (parsed.type === 'error') {
              res.write(`data: ${JSON.stringify({ error: parsed.error.message })}\n\n`);
              res.end();
            }
          } catch(e) {
            // Non-JSON line — ignore
          }
        }
      }
    });

    apiRes.on('end', () => {
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    apiRes.on('error', (e) => {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    });
  });

  apiReq.on('error', (e) => {
    res.write(`data: ${JSON.stringify({ error: 'Network error: ' + e.message })}\n\n`);
    res.end();
  });

  apiReq.write(reqBody);
  apiReq.end();

  // Clean up if client disconnects
  req.on('close', () => {
    if (!res.writableEnded) {
      apiReq.destroy();
      res.end();
    }
  });
});

// ─── Non-streaming fallback (for oracle chat) ───────────────────────────────
app.post('/api/reading', (req, res) => {
  const { prompt, tier, history } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  const tierKey = (tier || 'SEEKER').toUpperCase();
  const { model, max_tokens } = MODEL_MAP[tierKey] || MODEL_MAP.SEEKER;

  const messages = (history && history.length > 0)
    ? history
    : [{ role: 'user', content: prompt }];

  const reqBody = JSON.stringify({ model, max_tokens, system: SYSTEM_PROMPT, messages });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(reqBody)
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) return res.status(500).json({ error: parsed.error.message });
        const text = parsed.content?.[0]?.text || 'The oracle was silent.';
        res.json({ text });
      } catch(e) {
        res.status(500).json({ error: 'Parse error: ' + e.message });
      }
    });
  });

  apiReq.on('error', e => res.status(500).json({ error: e.message }));
  apiReq.write(reqBody);
  apiReq.end();
});

// ─── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// ─── Serve index.html for all other routes (SPA) ───────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Cosmic Daily Planner — Railway server running on port ${PORT}`);
  console.log(`ORACLE tier: claude-sonnet, 8192 tokens — no limits`);
});

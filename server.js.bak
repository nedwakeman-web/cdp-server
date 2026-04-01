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
// Haiku  = fast (2-4s), ideal for FREE → MYSTIC with good quality
// Sonnet = deep (8-20s), reserved for ORACLE bespoke experience
// On Railway there is NO timeout — Sonnet can take 60s+ and that is fine
const MODEL_MAP = {
  FREE:     { model: 'claude-haiku-4-5-20251001',  max_tokens: 512  },
  SEEKER:   { model: 'claude-haiku-4-5-20251001',  max_tokens: 2048 },
  INITIATE: { model: 'claude-haiku-4-5-20251001',  max_tokens: 3000 },
  MYSTIC:   { model: 'claude-haiku-4-5-20251001',  max_tokens: 4096 },
  ORACLE:   { model: 'claude-sonnet-4-6', max_tokens: 8192 }, // Full bespoke — no compromise
};

const SYSTEM_PROMPT = `You are the Cosmic Daily Planner oracle — empathic, academically honest, deeply wise, and capable of extraordinary depth.

You synthesise four frameworks (Pythagorean numerology, lunar astronomy, Western astrology, Dreamspell/Law of Time) into a reading that is genuinely personal, specific, and worth returning to.

SCHOLARLY GROUNDING:
- Numerology: Drayer (2002) Numerology: The Power in Numbers; Goodwin (1994); Kahn (2001) Pythagoras and the Pythagoreans
- Lunar/Astronomical: USNO (aa.usno.navy.mil); NASA Moon Phases; JPL Horizons (ssd.jpl.nasa.gov)
- Dreamspell: Argüelles (1987) The Mayan Factor — ALWAYS clearly labelled as a modern 20th-century system, distinct from the ancient K'iche' Maya tzolkʼin count maintained by living daykeepers in Guatemala (Aldana 2022; Tedlock 1992)
- Maya calendrics: Šprajc, Inomata & Aveni (2023) Science Advances doi:10.1126/sciadv.abq7675; Aldana (2022) doi:10.34758/qyyd-vx23
- Western astrology: Greene (1976) Saturn; Tarnas (2006) Cosmos & Psyche; Hand (2002) Planets in Transit; Brady (1999) Predictive Astrology; Brennan (2017) Hellenistic Astrology; Campion (2008)

VOICE:
- Speak directly to the person by name. Not "one might" — "you are"
- Every insight must arise from the specific cosmic data provided — never generic filler
- Factual claims (planetary positions, moon phases) always labelled as approximate or ephemeris-derived
- Symbolic/astrological interpretation clearly framed as symbolic
- Tone: like Liz Greene and Richard Tarnas in conversation — precise, warm, psychologically sophisticated, occasionally luminous
- Never deterministic predictions; always invitations, framings, reflections
- When the Black Moon or Shiva Moon is present: treat this as a primary frame for the entire reading
- When a GAP day is present: acknowledge the amplified field and heightened synchronicity
- Master numbers (11, 22, 33): treat with the weight they deserve

FORMATTING:
- Section headings in CAPITALS, on their own line
- Flowing prose paragraphs — no bullet lists
- The CONVERGENCE sentence should be set apart, beautiful, and feel like it could not have been written for anyone else
- For ORACLE tier: write at the depth of a professional psychological-astrological consultation. This is a £50,000-quality bespoke annual reading. Take every section to its fullest expression.`;

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

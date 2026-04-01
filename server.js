const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Tier token limits ──────────────────────────────────────
const TIER_CONFIG = {
  free:     { model: 'claude-haiku-4-5-20251001', max_tokens: 400 },
  seeker:   { model: 'claude-haiku-4-5-20251001', max_tokens: 900 },
  initiate: { model: 'claude-sonnet-4-6',         max_tokens: 1400 },
  mystic:   { model: 'claude-sonnet-4-6',         max_tokens: 2200 },
  oracle:   { model: 'claude-opus-4-6',            max_tokens: 4000 }
};

function anthropicRequest(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON: ' + data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Daily Card endpoint ────────────────────────────────────
app.post('/api/daily_message', async (req, res) => {
  const ctx = req.body?.context || {};
  const tier = ctx.tier || 'free';
  const cfg = TIER_CONFIG[tier] || TIER_CONFIG.free;

  const systemPrompt = `You are the voice of Cosmic Daily Planner — calm, grounded, and elegantly precise.
Synthesise the four frameworks (numerology, moon phase, Dreamspell/Law of Time, Western astrology) into a 
single coherent daily reading. Be specific, not generic. Voice: warm, scholarly, non-predictive.
Label Dreamspell as a modern system (Argüelles 1987), distinct from ancient Maya doctrine.
${tier === 'free' ? 'Keep it to 3-4 sentences. Feel like a lucky stone in the pocket.' : ''}
${tier === 'seeker' ? 'Include morning/afternoon/evening windows. Top 3 priorities. ~200 words.' : ''}
Never use markdown headers. Plain flowing prose only.`;

  const userMsg = `Date: ${ctx.date}
Universal Day: ${ctx.universalDay} (${ctx.numerologyMeaning})
Moon: ${ctx.moonPhase}
Kin ${ctx.kin}: ${ctx.kinName}${ctx.isPortal ? ' — Galactic Portal' : ''}
Seal power: ${ctx.sealPower} · Tone: ${ctx.toneKeyword}
Month energy: ${ctx.monthEnergy} · Year energy: ${ctx.yearEnergy}
${ctx.personalYear ? `Personal Year: ${ctx.personalYear} · Life Path: ${ctx.lifePath} · Sun: ${ctx.sunSign}` : ''}`;

  try {
    const response = await anthropicRequest({
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }]
    });
    res.json({ content: response.content, tier });
  } catch (err) {
    console.error('API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Full reading endpoint ──────────────────────────────────
app.post('/api/reading', async (req, res) => {
  // Your existing reading.js logic here (self-contained prompts per tier)
  res.json({ message: 'Reading endpoint active' });
});

// Catch-all → SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`CDP running on port ${PORT}`));

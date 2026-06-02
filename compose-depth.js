'use strict';

/**
 * CDP compose-depth route.
 *
 * POST /api/compose/depth is the summoned-depth endpoint the frontend
 * ApiOrchestrator posts to. It composes a genuine, lens-distinct reflection
 * over Claude Sonnet 4.6, drawing on the verified day coordinates for the
 * Tradition lens and on the continuity of the person's other held threads.
 * When this endpoint is absent or errors, the frontend falls back to its local
 * placeholder, so a failure here is degraded, never broken.
 *
 * Coordinates wired this pass: the corrected Dreamspell Kin and the Universal
 * Day numerology, both verified by the coordinates tests. The lunar windows and
 * the Galactic Activation Portal flag are not stated until their authoritative
 * sources are wired, and the Tradition prompt is told to state only what is
 * provided, so no fabricated coordinate can reach a reading.
 *
 * CommonJS, to drop into the existing cdp-server. Mount with register(app), or
 * use the exported handler directly.
 */

const coordinates = require('./coordinates');
const { buildSystemPrompt } = require('./lenses');

const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MAX_TOKENS = Number(process.env.CDP_DEPTH_MAX_TOKENS || 4000);
const VALID_LENSES = new Set(['tradition', 'science', 'everyday']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pre-format the verified coordinate lines for the Tradition lens. Only verified values are included. */
function traditionCoordinateLines(dateStr) {
  const lines = [];
  const u = coordinates.universalDay(dateStr);
  lines.push(
    'Universal Day number ' + u.value + (u.isMaster ? ' (a master number, preserved, symbolic).' : ' (symbolic).')
  );
  const k = coordinates.kinDescriptor(dateStr);
  lines.push('Dreamspell Kin: ' + k.full + '. Tone, seal, and Kin number are distinct naming systems (symbolic).');
  return lines;
}

/** Extract the joined text of all text blocks in an Anthropic messages response. */
function extractText(data) {
  if (!data || !Array.isArray(data.content)) return '';
  return data.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** Parse the model output into the Composed shape, defensively. */
function parseComposed(raw) {
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj.text === 'string' && obj.text.trim().length > 0) {
      return { text: obj.text.trim(), summary: typeof obj.summary === 'string' ? obj.summary.trim() : undefined };
    }
  } catch (e) {
    // The model did not return clean JSON. Use the whole reply as the reflection
    // rather than discard a real composition over a formatting miss.
  }
  return raw.trim().length > 0 ? { text: raw.trim() } : null;
}

async function handler(req, res) {
  const body = req.body || {};
  const lens = body.lens;
  const intention = body.intention || {};

  if (!VALID_LENSES.has(lens)) {
    return res.status(400).json({ error: 'lens must be one of tradition, science, everyday' });
  }
  if (!intention || typeof intention.text !== 'string' || intention.text.trim().length === 0) {
    return res.status(400).json({ error: 'intention.text is required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    // No key configured; tell the frontend to fall back rather than hang.
    return res.status(503).json({ error: 'composition is not configured' });
  }

  const dateStr = DATE_RE.test(body.dateStr) ? body.dateStr : new Date().toISOString().slice(0, 10);
  const coordLines = lens === 'tradition' ? traditionCoordinateLines(dateStr) : undefined;

  const system = buildSystemPrompt({
    lens,
    dateStr,
    coordinates: coordLines,
    continuity: Array.isArray(body.continuity) ? body.continuity : [],
    recentTouches: Array.isArray(body.recentTouches) ? body.recentTouches : [],
  });

  const anchorLine = intention.anchor && intention.anchor.label
    ? '\n\nIt points at a moment: ' + intention.anchor.label + (intention.anchor.date ? ' (' + intention.anchor.date + ')' : '')
    : '';
  const userContent = 'The person is holding this and has reached for depth on it:\n\n' + intention.text.trim() + anchorLine;

  try {
    const upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: DEFAULT_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!upstream.ok) {
      return res.status(502).json({ error: 'composition upstream error', status: upstream.status });
    }

    const data = await upstream.json();
    const composed = parseComposed(extractText(data));
    if (!composed) {
      return res.status(502).json({ error: 'composition returned no text' });
    }
    return res.json(composed);
  } catch (e) {
    return res.status(502).json({ error: 'composition failed' });
  }
}

/** Mount the route on an Express app. */
function register(app) {
  app.post('/api/compose/depth', handler);
}

module.exports = { handler, register, traditionCoordinateLines, parseComposed, extractText };

/**
 * compose-depth.js
 *
 * The bounded, lens-disciplined Compass reflection for Cosmic Daily Planner.
 * Mounts POST /api/compose/depth, the endpoint the Vessel surface calls when a
 * person types a line into the compass.
 *
 * Design decision that matters: this module depends on nothing but Node's
 * built-in https. It does not require coordinates.js, lenses.js, or any other
 * CDP module. That is deliberate. The previous registration sat inside a
 * try/catch in server.js, so when an earlier compose-depth required a module
 * that was not in the repo, the require threw, the catch swallowed it, and the
 * route silently never mounted, which is what produced "Cannot POST
 * /api/compose/depth". With zero external requires, the load cannot fail, so
 * the route always mounts. Everything the reflection needs arrives in the
 * request body or is computed here.
 *
 * Contract, matched to the frontend ApiOrchestrator:
 *   Request  { lens, intention:{text, anchor?}, dateStr, continuity?, recentTouches? }
 *   Response { text, summary }
 * On any failure (no key, upstream error, unparseable output) it replies with a
 * non-2xx status so the surface shows its honest local fallback rather than a
 * broken reading.
 *
 * House style: no em dashes, no en dashes, no exclamation marks, in code and in
 * every string a reader could see.
 */

'use strict';

const https = require('https');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2400;
const ANTHROPIC_VERSION = '2023-06-01';

/* ---- voice doctrine -------------------------------------------------------

   The shared frame, then one addendum per voice. The three voices are distinct
   registers, not points on a slider. The reflection is bounded: it orients
   around the one thing the person is holding, it does not deliver a full
   reading, and it leaves the choosing to them. */

const BASE = [
  'You are the Oracle of Cosmic Daily Planner. A person has named one thing that is alive for them right now, and you offer a short, grounded reflection that helps them meet their day with more clarity and more capacity to choose well.',
  '',
  'The premise of the work is the two telescopes: the oldest traditions and current science are not competing explanations, they point at the same coordinates from two directions. You hold both without forcing either.',
  '',
  'How you speak, in every voice:',
  'You are a keel and a companion, not an authority over the person. You can name what you see, you can decline, and you can sit alongside. You do not prescribe, predict, or promise outcomes. The person is the source of their own authority, you bring the tools and they do the living.',
  'You label a symbolic claim as symbolic and an empirical claim as empirical. Where something is not known, you say so plainly rather than dressing a guess as knowledge.',
  'You write in clear, lived language. No AI-poetic filler, no naming the framework at the door, no therapist register, no hedged and apologetic delivery. You are warm and direct.',
  'You reflect what is alive without amplifying distress. You keep the focus on what matters and on the next honest step, not on the problem as a thing to dwell in.',
  'Keep it bounded: a few short paragraphs, four to six sentences each at most. Land on one quiet, usable thought, not a to-do list.'
].join('\n');

const VOICES = {
  tradition: [
    'Voice: Tradition.',
    'Speak in the symbolic and archetypal register that the wisdom traditions carry: image, pattern, and contemplative framing. Where you draw on the day signature (numerology, the Dreamspell day, the lunar phase, a transit), name it as symbolic language for a felt pattern, not as a force acting on the person. The symbol is a mirror the person reads, not a fate they receive.'
  ].join('\n'),
  science: [
    'Voice: Science.',
    'Speak in the register of cognition and mechanism: attention, prediction, interoception, salience, consolidation, the nervous system as it actually behaves. Ground what you say in how the mind works rather than in claims about the cosmos. Name a mechanism as a mechanism, and where the evidence is partial, say it is partial. Stay readable, not clinical.'
  ].join('\n'),
  everyday: [
    'Voice: Everyday.',
    'Speak in plain, practical language for a person who finds neither archetype nor neuroscience native. Translate the same underlying pattern into ordinary terms and one clear, doable next step. No jargon from either telescope, just a steady, human reflection.'
  ].join('\n')
};

function systemFor(lens) {
  const key = (lens === 'tradition' || lens === 'science' || lens === 'everyday') ? lens : 'everyday';
  return BASE + '\n\n' + VOICES[key] + '\n\n' +
    'Return ONLY a JSON object, with no preamble and no markdown fences, of the form ' +
    '{"text": "the reflection, paragraphs separated by a blank line", "summary": "one short present-tense line naming where this stands now"}. ' +
    'The summary is a single calm sentence, not a heading.';
}

/* ---- user message ---------------------------------------------------------- */

function buildUserMessage(body) {
  const intention = body && body.intention ? body.intention : {};
  const text = typeof intention.text === 'string' ? intention.text : '';
  const dateStr = typeof body.dateStr === 'string' ? body.dateStr : '';
  const parts = [];

  if (dateStr) parts.push('Today is ' + dateStr + '.');

  if (intention.anchor && typeof intention.anchor.label === 'string') {
    const when = intention.anchor.date ? (' (' + intention.anchor.date + ')') : '';
    parts.push('There is a moment they are oriented toward: ' + intention.anchor.label + when + '.');
  }

  const touches = Array.isArray(body.recentTouches) ? body.recentTouches : [];
  if (touches.length > 0) {
    const lines = touches
      .filter(function (t) { return t && typeof t.text === 'string' && t.text.trim().length > 0; })
      .slice(-8)
      .map(function (t) {
        const who = t.role === 'oracle' ? 'You said' : 'They said';
        return who + ': ' + t.text.trim();
      });
    if (lines.length > 0) {
      parts.push('Recent context from this person, oldest first:');
      parts.push(lines.join('\n'));
    }
  }

  parts.push('What is alive for them right now:');
  parts.push(text.trim().length > 0 ? text.trim() : '(They opened the compass without typing a line. Offer a brief, steadying orientation for the day.)');

  return parts.join('\n\n');
}

/* ---- anthropic call, non-streaming, self-contained ------------------------- */

function callAnthropic(system, user) {
  return new Promise(function (resolve, reject) {
    const payload = JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: system,
      messages: [{ role: 'user', content: user }]
    });

    const request = https.request({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, function (res) {
      let raw = '';
      res.on('data', function (d) { raw += d.toString(); });
      res.on('end', function () {
        if (res.statusCode !== 200) {
          const tag = res.statusCode === 401 ? 'invalid_api_key'
            : res.statusCode === 529 ? 'overloaded'
            : 'http_' + res.statusCode;
          reject(new Error(tag + ': ' + raw.slice(0, 160)));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          const block = Array.isArray(parsed.content) ? parsed.content.find(function (b) { return b.type === 'text'; }) : null;
          const out = block && typeof block.text === 'string' ? block.text : '';
          resolve(out);
        } catch (e) {
          reject(new Error('parse_error: ' + e.message));
        }
      });
    });

    request.on('error', function (e) { reject(e); });
    request.setTimeout(28000, function () { request.destroy(new Error('timeout')); });
    request.write(payload);
    request.end();
  });
}

/* ---- shape the model output into { text, summary } ------------------------- */

function shape(modelText) {
  const cleaned = String(modelText || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    const text = typeof obj.text === 'string' ? obj.text.trim() : '';
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    if (text.length > 0) return { text: text, summary: summary };
  } catch (e) {
    /* not JSON, fall through and use the prose as is */
  }
  return { text: cleaned, summary: '' };
}

/* ---- the route ------------------------------------------------------------- */

function register(app) {
  app.post('/api/compose/depth', async function (req, res) {
    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(503).json({ error: 'no_api_key' });
      return;
    }
    const body = req.body || {};
    const lens = body.lens;
    try {
      const system = systemFor(lens);
      const user = buildUserMessage(body);
      const modelText = await callAnthropic(system, user);
      const out = shape(modelText);
      if (!out.text || out.text.length === 0) {
        res.status(502).json({ error: 'empty_composition' });
        return;
      }
      res.json(out);
    } catch (e) {
      console.error('compose-depth error:', e && e.message ? e.message : e);
      res.status(502).json({ error: 'compose_failed' });
    }
  });
}

module.exports = { register: register };

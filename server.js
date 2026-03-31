import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['https://cosmicdailyplanner.com', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));

// ── Database ─────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
const db = new Database(process.env.DB_PATH || './cdp.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    birth_name TEXT,
    dob TEXT,
    location TEXT,
    tier TEXT DEFAULT 'free',
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    life_chapter TEXT,
    building TEXT,
    people TEXT,
    what_matters TEXT,
    need_to_hear TEXT,
    guidance_areas TEXT,
    pattern TEXT,
    intuition TEXT,
    living_well TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    date TEXT NOT NULL,
    tier TEXT NOT NULL,
    reading_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reading_id INTEGER REFERENCES readings(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_readings_user ON readings(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_messages_reading ON messages(reading_id);
`);

// ── Auth ──────────────────────────────────────────────────────────────────────
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '30d' });
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    req.userId = payload.sub;
    req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (!req.user) return res.status(401).json({ error: 'User not found' });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      req.userId = payload.sub;
      req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    } catch {}
  }
  next();
}

// ── Astronomy & Numerology (inline from reading-stream.mjs) ──────────────────
// Import the logic dynamically
let fullCosmic, lifePath, nameNum;
try {
  const logicModule = await import('./cosmic-logic.js');
  fullCosmic = logicModule.fullCosmic;
  lifePath = logicModule.lifePath;
  nameNum = logicModule.nameNum;
} catch(e) {
  console.warn('cosmic-logic.js not found — reading generation will be limited');
}

// ── Anthropic streaming helper ───────────────────────────────────────────────
async function* streamClaude(messages, system, model = 'claude-sonnet-4-6', maxTokens = 8000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens, stream: true,
      system, messages
    })
  });

  if (!res.ok) {
    const e = await res.json();
    throw new Error('Anthropic API error: ' + (e.error?.message || res.status));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return;
      try {
        const evt = JSON.parse(raw);
        if (evt.type === 'content_block_delta' && evt.delta?.text) {
          yield evt.delta.text;
        }
      } catch {}
    }
  }
}

async function callClaude(messages, system, model = 'claude-sonnet-4-6', maxTokens = 6000) {
  let text = '';
  for await (const chunk of streamClaude(messages, system, model, maxTokens)) {
    text += chunk;
  }
  return text;
}

// Clean JSON from Claude's response
function cleanJSON(raw) {
  const j0 = raw.indexOf('{'), j1 = raw.lastIndexOf('}');
  if (j0 === -1 || j1 <= j0) throw new Error('No JSON object in response');
  let s = raw.slice(j0, j1 + 1);
  s = s.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(s); }
  catch {
    s = s.replace(/\n/g, ' ').replace(/\r/g, '').replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(s);
  }
}

// ── Auth Routes ───────────────────────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const stmt = db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)');
    const result = stmt.run(email.toLowerCase(), hash, name || '');
    const token = signToken(result.lastInsertRowid);
    res.json({ token, user: { id: result.lastInsertRowid, email, name: name || '', tier: 'free' } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  db.prepare('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  const token = signToken(user.id);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, tier: user.tier } });
});

app.get('/auth/me', requireAuth, (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(req.userId);
  res.json({ user: req.user, profile });
});

// ── Profile Routes ────────────────────────────────────────────────────────────
app.put('/profile', requireAuth, (req, res) => {
  const { name, birth_name, dob, location, life_chapter, building, people,
          what_matters, need_to_hear, guidance_areas, pattern, intuition, living_well } = req.body;

  db.prepare('UPDATE users SET name=?, birth_name=?, dob=?, location=? WHERE id=?')
    .run(name, birth_name, dob, location, req.userId);

  const existing = db.prepare('SELECT id FROM profiles WHERE user_id=?').get(req.userId);
  if (existing) {
    db.prepare(`UPDATE profiles SET life_chapter=?,building=?,people=?,what_matters=?,need_to_hear=?,
      guidance_areas=?,pattern=?,intuition=?,living_well=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
      .run(life_chapter,building,people,what_matters,need_to_hear,guidance_areas,pattern,intuition,living_well,req.userId);
  } else {
    db.prepare(`INSERT INTO profiles (user_id,life_chapter,building,people,what_matters,need_to_hear,
      guidance_areas,pattern,intuition,living_well) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(req.userId,life_chapter,building,people,what_matters,need_to_hear,guidance_areas,pattern,intuition,living_well);
  }
  res.json({ ok: true });
});

// ── Reading History ───────────────────────────────────────────────────────────
app.get('/readings', requireAuth, (req, res) => {
  const readings = db.prepare('SELECT id, date, tier, created_at FROM readings WHERE user_id=? ORDER BY date DESC LIMIT 50')
    .all(req.userId);
  res.json({ readings });
});

app.get('/readings/:id', requireAuth, (req, res) => {
  const reading = db.prepare('SELECT * FROM readings WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!reading) return res.status(404).json({ error: 'Not found' });
  const messages = db.prepare('SELECT role, content FROM messages WHERE reading_id=? ORDER BY id').all(reading.id);
  res.json({ reading: { ...reading, reading_json: JSON.parse(reading.reading_json || '{}') }, messages });
});

// ── Main Reading Endpoint (streaming SSE) ────────────────────────────────────
app.post('/reading/stream', optionalAuth, async (req, res) => {
  const { date, profile, todayNote, tier = 'seeker' } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });

  // Tier gating
  const allowedTiers = { free: ['free'], seeker: ['free','seeker'], initiate: ['free','seeker','initiate'],
    mystic: ['free','seeker','initiate','mystic'], oracle: ['free','seeker','initiate','mystic','oracle'] };
  const userTier = req.user?.tier || 'free';
  if (!allowedTiers[userTier]?.includes(tier)) {
    return res.status(403).json({ error: `Your plan does not include ${tier} tier. Please upgrade.` });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    if (!fullCosmic) throw new Error('Server not fully initialised — restart required');
    const c = fullCosmic(date);
    c.isoDate = date;

    const lp = lifePath(profile?.dob || '');
    const nn = profile?.fullname ? nameNum(profile.fullname) : null;
    const nm = profile?.nickname || profile?.name || 'You';

    const context = buildReadingContext(c, profile, nm, lp, nn);
    const prompt = buildPromptForTier(c, context, profile, nm, lp, nn, tier, date);

    const model = (tier === 'oracle' || tier === 'mystic') ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
    const maxTokens = { oracle: 8000, mystic: 6000, initiate: 2500, seeker: 1800, free: 900 }[tier] || 1800;
    const system = (tier === 'oracle' || tier === 'mystic')
      ? 'Output ONLY valid JSON. Start with {. End with }. No trailing commas. No text outside the JSON object.'
      : 'You are Cosmic Daily Planner. Write a personalised reading.';

    let fullText = '';
    for await (const chunk of streamClaude([{ role: 'user', content: prompt }], system, model, maxTokens)) {
      fullText += chunk;
      send({ t: chunk });
    }

    // Save reading to database
    let readingId = null;
    if (req.user) {
      const result = db.prepare('INSERT INTO readings (user_id, date, tier, reading_json) VALUES (?,?,?,?)')
        .run(req.userId, date, tier, fullText);
      readingId = result.lastInsertRowid;
    }

    send({ done: true, readingId });
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    send({ error: err.message });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ── Bespoke Deep Dive (no timeout, full depth) ────────────────────────────────
app.post('/reading/bespoke', requireAuth, async (req, res) => {
  const { date, profile, focus, depth = 'full' } = req.body;

  // Only for Oracle/Bespoke tier
  if (!['oracle', 'bespoke'].includes(req.user.tier)) {
    return res.status(403).json({ error: 'Bespoke readings require Oracle or Bespoke plan' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const c = fullCosmic(date);
    c.isoDate = date;
    const nm = profile?.nickname || 'You';
    const lp = lifePath(profile?.dob || '');

    // Web search for current astronomical events and interpretations
    send({ status: 'Researching current astronomical context...' });
    let webContext = '';
    try {
      const searchRes = await callClaude([{
        role: 'user',
        content: `Search for current astrological significance of: Saturn-Neptune conjunction 0° Aries 2026, and any current major astronomical events for ${date}. Provide scholarly and interpretive context in 200 words.`
      }], 'You are an astronomical and astrological researcher. Be precise and scholarly.', 'claude-sonnet-4-6', 500);
      webContext = searchRes;
    } catch {}

    send({ status: 'Generating deep bespoke reading...' });

    const bespokePrompt = buildBespokePrompt(c, profile, nm, lp, focus, webContext, depth);

    let fullText = '';
    for await (const chunk of streamClaude(
      [{ role: 'user', content: bespokePrompt }],
      'You are Cosmic Daily Planner at its deepest level. This is a bespoke reading for a paying client. Produce extraordinary depth and personalisation. Output ONLY valid JSON.',
      'claude-sonnet-4-6',
      16000 // Full depth — no limits
    )) {
      fullText += chunk;
      send({ t: chunk });
    }

    if (req.user) {
      db.prepare('INSERT INTO readings (user_id, date, tier, reading_json) VALUES (?,?,?,?)')
        .run(req.userId, date, 'bespoke', fullText);
    }

    send({ done: true });
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    send({ error: err.message });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ── Follow-up Chat ────────────────────────────────────────────────────────────
app.post('/reading/:id/chat', requireAuth, async (req, res) => {
  const { message } = req.body;
  const reading = db.prepare('SELECT * FROM readings WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!reading) return res.status(404).json({ error: 'Reading not found' });

  const history = db.prepare('SELECT role, content FROM messages WHERE reading_id=? ORDER BY id').all(reading.id);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // Save user message
    db.prepare('INSERT INTO messages (reading_id, role, content) VALUES (?,?,?)').run(reading.id, 'user', message);

    const system = `You are Cosmic Daily Planner. The user received this reading and is asking follow-up questions.
Go deeper, be specific, reference their actual life by name. 2-4 paragraphs.

THEIR READING:
${reading.reading_json}`;

    const messages = [...history, { role: 'user', content: message }];
    let reply = '';

    for await (const chunk of streamClaude(messages, system, 'claude-sonnet-4-6', 2000)) {
      reply += chunk;
      send({ t: chunk });
    }

    // Save assistant reply
    db.prepare('INSERT INTO messages (reading_id, role, content) VALUES (?,?,?)').run(reading.id, 'assistant', reply);

    send({ done: true });
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    send({ error: err.message });
    res.end();
  }
});

// ── Stripe Payments ───────────────────────────────────────────────────────────
import Stripe from 'stripe';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const TIER_PRICES = {
  seeker:   process.env.STRIPE_PRICE_SEEKER,
  initiate: process.env.STRIPE_PRICE_INITIATE,
  mystic:   process.env.STRIPE_PRICE_MYSTIC,
  oracle:   process.env.STRIPE_PRICE_ORACLE,
  bespoke:  process.env.STRIPE_PRICE_BESPOKE,
};

app.post('/billing/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  const { tier } = req.body;
  const priceId = TIER_PRICES[tier];
  if (!priceId) return res.status(400).json({ error: 'Invalid tier' });

  try {
    let customerId = req.user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.user.email, name: req.user.name });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id=? WHERE id=?').run(customerId, req.userId);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: tier === 'bespoke' ? 'payment' : 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/billing/cancel`,
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).end();
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send('Webhook error: ' + e.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customer = await stripe.customers.retrieve(session.customer);
    const user = db.prepare('SELECT id FROM users WHERE email=?').get(customer.email);
    if (user) {
      // Determine tier from subscription
      let tier = 'seeker';
      if (session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const priceId = sub.items.data[0].price.id;
        tier = Object.entries(TIER_PRICES).find(([,p]) => p === priceId)?.[0] || 'seeker';
        db.prepare('UPDATE users SET tier=?, stripe_subscription_id=? WHERE id=?').run(tier, session.subscription, user.id);
      } else {
        // One-off bespoke payment
        db.prepare('UPDATE users SET tier="bespoke" WHERE id=?').run(user.id);
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    db.prepare('UPDATE users SET tier="free", stripe_subscription_id=NULL WHERE stripe_subscription_id=?').run(sub.id);
  }

  res.json({ received: true });
});

// ── User Learning Integration ─────────────────────────────────────────────────
// Builds a personalised learning profile from reading history
app.get('/insights', requireAuth, async (req, res) => {
  const readings = db.prepare('SELECT reading_json, date, tier FROM readings WHERE user_id=? ORDER BY date DESC LIMIT 20')
    .all(req.userId);

  if (readings.length < 3) return res.json({ insights: null, message: 'Complete at least 3 readings to unlock personal insights' });

  try {
    const summary = readings.map(r => {
      try { return JSON.parse(r.reading_json); } catch { return null; }
    }).filter(Boolean).map(r => `${r.date}: ${r.convergence}`).join('\n');

    const insights = await callClaude([{
      role: 'user',
      content: `Based on these convergence themes from the user's recent readings:\n${summary}\n\nIdentify: 1) recurring patterns, 2) how their themes have evolved, 3) what the next chapter seems to be building toward. 3 short paragraphs.`
    }], 'You are a wise counsellor who has followed this person\'s journey through their readings.', 'claude-sonnet-4-6', 800);

    res.json({ insights });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Parallel reading parts (called simultaneously from client) ───────────────
async function getPartBody(req, res, partFn) {
  const { date, profile } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    const c = fullCosmic(date);
    c.isoDate = date;
    const lp = lifePath(profile?.dob || '');
    const nn = profile?.fullname ? nameNum(profile.fullname) : null;
    const nm = profile?.nickname || profile?.name || 'You';
    const context = buildReadingContext(c, profile, nm, lp, nn);
    const raw = await partFn(c, context, profile, nm, lp, nn);
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.json(raw);
  } catch(err) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.status(500).json({ error: err.message });
  }
}

app.post('/reading/part1', optionalAuth, (req, res) => getPartBody(req, res, buildPart1));
app.post('/reading/part2', optionalAuth, (req, res) => getPartBody(req, res, buildPart2));
app.post('/reading/part3', optionalAuth, (req, res) => getPartBody(req, res, buildPart3));

async function buildPart1(c, context, profile, nm, lp, nn) {
  const expr = nn?.expression || null;
  const soul = nn?.soulUrge || null;
  const prompt = context + `\n\nReturn ONLY JSON with convergence, date, tz, season, cosmicSnapshot, and frameworks fields.
Each framework body: two specific paragraphs naming ${nm}'s actual life (Cosmic Daily Planner, Connie, Gentronix).
{
  "convergence":"single sentence all frameworks agree on for ${nm} today",
  "date":"${c.dayName}, ${c.isoDate}","tz":"${c.tz}","season":"${c.seasonNote}",
  "cosmicSnapshot":{"moon":{"phase":"${c.phase}","pct":${c.illum},"sign":"${c.moonSign}","deg":${c.moonDegS||0},"daysToFull":${(c.daysToFull||3).toFixed(1)}},"sun":{"sign":"${c.sunSign}","deg":${c.sunDeg||10}},"universalDay":${c.ud},"kin":${c.kin},"kinName":"${c.kinName}","isGAP":${c.isGAP},"moon13":"${c.m13Name}","moon13Day":${c.dm13},"castle":"${c.castle5}"},
  "frameworks":{
    "numerology":{"icon":"${c.ud}","headline":"UD ${c.ud} — [quality]","body":"two paragraphs for ${nm}${lp?', Life Path '+lp:''}","personal":"${lp?'Life Path '+lp+(expr?', Expr '+expr:'')+(soul?', Soul '+soul:''):''}"},
    "astrology":{"icon":"♈","headline":"[key aspect]","body":"two paragraphs for ${nm}. Include Saturn-Neptune 0° Aries for someone building something new.","historic":"Saturn-Neptune 0° Aries: last ~1522 (Renaissance)."},
    "dreamspell":{"icon":"◈","headline":"Kin ${c.kin} — ${c.kinName}","body":"two paragraphs. Seal ${c.kinSeal} (${c.sealAction}/${c.sealPower}), Tone ${c.kinTone} ('${c.toneQuestion}'). Moon ${c.m13Name} Day ${c.dm13}/28 in ${c.castle5} pos ${c.pos5}/52 for ${nm}.","moon13":"Moon ${c.m13Num} — ${c.m13Name}, Day ${c.dm13}/28","castle":"${c.castle5}, pos ${c.pos5}/52","toneQuestion":"${c.toneQuestion}"},
    "deepTime":{"icon":"∞","headline":"Saturn-Neptune 0° Aries — unprecedented","body":"two paragraphs. Historical weight (1522,1989,1953,1917) then what it means for ${nm} building Cosmic Daily Planner."}
  }
}`;
  const raw = await callClaude([{role:'user',content:prompt}],
    'Output ONLY valid JSON. Start with {. End with }. No trailing commas.', 'claude-sonnet-4-6', 3000);
  return cleanJSON(raw);
}

async function buildPart2(c, context, profile, nm, lp, nn) {
  const aspects = (c.detectedAspects||[]).slice(0,6);
  const prompt = context + `\n\nReturn ONLY JSON with planets, keyAspects, shadow, priorities, focusOn, easeOff, windows.
{
  "planets":[{"body":"Sun","pos":"${c.sunDeg}° ${c.sunSign}","note":""},{"body":"Moon","pos":"${c.moonDegS}° ${c.moonSign}","note":"${c.phase}"},{"body":"Mercury","pos":"from data","note":""},{"body":"Venus","pos":"from data","note":""},{"body":"Mars","pos":"from data","note":""},{"body":"Jupiter","pos":"from data","note":"direct since 10 Mar 2026"},{"body":"Saturn","pos":"from data","note":"Aries since 13 Feb 2026"},{"body":"Neptune","pos":"from data","note":"Aries since 26 Jan 2026"},{"body":"Pluto","pos":"from data","note":""},{"body":"Uranus","pos":"from data","note":"enters Gemini 26 Apr 2026"}],
  "keyAspects":[${aspects.map(a=>`{"aspect":"${a}","detail":"interpreted specifically for ${nm}","significance":4}`).join(',')}],
  "shadow":"one honest paragraph what today asks ${nm} to face — specific, not generic",
  "priorities":[{"num":1,"title":"name","why":"frameworks reasoning","action":"action naming Cosmic Daily Planner/Connie/Gentronix"},{"num":2,"title":"name","why":"reasoning","action":"action"},{"num":3,"title":"name","why":"reasoning","action":"action"}],
  "focusOn":["specific to ${nm}","specific","specific"],
  "easeOff":["specific to ${nm}","specific","specific"],
  "windows":{"morning":"sentence for ${nm}","afternoon":"sentence","evening":"sentence"}
}`;
  const raw = await callClaude([{role:'user',content:prompt}],
    'Output ONLY valid JSON. Start with {. End with }. No trailing commas.', 'claude-sonnet-4-6', 3000);
  return cleanJSON(raw);
}

async function buildPart3(c, context, profile, nm, lp, nn) {
  const kins = (c.upcomingKins||[]).slice(0,7);
  const kinRows = kins.map(k =>
    `{"date":"${k.label||''}","kin":"Kin ${k.kin} — ${k.name||''}","ud":${k.ud||1},"isGAP":${k.isGAP||false},"note":"what this day carries + note for ${nm}"}`
  ).join(',');
  const prompt = context + `\n\nReturn ONLY JSON with lookingAhead and dailyGift.
{
  "lookingAhead":[${kinRows}],
  "dailyGift":{"quote":"accurate quote for ${nm}","attribution":"Author, Source, Year","grounding":"three sentences for ${nm} in this season","forToday":["act of love specific to ${nm}'s relationships","moment of noticing today","act of honest care"],"closing":"one sentence only for ${nm}"}
}`;
  const raw = await callClaude([{role:'user',content:prompt}],
    'Output ONLY valid JSON. Start with {. End with }. No trailing commas.', 'claude-sonnet-4-6', 2000);
  return cleanJSON(raw);
}


// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    hasStripe: !!process.env.STRIPE_SECRET_KEY,
    db: 'connected'
  });
});

// ── Prompt Builders ───────────────────────────────────────────────────────────
function buildReadingContext(c, profile, nm, lp, nn) {
  const expr = nn?.expression || null;
  const soul = nn?.soulUrge || null;
  return `PERSON: ${nm}${profile?.fullname ? ' (' + profile.fullname + ')' : ''}${lp ? ', Life Path ' + lp : ''}${expr ? ', Expression ' + expr : ''}
Location: ${profile?.location || 'UK'} | Chapter: ${profile?.lifeChapter || profile?.chapter || ''}
Building: ${profile?.building || ''} | People: ${profile?.people || ''}
Matters: ${profile?.whatMatters || ''} | Needs to hear: ${profile?.needToHear || ''}

DATE: ${c.dayName}, ${c.isoDate} | ${c.tz} | ${c.seasonNote}
Universal Day: ${c.ud} | Moon: ${c.moonDegS}° ${c.moonSign} (${c.phase}, ${c.illum}%, ${(c.daysToFull || 3).toFixed(1)}d to Full)
Sun: ${c.sunDeg}° ${c.sunSign}
Kin: ${c.kin} ${c.kinName}${c.isGAP ? ' (GAP)' : ''} | Tone: ${c.kinTone} ("${c.toneQuestion}") | Seal: ${c.kinSeal}
Guide:${c.guide} Antipode:${c.antipode} Occult:${c.occult} Analog:${c.analog}
13 Moon: ${c.m13Name} Day ${c.dm13}/28 | Castle: ${c.castle5} pos ${c.pos5}/52
${c.pTable}
Aspects: ${(c.detectedAspects || []).slice(0, 8).join(' | ')}
Saturn-Neptune 0° Aries — first in Aries since ~1522 (Renaissance).`;
}

function buildPromptForTier(c, context, profile, nm, lp, nn, tier, isoDate) {
  const expr = nn?.expression || null;
  const soul = nn?.soulUrge || null;

  if (tier === 'oracle' || tier === 'mystic') {
    return `${context}

ORACLE TIER — Return ONLY valid JSON. No text before {. No text after }. No trailing commas.
Every paragraph must name ${nm}'s actual situation. "Cosmic Daily Planner" not "your project".

{
  "convergence": "The single sentence all frameworks agree on for ${nm} today",
  "date": "${c.dayName}, ${isoDate}",
  "tz": "${c.tz}",
  "season": "${c.seasonNote}",
  "cosmicSnapshot": {
    "moon": {"phase":"${c.phase}","pct":${c.illum},"sign":"${c.moonSign}","deg":${c.moonDegS || 0},"daysToFull":${(c.daysToFull || 3).toFixed(1)}},
    "sun": {"sign":"${c.sunSign}","deg":${c.sunDeg || 10}},
    "universalDay":${c.ud},"kin":${c.kin},"kinName":"${c.kinName}","isGAP":${c.isGAP},
    "moon13":"${c.m13Name}","moon13Day":${c.dm13},"castle":"${c.castle5}"
  },
  "planets": [
    {"body":"Sun","pos":"${c.sunDeg}° ${c.sunSign}","note":""},
    {"body":"Moon","pos":"${c.moonDegS}° ${c.moonSign}","note":"${c.phase}, ${c.illum}%"},
    {"body":"Mercury","pos":"from data","note":""},
    {"body":"Venus","pos":"from data","note":""},
    {"body":"Mars","pos":"from data","note":""},
    {"body":"Jupiter","pos":"from data","note":"direct since 10 Mar 2026"},
    {"body":"Saturn","pos":"from data","note":"Aries since 13 Feb 2026"},
    {"body":"Neptune","pos":"from data","note":"Aries since 26 Jan 2026"},
    {"body":"Pluto","pos":"from data","note":""},
    {"body":"Uranus","pos":"from data","note":"enters Gemini 26 Apr 2026"}
  ],
  "keyAspects": [{"aspect":"name","detail":"specific to ${nm}","significance":5}],
  "frameworks": {
    "numerology": {"icon":"${c.ud}","headline":"UD ${c.ud} — quality","body":"Two paragraphs specific to ${nm}. Name Cosmic Daily Planner, Gentronix, Connie.","personal":"${lp ? 'Life Path ' + lp : ''}"},
    "astrology": {"icon":"♈","headline":"key aspect today","body":"Two paragraphs. Key aspect + Saturn-Neptune 0° Aries for someone building something new.","historic":"Saturn-Neptune 0° Aries: last ~1522 (Renaissance)."},
    "dreamspell": {"icon":"◈","headline":"Kin ${c.kin} — ${c.kinName}","body":"Two paragraphs. Seal + tone + 13 Moon pos for ${nm}.","moon13":"Moon ${c.m13Num} — ${c.m13Name}, Day ${c.dm13}/28","castle":"${c.castle5}, pos ${c.pos5}/52","toneQuestion":"${c.toneQuestion}"},
    "deepTime": {"icon":"∞","headline":"Saturn-Neptune 0° Aries","body":"Two paragraphs. Historical weight. What it means for ${nm} building Cosmic Daily Planner now."}
  },
  "shadow": "One honest paragraph specific to ${nm}",
  "priorities": [
    {"num":1,"title":"name","why":"frameworks reasoning","action":"specific action naming real things"},
    {"num":2,"title":"name","why":"reasoning","action":"specific action"},
    {"num":3,"title":"name","why":"reasoning","action":"specific action"}
  ],
  "focusOn": ["specific to ${nm}","specific","specific"],
  "easeOff": ["specific to ${nm}","specific","specific"],
  "windows": {"morning":"sentence for ${nm}","afternoon":"sentence","evening":"sentence"},
  "lookingAhead": [
    {"date":"day 1","kin":"kin name","ud":1,"isGAP":false,"note":"note for ${nm}"},
    {"date":"day 2","kin":"kin name","ud":2,"isGAP":false,"note":"note"},
    {"date":"day 3","kin":"kin name","ud":3,"isGAP":false,"note":"note"},
    {"date":"day 4","kin":"kin name","ud":4,"isGAP":false,"note":"note"},
    {"date":"day 5","kin":"kin name","ud":5,"isGAP":false,"note":"note"},
    {"date":"day 6","kin":"kin name","ud":6,"isGAP":false,"note":"note"},
    {"date":"day 7","kin":"kin name","ud":7,"isGAP":false,"note":"note"}
  ],
  "dailyGift": {
    "quote":"accurate quote for ${nm}","attribution":"Author, Source, Year",
    "grounding":"three sentences for ${nm} in this season",
    "forToday":["act of love","moment of noticing","act of care"],
    "closing":"sentence only for ${nm}"
  }
}`;
  }

  // Lower tiers: prose
  return `${context}

${tier.toUpperCase()} TIER reading for ${nm}. Write a warm, specific daily reading with cosmic insight.
Be personal — name their actual situation. 400-600 words.`;
}

function buildBespokePrompt(c, profile, nm, lp, focus, webContext, depth) {
  return `${buildReadingContext(c, profile, nm, lp, null)}

BESPOKE DEEP DIVE — This is a premium £1000 reading. Every section should be extraordinary.
Focus areas requested: ${focus || 'full life reading'}
Web research context: ${webContext}

Produce the most comprehensive, deeply personal Oracle reading possible.
Return valid JSON matching the Oracle schema but with MAXIMUM depth in every text field.
Each framework body: 4-6 paragraphs. Shadow: full page. Each priority: full paragraph.
Looking ahead: 14 days. Daily gift: extended meditation.`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`CDP API running on port ${PORT}`);
  console.log(`Anthropic key: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗ MISSING'}`);
  console.log(`Stripe: ${process.env.STRIPE_SECRET_KEY ? '✓' : '✗ not configured'}`);
});

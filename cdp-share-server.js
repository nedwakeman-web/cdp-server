/*
 * cdp-share-server.js
 * Cosmic Daily Planner share links (Track B, server side).
 *
 * Gives each shared reading its own URL with a per reading Open Graph image,
 * so X, LinkedIn and Facebook unfurl the card instead of the generic site
 * image. Crawlers read the meta tags; people see the card plus a call to
 * action back into the app.
 *
 * Persistence: Supabase Storage plus a share_links table, reached over HTTPS
 * with the service role key. This is the same fetch with env key pattern the
 * codebase already uses for Anthropic, so it adds no npm dependency. If the
 * Supabase env vars are absent it falls back to in memory storage, matching
 * the existing FALLBACK MODE used by invitations, with a warning that links
 * are then lost on restart.
 *
 * Image serving: the PNG is always served from this server at
 * /r/:id/image.png, whether the bytes live in Supabase Storage or in memory.
 * That keeps one image URL shape and avoids needing a public bucket.
 *
 * House style: no em dashes, no en dashes, no user visible exclamations.
 *
 * Wire up in server.js with a single line after express.json is registered:
 *     require('./cdp-share-server')(app);
 *
 * Env (all optional; without the first two it runs in memory only):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_SHARE_BUCKET     default 'cdp-shares'
 *   PUBLIC_BASE_URL           default 'https://cosmicdailyplanner.com'
 *   SHARE_TTL_DAYS            default '365'
 */
'use strict';

const crypto = require('crypto');

module.exports = function attachShare(app, opts) {
  opts = opts || {};

  const SB_URL    = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SB_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const BUCKET    = process.env.SUPABASE_SHARE_BUCKET || 'cdp-shares';
  const BASE_URL  = (opts.baseUrl || process.env.PUBLIC_BASE_URL || 'https://cosmicdailyplanner.com').replace(/\/+$/, '');
  const TTL_DAYS  = parseInt(process.env.SHARE_TTL_DAYS || '365', 10);
  const PERSIST   = !!(SB_URL && SB_KEY);

  // In memory fallback store. record: {id, type, title, description, voice, w, h, png(Buffer), createdAt, expiresAt, revoked}
  const memStore = new Map();

  if (PERSIST) {
    console.log('[cdp-share] persistence: Supabase (' + SB_URL + ', bucket ' + BUCKET + ')');
  } else {
    console.log('[cdp-share] persistence: in memory fallback. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for durable links. Links are lost on restart.');
  }

  const ALLOWED_TYPES = ['daily', 'year', 'compatibility', 'response'];
  const MAX_IMG_BYTES = 6 * 1024 * 1024;

  /* ---------------------------------------------------------------- utils */
  function newId() {
    return crypto.randomBytes(9).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function clamp(s, n) {
    s = (s == null ? '' : String(s));
    return s.length > n ? s.slice(0, n) : s;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ----------------------------------------------------------- supabase */
  function sbHeaders(extra) {
    return Object.assign({
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY
    }, extra || {});
  }

  async function sbInsert(row) {
    const r = await fetch(SB_URL + '/rest/v1/share_links', {
      method: 'POST',
      headers: sbHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify(row)
    });
    if (!r.ok) throw new Error('share_links insert failed ' + r.status + ' ' + (await r.text()).slice(0, 200));
  }

  async function sbSelect(id) {
    const r = await fetch(SB_URL + '/rest/v1/share_links?id=eq.' + encodeURIComponent(id) + '&select=*&limit=1', {
      headers: sbHeaders({ 'Accept': 'application/json' })
    });
    if (!r.ok) throw new Error('share_links select failed ' + r.status);
    const rows = await r.json();
    return rows && rows[0] ? rows[0] : null;
  }

  async function sbPatch(id, patch) {
    const r = await fetch(SB_URL + '/rest/v1/share_links?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: sbHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify(patch)
    });
    if (!r.ok) throw new Error('share_links patch failed ' + r.status);
  }

  async function sbUpload(path, buf) {
    const r = await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
      method: 'POST',
      headers: sbHeaders({ 'Content-Type': 'image/png', 'x-upsert': 'true' }),
      body: buf
    });
    if (!r.ok) throw new Error('storage upload failed ' + r.status + ' ' + (await r.text()).slice(0, 200));
  }

  async function sbDownload(path) {
    const r = await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + path, { headers: sbHeaders() });
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  }

  async function sbRemove(path) {
    try {
      await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + path, { method: 'DELETE', headers: sbHeaders() });
    } catch (e) { /* best effort */ }
  }

  /* --------------------------------------------------------- store layer */
  async function putShare(rec, png) {
    if (PERSIST) {
      await sbUpload(rec.id + '.png', png);
      await sbInsert({
        id: rec.id, type: rec.type, title: rec.title, description: rec.description,
        voice: rec.voice, w: rec.w, h: rec.h,
        created_at: rec.createdAt, expires_at: rec.expiresAt, revoked: false
      });
    } else {
      rec.png = png;
      memStore.set(rec.id, rec);
    }
  }

  async function getShare(id) {
    if (PERSIST) {
      const row = await sbSelect(id);
      if (!row) return null;
      return {
        id: row.id, type: row.type, title: row.title, description: row.description,
        voice: row.voice, w: row.w, h: row.h,
        createdAt: row.created_at, expiresAt: row.expires_at, revoked: !!row.revoked
      };
    }
    return memStore.get(id) || null;
  }

  async function getShareImage(id) {
    if (PERSIST) return sbDownload(id + '.png');
    const rec = memStore.get(id);
    return rec && rec.png ? rec.png : null;
  }

  async function revokeShare(id) {
    if (PERSIST) {
      await sbPatch(id, { revoked: true });
      await sbRemove(id + '.png');
    } else {
      memStore.delete(id);
    }
  }

  function isExpired(rec) {
    if (!rec.expiresAt) return false;
    return new Date(rec.expiresAt).getTime() < Date.now();
  }

  /* ---------------------------------------------------------- endpoints */

  // Create a share link. Called only when the user chooses a link share.
  app.post('/api/share', async (req, res) => {
    try {
      const b = req.body || {};
      const type = ALLOWED_TYPES.indexOf(b.type) >= 0 ? b.type : 'daily';
      const imageBase64 = String(b.imageBase64 || '').replace(/^data:image\/png;base64,/, '');
      if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

      const png = Buffer.from(imageBase64, 'base64');
      if (!png.length || png.length > MAX_IMG_BYTES) {
        return res.status(413).json({ error: 'image missing or too large' });
      }

      const id = newId();
      const now = new Date();
      const rec = {
        id: id,
        type: type,
        title: clamp(b.title, 160) || 'A Cosmic Daily reading',
        description: clamp(b.description, 320) || 'Spiritual tradition and neuroscience, arriving at the same coordinates.',
        voice: clamp(b.voice, 24),
        w: parseInt(b.w, 10) || 1080,
        h: parseInt(b.h, 10) || 1350,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + TTL_DAYS * 86400000).toISOString(),
        revoked: false
      };

      await putShare(rec, png);

      res.json({
        id: id,
        url: BASE_URL + '/r/' + id,
        imageUrl: BASE_URL + '/r/' + id + '/image.png'
      });
    } catch (e) {
      console.error('[POST /api/share]', e && e.message);
      res.status(500).json({ error: 'could not create share link' });
    }
  });

  // Serve the stored PNG. Used as og:image and on the human page.
  app.get('/r/:id/image.png', async (req, res) => {
    try {
      const rec = await getShare(req.params.id);
      if (!rec || rec.revoked || isExpired(rec)) return res.status(404).end();
      const png = await getShareImage(req.params.id);
      if (!png) return res.status(404).end();
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.end(png);
    } catch (e) {
      console.error('[GET /r/:id/image.png]', e && e.message);
      res.status(500).end();
    }
  });

  // The shareable page. Carries per share Open Graph and Twitter meta, then
  // shows the card and a call to action.
  app.get('/r/:id', async (req, res) => {
    let rec = null;
    try { rec = await getShare(req.params.id); } catch (e) { /* handled below */ }

    if (!rec || rec.revoked || isExpired(rec)) {
      res.status(rec ? 410 : 404).send(fallbackPage());
      return;
    }

    const id = encodeURIComponent(req.params.id);
    const img = BASE_URL + '/r/' + id + '/image.png';
    const pageUrl = BASE_URL + '/r/' + id;
    const title = escapeHtml(rec.title);
    const desc = escapeHtml(rec.description);
    const w = parseInt(rec.w, 10) || 1080;
    const h = parseInt(rec.h, 10) || 1350;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send([
      '<!doctype html><html lang="en"><head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>' + title + '</title>',
      '<meta name="description" content="' + desc + '">',
      '<meta property="og:type" content="article">',
      '<meta property="og:title" content="' + title + '">',
      '<meta property="og:description" content="' + desc + '">',
      '<meta property="og:url" content="' + pageUrl + '">',
      '<meta property="og:image" content="' + img + '">',
      '<meta property="og:image:width" content="' + w + '">',
      '<meta property="og:image:height" content="' + h + '">',
      '<meta name="twitter:card" content="summary_large_image">',
      '<meta name="twitter:title" content="' + title + '">',
      '<meta name="twitter:description" content="' + desc + '">',
      '<meta name="twitter:image" content="' + img + '">',
      '<style>',
      'html,body{margin:0;background:#06101F;color:#F0E6CC;',
      'font-family:Georgia,"Times New Roman",serif;min-height:100vh}',
      '.wrap{max-width:520px;margin:0 auto;padding:36px 20px 56px;text-align:center}',
      '.card{width:100%;border-radius:10px;display:block;margin:0 auto 28px;',
      'box-shadow:0 24px 60px rgba(0,0,0,0.5)}',
      '.cta{display:inline-block;margin-top:8px;padding:13px 26px;border-radius:5px;',
      'background:#C9A050;color:#06101F;text-decoration:none;letter-spacing:.04em;',
      'font-family:Helvetica,Arial,sans-serif;font-size:15px}',
      '.cta:hover{background:#E8C878}',
      '.tag{margin:22px 0 4px;font-size:15px;color:#D4C8AE;line-height:1.6}',
      '.brand{margin-top:30px;font-size:12px;letter-spacing:.22em;color:rgba(201,160,80,0.7);',
      'font-family:Helvetica,Arial,sans-serif;text-transform:uppercase}',
      '</style></head><body><div class="wrap">',
      '<img class="card" src="' + img + '" alt="' + title + '" width="' + w + '" height="' + h + '">',
      '<div class="tag">Two telescopes, pointed at the same sky.</div>',
      '<a class="cta" href="' + BASE_URL + '/app">Read your own day</a>',
      '<div class="brand">Cosmic Daily Planner</div>',
      '</div></body></html>'
    ].join(''));
  });

  // Revoke a link and remove its image.
  app.post('/api/share/:id/revoke', async (req, res) => {
    try {
      await revokeShare(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      console.error('[POST /api/share/:id/revoke]', e && e.message);
      res.status(500).json({ error: 'could not revoke' });
    }
  });

  function fallbackPage() {
    return [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>Cosmic Daily Planner</title>',
      '<meta property="og:title" content="Cosmic Daily Planner">',
      '<meta property="og:description" content="Spiritual tradition and neuroscience, arriving at the same coordinates.">',
      '<style>html,body{margin:0;background:#06101F;color:#F0E6CC;',
      'font-family:Georgia,serif;display:flex;min-height:100vh;align-items:center;justify-content:center}',
      'a{color:#C9A050}</style></head><body><div style="text-align:center;padding:24px">',
      '<p>This reading is no longer available.</p>',
      '<p><a href="' + BASE_URL + '/app">Open Cosmic Daily Planner</a></p>',
      '</div></body></html>'
    ].join('');
  }

  console.log('[cdp-share] endpoints attached: POST /api/share, GET /r/:id, GET /r/:id/image.png, POST /api/share/:id/revoke');
};

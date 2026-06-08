/*
 * cdp-share.js
 * Cosmic Daily Planner unified share core (Track A, client side).
 *
 * One renderer, one share path, four content adapters. Replaces the
 * fragmented share code currently in app.html:
 *   buildShareCanvas, the inline canvas inside copyShareCard, shareNative,
 *   openShareCard image path, downloadCard, saveDayCardImage.
 *
 * What this fixes versus the current code:
 *   1. The native share sheet now receives the rendered PNG as a file,
 *      not just text and the homepage URL. This is the main gap.
 *   2. One drawing routine, not three drifting copies.
 *   3. Canonical palette restored (was off brand at 0D1E33 / e8e4da).
 *   4. Three export formats: square 1080, portrait 1080x1350, story 1080x1920.
 *   5. A single shareUrl field per card. Track B (per reading link with its
 *      own Open Graph image) plugs in by setting spec.shareUrl. Until then it
 *      defaults to the homepage, which is the current behaviour.
 *
 * No external dependencies. Pure 2D canvas, so fonts and colour are
 * deterministic and do not depend on html2canvas quirks.
 *
 * House style: no em dashes, no en dashes, no user visible exclamations.
 *
 * Public API (attached to window.CDPShare):
 *   CDPShare.open(type, data, opts)   open the overlay with a live preview
 *   CDPShare.share(spec, format)      render then hand to the OS share sheet
 *   CDPShare.download(spec, format)   render then download the PNG
 *   CDPShare.copyText(spec)           copy the plain text version
 *   CDPShare.renderToBlob(spec, fmt)  -> Promise<Blob>
 *   CDPShare.adapters.fromDaily / fromYear / fromCompatibility / fromResponse
 */
(function () {
  'use strict';

  /* ----------------------------------------------------------------------
   * Brand tokens. Single source of truth for the card. Edit here only.
   * -------------------------------------------------------------------- */
  var BRAND = {
    skyTop:    '#0A1C38',   // top of the navy field
    skyBottom: '#06101F',   // deeper navy at the foot
    gold:      '#C9A050',
    goldSoft:  '#E8C878',
    textLight: '#F0E6CC',
    textDim:   '#D4C8AE',
    teal:      '#1D9E75',
    serif:     'Georgia, "Times New Roman", serif',
    sans:      'Helvetica, Arial, sans-serif'
  };

  // Voice accent. Tradition leans gold, Science leans teal, Everyday parchment.
  var VOICE = {
    tradition: { label: 'Tradition', accent: BRAND.gold },
    science:   { label: 'Science',   accent: BRAND.teal },
    everyday:  { label: 'Everyday',  accent: BRAND.textDim }
  };

  /* ----------------------------------------------------------------------
   * Format presets. All exported at true pixel size for crisp output.
   * -------------------------------------------------------------------- */
  var FORMATS = {
    square:   { w: 1080, h: 1080, pad: 96,  titlePx: 46, bodyPx: 30, bodyLines: 9  },
    portrait: { w: 1080, h: 1350, pad: 100, titlePx: 50, bodyPx: 31, bodyLines: 13 },
    story:    { w: 1080, h: 1920, pad: 112, titlePx: 54, bodyPx: 33, bodyLines: 18 }
  };

  /* ----------------------------------------------------------------------
   * Small helpers
   * -------------------------------------------------------------------- */
  function stripMarkdown(s) {
    return String(s || '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/^[_*]+|[_*]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function resolveVoice(v) {
    var key = String(v || '').toLowerCase();
    if (VOICE[key]) return VOICE[key];
    // Best effort read of an existing global if the caller did not pass one.
    try {
      var g = (window.cdpVoice || window.__cdpVoice || (window.CDP && window.CDP.voice) || '');
      g = String(g).toLowerCase();
      if (VOICE[g]) return VOICE[g];
    } catch (e) {}
    return VOICE.everyday;
  }

  // Greedy word wrap against a measured width.
  function wrapLines(ctx, text, maxWidth) {
    var words = String(text || '').split(' ');
    var lines = [];
    var cur = '';
    for (var i = 0; i < words.length; i++) {
      var test = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxWidth && cur) {
        lines.push(cur);
        cur = words[i];
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // Clamp to a line budget, ending on a sentence boundary where possible.
  function clampBody(ctx, text, maxWidth, maxLines) {
    var full = wrapLines(ctx, text, maxWidth);
    if (full.length <= maxLines) return { lines: full, truncated: false };
    var kept = full.slice(0, maxLines).join(' ');
    var lastStop = Math.max(kept.lastIndexOf('. '), kept.lastIndexOf('? '), kept.lastIndexOf('; '));
    if (lastStop > kept.length * 0.5) {
      kept = kept.slice(0, lastStop + 1);
    } else {
      kept = kept.replace(/\s+\S*$/, '') + '...';
    }
    return { lines: wrapLines(ctx, kept, maxWidth), truncated: true };
  }

  /* ----------------------------------------------------------------------
   * The renderer. Draws one card onto a canvas at the chosen format.
   * spec: { kicker, title, body, chips:[], voice, shareUrl, footer }
   * -------------------------------------------------------------------- */
  function drawCard(spec, format) {
    var F = FORMATS[format] || FORMATS.square;
    var voice = resolveVoice(spec.voice);
    var dpr = 1; // we already export at full pixel size
    var cv = document.createElement('canvas');
    cv.width = F.w * dpr;
    cv.height = F.h * dpr;
    var ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.textBaseline = 'alphabetic';

    // Sky field
    var grad = ctx.createLinearGradient(0, 0, 0, F.h);
    grad.addColorStop(0, BRAND.skyTop);
    grad.addColorStop(1, BRAND.skyBottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, F.w, F.h);

    // Quiet starfield, deterministic so the card is stable across renders
    drawStars(ctx, F);

    // Inner gold frame, very fine
    ctx.strokeStyle = 'rgba(201,160,80,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(F.pad * 0.55, F.pad * 0.55, F.w - F.pad * 1.1, F.h - F.pad * 1.1);

    var x = F.pad;
    var maxW = F.w - F.pad * 2;
    var y = F.pad + 18;

    // Top hairline
    ctx.fillStyle = BRAND.gold;
    ctx.fillRect(x, y, 64, 2);
    y += 30;

    // Voice pill
    var pillText = voice.label.toUpperCase();
    ctx.font = '600 16px ' + BRAND.sans;
    var pw = ctx.measureText(pillText).width + 28;
    ctx.fillStyle = 'rgba(201,160,80,0.12)';
    roundRect(ctx, x, y, pw, 30, 15);
    ctx.fill();
    ctx.fillStyle = voice.accent;
    ctx.fillText(pillText, x + 14, y + 20);
    y += 58;

    // Kicker, for example the date or a section label
    if (spec.kicker) {
      ctx.fillStyle = 'rgba(201,160,80,0.85)';
      ctx.font = '600 18px ' + BRAND.sans;
      var kick = String(spec.kicker).toUpperCase();
      // letter spacing for the kicker
      drawTracked(ctx, kick, x, y, 2.5);
      y += 40;
    }

    // Title, hero
    if (spec.title) {
      ctx.fillStyle = BRAND.goldSoft;
      ctx.font = '500 ' + F.titlePx + 'px ' + BRAND.serif;
      var titleLines = wrapLines(ctx, stripMarkdown(spec.title), maxW);
      for (var t = 0; t < titleLines.length && t < 3; t++) {
        ctx.fillText(titleLines[t], x, y);
        y += F.titlePx * 1.12;
      }
      y += 16;
    }

    // Body
    if (spec.body) {
      ctx.fillStyle = BRAND.textLight;
      ctx.font = '400 ' + F.bodyPx + 'px ' + BRAND.serif;
      var clamped = clampBody(ctx, stripMarkdown(spec.body), maxW, F.bodyLines);
      var lh = F.bodyPx * 1.5;
      for (var b = 0; b < clamped.lines.length; b++) {
        ctx.fillText(clamped.lines[b], x, y);
        y += lh;
      }
    }

    // Footer block anchored to the foot of the card
    var footY = F.h - F.pad;

    // Chips row above the footer
    if (spec.chips && spec.chips.length) {
      ctx.font = '400 18px ' + BRAND.sans;
      ctx.fillStyle = BRAND.textDim;
      var chipText = spec.chips.filter(Boolean).join('   .   ');
      ctx.fillText(chipText, x, footY - 54);
    }

    // Foot hairline
    ctx.fillStyle = 'rgba(201,160,80,0.5)';
    ctx.fillRect(x, footY - 30, 64, 2);

    // Wordmark and link
    ctx.fillStyle = BRAND.gold;
    ctx.font = '600 19px ' + BRAND.sans;
    drawTracked(ctx, 'COSMIC DAILY PLANNER', x, footY, 2);
    ctx.fillStyle = BRAND.textDim;
    ctx.font = '400 17px ' + BRAND.sans;
    var link = String(spec.brandLink || 'cosmicdailyplanner.com').replace(/^https?:\/\//, '');
    var linkW = ctx.measureText(link).width;
    ctx.fillText(link, F.w - F.pad - linkW, footY);

    return cv;
  }

  // Rounded rectangle path
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Manual letter spacing for short tracked labels
  function drawTracked(ctx, text, x, y, tracking) {
    var cx = x;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + tracking;
    }
  }

  // Deterministic faint starfield seeded from card dimensions
  function drawStars(ctx, F) {
    var seed = F.w * 7 + F.h * 13;
    function rnd() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }
    ctx.save();
    for (var i = 0; i < 46; i++) {
      var sx = rnd() * F.w;
      var sy = rnd() * F.h;
      var r = rnd() * 1.3 + 0.3;
      ctx.fillStyle = 'rgba(240,230,204,' + (0.05 + rnd() * 0.12).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ----------------------------------------------------------------------
   * Render, share, download, copy
   * -------------------------------------------------------------------- */
  function renderToBlob(spec, format) {
    return new Promise(function (resolve, reject) {
      try {
        var cv = drawCard(spec, format || 'square');
        cv.toBlob(function (blob) {
          if (blob) resolve(blob); else reject(new Error('toBlob returned null'));
        }, 'image/png');
      } catch (e) {
        reject(e);
      }
    });
  }

  function specToText(spec) {
    var parts = [];
    if (spec.kicker) parts.push(spec.kicker);
    if (spec.title) parts.push(stripMarkdown(spec.title));
    if (spec.body) parts.push(stripMarkdown(spec.body));
    if (spec.chips && spec.chips.length) parts.push(spec.chips.filter(Boolean).join(' . '));
    parts.push(spec.shareUrl || 'cosmicdailyplanner.com');
    return parts.join('\n\n');
  }

  function track(event, props) {
    try { if (window.plausible) window.plausible(event, props ? { props: props } : undefined); } catch (e) {}
  }

  // The key capability the old code lacked: attach the PNG to the share sheet.
  function share(spec, format) {
    track('share_attempt', { type: spec.type || 'unknown', format: format || 'square' });
    return renderToBlob(spec, format).then(function (blob) {
      var file = new File([blob], 'cosmic-' + (spec.slug || 'reading') + '.png', { type: 'image/png' });
      var payload = {
        title: spec.shareTitle || 'My Cosmic Daily reading',
        text: spec.shareText || specToText(spec),
        url: spec.shareUrl || 'https://cosmicdailyplanner.com'
      };
      var canFiles = false;
      try { canFiles = !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) {}
      if (canFiles && navigator.share) {
        payload.files = [file];
        return navigator.share(payload).then(function () {
          track('share_success', { channel: 'native_files' });
        }).catch(function (err) {
          if (err && err.name === 'AbortError') return;
          return fallbackShare(spec, format, blob, payload);
        });
      }
      if (navigator.share) {
        return navigator.share(payload).then(function () {
          track('share_success', { channel: 'native_textonly' });
        }).catch(function (err) {
          if (err && err.name === 'AbortError') return;
          return fallbackShare(spec, format, blob, payload);
        });
      }
      return fallbackShare(spec, format, blob, payload);
    });
  }

  function fallbackShare(spec, format, blob, payload) {
    // Desktop or unsupported: download the image and copy the text plus link.
    downloadBlob(blob, 'cosmic-' + (spec.slug || 'reading') + '.png');
    try { navigator.clipboard.writeText(payload.text); } catch (e) {}
    track('share_fallback', { channel: 'download_copy' });
  }

  function download(spec, format) {
    track('share_download', { type: spec.type || 'unknown', format: format || 'square' });
    return renderToBlob(spec, format).then(function (blob) {
      downloadBlob(blob, 'cosmic-' + (spec.slug || 'reading') + '.png');
    });
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function copyText(spec) {
    var text = specToText(spec);
    track('share_copy_text', { type: spec.type || 'unknown' });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  /* ----------------------------------------------------------------------
   * Content adapters. Each maps a CDP object into the normalised spec.
   * Daily uses the real fields read from app.html. The others use the same
   * defensive accessor idiom the codebase already uses, so they degrade
   * gracefully if a field is named differently in a given build.
   * -------------------------------------------------------------------- */
  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') return arguments[i];
    }
    return '';
  }

  var adapters = {
    fromDaily: function (reading, dateStr) {
      var r = (reading && (reading.reading && reading.reading.reading)) || (reading && reading.reading) || reading || {};
      var synth = pick(r.synthesis, reading && reading.synthesis);
      var chips = [];
      if (reading && reading.kin && reading.kin.full) chips.push(reading.kin.full);
      if (reading && reading.moon && reading.moon.phase) chips.push(reading.moon.phase);
      if (reading && reading.num && reading.num.ud) chips.push('Universal Day ' + reading.num.ud);
      var kicker = '';
      try {
        var d = new Date((dateStr || '') + 'T12:00:00Z');
        if (!isNaN(d)) kicker = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      } catch (e) {}
      return {
        type: 'daily',
        slug: 'daily-' + (dateStr || ''),
        voice: reading && reading.voice,
        kicker: kicker,
        title: (reading && reading.kin && reading.kin.full) || 'Your reading today',
        body: synth,
        chips: chips,
        shareTitle: 'My Cosmic Daily reading',
        shareUrl: (reading && reading.shareUrl) || 'https://cosmicdailyplanner.com'
      };
    },

    fromYear: function (data) {
      data = data || {};
      var chips = [];
      if (data.uy) chips.push('Universal Year ' + data.uy);
      if (data.py) chips.push('Personal Year ' + data.py);
      return {
        type: 'year',
        slug: 'year-' + pick(data.yr, ''),
        voice: data.voice,
        kicker: pick(data.yr ? ('The year ' + data.yr) : '', 'Your year ahead'),
        title: pick(data.title, data.theme, 'Your year ahead'),
        body: pick(data.synthesis, data.arc, data.body),
        chips: chips,
        shareTitle: 'My Cosmic year reading',
        shareUrl: pick(data.shareUrl, 'https://cosmicdailyplanner.com')
      };
    },

    fromCompatibility: function (data) {
      data = data || {};
      var a = pick(data.nameA, data.a, 'You');
      var b = pick(data.nameB, data.b, 'Them');
      return {
        type: 'compatibility',
        slug: 'compat',
        voice: data.voice,
        kicker: 'Compatibility',
        title: a + ' and ' + b,
        body: pick(data.synthesis, data.resonance, data.body),
        chips: data.chips || [],
        shareTitle: 'A Cosmic compatibility reading',
        shareUrl: pick(data.shareUrl, 'https://cosmicdailyplanner.com')
      };
    },

    fromResponse: function (question, answer, opts) {
      opts = opts || {};
      return {
        type: 'response',
        slug: 'reply',
        voice: opts.voice,
        kicker: pick(opts.kicker, 'A question to the Oracle'),
        title: stripMarkdown(question).slice(0, 120),
        body: answer,
        chips: opts.chips || [],
        shareTitle: 'From my Cosmic Daily Planner',
        shareUrl: pick(opts.shareUrl, 'https://cosmicdailyplanner.com')
      };
    }
  };

  /* ----------------------------------------------------------------------
   * Overlay. A light controller that drives an existing overlay element if
   * present (id cdpShareOverlay), updates a live preview, and wires the
   * format toggle plus the action buttons.
   * -------------------------------------------------------------------- */
  var current = { spec: null, format: 'portrait' };

  function open(type, data, opts) {
    opts = opts || {};
    var spec;
    if (type === 'daily') spec = adapters.fromDaily(data, opts.dateStr);
    else if (type === 'year') spec = adapters.fromYear(data);
    else if (type === 'compatibility') spec = adapters.fromCompatibility(data);
    else if (type === 'response') spec = adapters.fromResponse(data && data.question, data && data.answer, opts);
    else spec = data; // already a normalised spec
    current.spec = spec;
    current.format = opts.format || 'portrait';
    track('share_open', { type: spec.type || type });
    renderPreview();
    var ov = document.getElementById('cdpShareOverlay');
    if (ov) {
      ov.style.display = 'flex';
      requestAnimationFrame(function () { ov.style.opacity = '1'; });
    }
  }

  function close() {
    var ov = document.getElementById('cdpShareOverlay');
    if (!ov) return;
    ov.style.opacity = '0';
    setTimeout(function () { ov.style.display = 'none'; }, 250);
  }

  function setFormat(format) {
    current.format = format;
    renderPreview();
  }

  function renderPreview() {
    var host = document.getElementById('cdpSharePreview');
    if (!host || !current.spec) return;
    try {
      var cv = drawCard(current.spec, current.format);
      cv.style.width = '100%';
      cv.style.height = 'auto';
      cv.style.borderRadius = '6px';
      cv.style.display = 'block';
      host.innerHTML = '';
      host.appendChild(cv);
    } catch (e) {}
  }

  /* ----------------------------------------------------------------------
   * Track B: per reading link with its own Open Graph image.
   * A link is created only when the user chooses a link share, never on
   * download or native file share, so nothing is persisted speculatively.
   * -------------------------------------------------------------------- */
  function apiBase() {
    // Explicit override wins.
    try {
      if (typeof window !== 'undefined' && window.CDP_API_BASE) {
        return String(window.CDP_API_BASE).replace(/\/+$/, '');
      }
    } catch (e) {}
    // Otherwise reuse the app's existing API_BASE global so share calls route
    // exactly like every other API call (relative on Railway, absolute backend
    // URL when served from Netlify). typeof guard avoids a ReferenceError if it
    // is not present.
    try {
      if (typeof API_BASE !== 'undefined' && API_BASE != null) {
        return String(API_BASE).replace(/\/+$/, '');
      }
    } catch (e) {}
    return '';
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).replace(/^data:image\/png;base64,/, '')); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  function specDescription(spec) {
    var src = stripMarkdown(spec.body || spec.title || '');
    if (src.length <= 200) return src;
    var cut = src.slice(0, 200);
    return cut.replace(/\s+\S*$/, '') + '...';
  }

  // Render, upload, and return { id, url, imageUrl }. Cached per format on the spec.
  function createShareLink(spec, format) {
    format = format || current.format || 'square';
    spec._links = spec._links || {};
    if (spec._links[format]) {
      spec.shareUrl = spec._links[format].url;
      return Promise.resolve(spec._links[format]);
    }
    var F = FORMATS[format] || FORMATS.square;
    return renderToBlob(spec, format).then(blobToBase64).then(function (b64) {
      return fetch(apiBase() + '/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: spec.type || 'daily',
          title: spec.title || spec.kicker || 'A Cosmic Daily reading',
          description: specDescription(spec),
          voice: resolveVoice(spec.voice).label,
          w: F.w, h: F.h,
          imageBase64: b64
        })
      });
    }).then(function (r) {
      if (!r.ok) throw new Error('share link request failed ' + r.status);
      return r.json();
    }).then(function (j) {
      spec._links[format] = j;
      spec.shareUrl = j.url;
      track('share_link_created', { type: spec.type || 'daily', format: format });
      return j;
    });
  }

  function ensureLink() {
    if (!current.spec) return Promise.reject(new Error('no spec'));
    return createShareLink(current.spec, current.format);
  }

  function openIntent(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function netShare(network) {
    return ensureLink().then(function (j) {
      var u = encodeURIComponent(j.url);
      var t = encodeURIComponent(current.spec.shareTitle || current.spec.title || 'A Cosmic Daily reading');
      var map = {
        x: 'https://twitter.com/intent/tweet?text=' + t + '&url=' + u,
        linkedin: 'https://www.linkedin.com/sharing/share-offsite/?url=' + u,
        facebook: 'https://www.facebook.com/sharer/sharer.php?u=' + u,
        whatsapp: 'https://wa.me/?text=' + t + '%20' + u
      };
      track('share_network', { network: network });
      if (map[network]) openIntent(map[network]);
    });
  }

  function copyLink() {
    return ensureLink().then(function (j) {
      track('share_copy_link', {});
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(j.url);
      return Promise.resolve();
    });
  }

  /* ----------------------------------------------------------------------
   * Expose
   * -------------------------------------------------------------------- */
  window.CDPShare = {
    BRAND: BRAND,
    FORMATS: FORMATS,
    adapters: adapters,
    renderToBlob: renderToBlob,
    drawCard: drawCard,
    share: function (format) { return current.spec ? share(current.spec, format || current.format) : Promise.reject(new Error('no spec')); },
    shareSpec: share,
    download: function (format) { return current.spec ? download(current.spec, format || current.format) : Promise.reject(new Error('no spec')); },
    downloadSpec: download,
    copyText: function () { return current.spec ? copyText(current.spec) : Promise.reject(new Error('no spec')); },
    copyTextSpec: copyText,
    open: open,
    close: close,
    setFormat: setFormat,
    createShareLink: createShareLink,
    ensureLink: ensureLink,
    copyLink: copyLink,
    toX: function () { return netShare('x'); },
    toLinkedIn: function () { return netShare('linkedin'); },
    toFacebook: function () { return netShare('facebook'); },
    toWhatsApp: function () { return netShare('whatsapp'); }
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// CDP Calendar Enhancements v1
//
// Three additive enhancements to the existing day-detail modal and calendar:
//   1. Expanded calendar legend, every glyph documented in one tap-friendly bar.
//   2. Convergence summary at the top of the day modal, computed client-side
//      from the four frameworks already in scope (numerology, Kin, moon, special days).
//      Replaces the implicit synthesis with an explicit one-line headline.
//   3. Transit-aware day badging, scaffolded against a static transit table that
//      the server can populate from Swiss Ephemeris. Today the table is empty
//      and the function is a no-op, so this ships safely as a hook for v2.
//
// Loading: drop this file into public/ and add at the bottom of app.html, just
// before the closing </body>:
//   <script src="cdp-calendar-enhancements-v1.js"></script>
//
// The module hooks itself in on DOMContentLoaded. It does not modify the
// existing renderCalendar, openDayModal, or clientMoon functions; it overlays.
//
// Author: CDP build, May 2026
// ─────────────────────────────────────────────────────────────────────────────

(function(){
  'use strict';

  // ── 1. EXPANDED CALENDAR LEGEND ────────────────────────────────────────────
  // Replaces the incomplete legend with one that documents every symbol the
  // calendar can display. Idempotent, safe to call multiple times.

  function installExpandedLegend(){
    const legend = document.querySelector('.cal-legend');
    if (!legend) return;
    if (legend.dataset.cdpEnhanced === '1') return;

    legend.innerHTML = [
      // Numerology layer
      '<span><span style="display:inline-block;width:10px;height:10px;background:rgba(200,160,255,0.1);border:1px solid rgba(200,160,255,0.3)"></span> Master Number day (11, 22, 33, 44)</span>',
      '<span><span style="color:var(--gold);font-size:11px">7&#10042;</span> Day 7 (introspection, magic)</span>',
      '<span><span style="color:var(--gold);font-size:11px">9&#10042;</span> Day 9 (completion, compassion)</span>',
      // Dreamspell layer
      '<span><span style="display:inline-block;width:10px;height:10px;border-left:3px solid var(--teal)"></span> GAP, Galactic Activation Portal</span>',
      // Lunar layer
      '<span>&#127761; New Moon</span>',
      '<span>&#127765; Full Moon</span>',
      '<span style="color:#ff9999">&#9888;&#65039; Black Moon (2 days before New)</span>',
      '<span style="color:var(--teal)">&#10024; Shiva Moon (2 days after New)</span>',
      // Best Day overlay (only meaningful when results are active)
      '<span style="opacity:.7"><span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:rgba(212,175,55,0.85);color:#000;font-size:9px;font-weight:600;text-align:center;line-height:14px">1</span> Best Day rank (when active)</span>'
    ].join('');
    legend.dataset.cdpEnhanced = '1';
    legend.style.gap = '14px';
    legend.style.fontSize = '11px';
    legend.style.padding = '14px 12px';
  }

  // ── 2. CONVERGENCE SUMMARY (one-line "today three frameworks agree on X") ──
  // Reads the data already computed in _dayModalData and synthesises a single
  // headline. The headline is conservative: it only claims convergence when
  // multiple frameworks point to the same theme. Otherwise it states what the
  // day's strongest single signal is, plainly.
  //
  // Themes used (kept short and concrete, not mystical):
  //   "build / structure"    -> 4, 8, 22, 44, Eagle, Earth, Wizard tones of structure
  //   "begin / start"        -> 1, 11, Shiva Moon, Magnetic tone, Dragon
  //   "rest / receive"       -> 7, 9, Black Moon, New Moon, balsamic
  //   "release / complete"   -> 9, Full Moon, Last Quarter, Mirror, World-Bridger
  //   "connect / relate"     -> 2, 3, 6, Hand, Star, Human
  //   "express / create"     -> 3, 5, Monkey, Wind, Storm
  //   "see clearly / decide" -> Full Moon, Eagle, Mirror, days of clear vision
  //
  // This is intentionally a simple rule-based synth, not the Oracle. The Oracle
  // (full reading) does this with depth; this is the at-a-glance version.

  const SEAL_TO_THEME = {
    'Dragon':       'begin',
    'Wind':         'express',
    'Night':        'rest',
    'Seed':         'begin',
    'Serpent':      'release',
    'World-Bridger':'release',
    'Hand':         'connect',
    'Star':         'connect',
    'Moon':         'rest',
    'Dog':          'connect',
    'Monkey':       'express',
    'Human':        'connect',
    'Skywalker':    'begin',
    'Wizard':       'see',
    'Eagle':        'see',
    'Warrior':      'build',
    'Earth':        'build',
    'Mirror':       'see',
    'Storm':        'express',
    'Sun':          'see'
  };

  const NUM_TO_THEME = {
    1: 'begin', 2: 'connect', 3: 'express', 4: 'build', 5: 'connect',
    6: 'connect', 7: 'rest', 8: 'build', 9: 'release',
    11: 'begin', 22: 'build', 33: 'connect', 44: 'build'
  };

  const THEME_LANGUAGE = {
    'begin':   { headline: 'today is a day to start',           detail: 'fresh ground, low resistance to the new'},
    'build':   { headline: 'today is a day to build',           detail: 'structure, focus, work that compounds'},
    'connect': { headline: 'today is a day for people',         detail: 'relationships, conversations, partnership'},
    'express': { headline: 'today is a day for expression',     detail: 'voice, creativity, communication'},
    'rest':    { headline: 'today is a day to rest and receive',detail: 'inward, quieter, intuition louder than action'},
    'release': { headline: 'today is a day to complete and release', detail: 'finish what is finishing, let go cleanly'},
    'see':     { headline: 'today is a day to see clearly',     detail: 'perspective, decision, what was hidden becomes visible'}
  };

  function moonTheme(moonPhase, isBlack, isShiva){
    if (isBlack) return 'rest';
    if (isShiva) return 'begin';
    if (!moonPhase) return null;
    if (moonPhase === 'New Moon') return 'rest';
    if (moonPhase === 'Waxing Crescent') return 'begin';
    if (moonPhase === 'First Quarter') return 'build';
    if (moonPhase === 'Waxing Gibbous') return 'build';
    if (moonPhase === 'Full Moon') return 'see';
    if (moonPhase === 'Waning Gibbous') return 'release';
    if (moonPhase === 'Last Quarter') return 'release';
    if (moonPhase === 'Waning Crescent') return 'release';
    if (moonPhase === 'Balsamic') return 'rest';
    return null;
  }

  function buildConvergenceLine(d){
    if (!d || !d.dLabel) return '';
    const themes = [];

    // Numerology theme (Universal Day)
    const udTheme = NUM_TO_THEME[d.ud];
    if (udTheme) themes.push({source:'numerology', theme:udTheme, label:'Universal Day '+d.ud});

    // Dreamspell seal theme
    const sealTheme = SEAL_TO_THEME[d.seal];
    if (sealTheme) themes.push({source:'dreamspell', theme:sealTheme, label:d.seal});

    // Moon theme
    const mTheme = moonTheme(d.moonPhase, d.moonIsBlack, d.moonIsShiva);
    if (mTheme) themes.push({source:'moon', theme:mTheme, label: d.moonIsBlack?'Black Moon':d.moonIsShiva?'Shiva Moon':d.moonPhase});

    // GAP intensifies whatever is already there (does not add a theme; flagged separately)

    if (!themes.length) return '';

    // Count theme frequency
    const counts = {};
    themes.forEach(t => { counts[t.theme] = (counts[t.theme]||0) + 1; });
    const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
    const topTheme = sorted[0][0];
    const topCount = sorted[0][1];

    const sources = themes.filter(t => t.theme === topTheme).map(t => t.label);
    const lang = THEME_LANGUAGE[topTheme] || { headline: '', detail: ''};

    if (topCount >= 2) {
      // Genuine convergence
      return {
        kind: 'convergence',
        text: 'Three frameworks converge: '+lang.headline+'. '+capFirst(lang.detail)+'.',
        sources: sources,
        gap: !!d.isGAP,
        master: !!d.isMaster
      };
    } else {
      // No convergence, name the strongest single signal
      const strongest = themes[0];
      const strongLang = THEME_LANGUAGE[strongest.theme] || { headline: '', detail: ''};
      return {
        kind: 'single',
        text: 'No single theme dominates today. The strongest signal: '+strongLang.headline+' ('+strongest.label+').',
        sources: [strongest.label],
        gap: !!d.isGAP,
        master: !!d.isMaster
      };
    }
  }

  function capFirst(s){ return s ? s.charAt(0).toUpperCase()+s.slice(1) : s; }

  function escapeHtml(s){
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderConvergenceBlock(synth, d){
    if (!synth || !synth.text) return '';
    const isConv = synth.kind === 'convergence';
    const accentColor = isConv ? 'var(--gold)' : 'var(--text2)';
    const accentBg    = isConv ? 'rgba(201,160,80,0.07)' : 'rgba(255,255,255,0.02)';
    const accentBorder= isConv ? 'rgba(201,160,80,0.30)' : 'var(--div)';
    const intro = isConv ? '&#10026; Convergence' : '&#9678; Day signal';
    const sourcesLine = synth.sources && synth.sources.length
      ? '<div style="font-size:11px;color:var(--text3);margin-top:6px;letter-spacing:.04em">via '+synth.sources.map(escapeHtml).join(' &middot; ')+'</div>'
      : '';
    const flagsLine = (synth.gap || synth.master)
      ? '<div style="font-size:11px;color:var(--teal);margin-top:6px;letter-spacing:.04em">'
        +(synth.gap   ? '&#9733; Galactic Activation Portal: synchronicities amplified.' : '')
        +(synth.master? (synth.gap?' &nbsp;':'')+'&#9733; Master Number day: portals open.' : '')
        +'</div>'
      : '';
    return ''
      + '<div style="background:'+accentBg+';border:1px solid '+accentBorder+';border-left:3px solid '+accentColor+';border-radius:4px;padding:13px 16px;margin-bottom:14px">'
      +   '<div style="font-size:11px;letter-spacing:.20em;text-transform:uppercase;color:'+accentColor+';margin-bottom:6px">'+intro+'</div>'
      +   '<div style="font-size:14px;color:var(--text);line-height:1.55">'+escapeHtml(synth.text)+'</div>'
      +   sourcesLine
      +   flagsLine
      + '</div>';
  }

  // Hook: observes the day modal opening and injects the convergence block.
  // We wrap the existing openDayModal so we do not mutate the original code.
  function installConvergenceHook(){
    if (typeof window.openDayModal !== 'function') return;
    if (window.openDayModal._cdpEnhanced) return;
    const original = window.openDayModal;
    window.openDayModal = function(ds){
      original(ds);
      // After the modal renders, inject the convergence block at the top of the
      // capture zone (immediately after any moon alert).
      try {
        const cap = document.getElementById('dayCardCapture');
        if (!cap) return;
        if (cap.querySelector('.cdp-convergence')) return;
        const synth = buildConvergenceLine(window._dayModalData || {});
        if (!synth) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'cdp-convergence';
        wrapper.innerHTML = renderConvergenceBlock(synth, window._dayModalData || {});
        // Insert after the moon alert if present, else as first child
        const moonAlert = cap.querySelector('div[style*="border-radius:4px"]');
        if (moonAlert && moonAlert.previousSibling === null) {
          moonAlert.parentNode.insertBefore(wrapper, moonAlert.nextSibling);
        } else {
          cap.insertBefore(wrapper, cap.firstChild);
        }
      } catch(e){ /* fail silent in production */ }
    };
    window.openDayModal._cdpEnhanced = true;
  }

  // ── 3. TRANSIT MARKERS (scaffold only) ─────────────────────────────────────
  // Wire-up for major Western transits (Saturn ingresses, Jupiter ingresses,
  // outer-planet stations, eclipses, Mercury retrograde stations).
  //
  // Today this is a stub. To go live, the server populates window.CDP_TRANSITS
  // from Swiss Ephemeris with entries of the form:
  //   { date: 'YYYY-MM-DD', kind: 'eclipse'|'station-retro'|'station-direct'|'ingress', body: 'Saturn', sign: 'Aries', label: 'Saturn enters Aries' }
  // The function below adds a small badge to any calendar day that has an
  // entry. Until the table is populated this is a no-op.

  window.CDP_TRANSITS = window.CDP_TRANSITS || [];

  function transitBadgeFor(ds){
    const matches = (window.CDP_TRANSITS||[]).filter(t => t.date === ds);
    if (!matches.length) return '';
    // Compact badge: one icon per kind, max 2 displayed
    const ICON = {
      'eclipse':         '\u26AB',  // black circle
      'station-retro':   '\u211E',  // R script (used colloquially)
      'station-direct':  '\u2192',  // right arrow
      'ingress':         '\u26A1',  // lightning, ingress = sign change
      'aspect-major':    '\u2737'   // 8-spoked
    };
    const labels = matches.slice(0,2).map(m => (ICON[m.kind]||'\u2737')+' '+(m.label||m.body||''));
    return '<span class="cal-mini-badge cdp-transit-badge" title="'+escapeHtml(matches.map(m=>m.label||m.body||'').join(' / '))+'" style="background:rgba(80,140,200,0.10);color:#7aa8d8;border:1px solid rgba(80,140,200,0.30);font-size:9px">'+escapeHtml(labels.join(' '))+'</span>';
  }

  // Hook into renderCalendar: after it runs, walk each cal-day and append a
  // transit badge if one exists. Idempotent.
  function installTransitOverlay(){
    if (typeof window.renderCalendar !== 'function') return;
    if (window.renderCalendar._cdpEnhanced) return;
    const original = window.renderCalendar;
    window.renderCalendar = function(){
      original.apply(this, arguments);
      try {
        if (!(window.CDP_TRANSITS||[]).length) return;
        const grid = document.getElementById('calGrid');
        if (!grid) return;
        // Determine which month is currently rendered
        const monthLabelEl = document.getElementById('calMonthLabel');
        if (!monthLabelEl) return;
        const days = grid.querySelectorAll('.cal-day');
        // We do not have direct access to calMonth/calYear here, but the
        // renderCalendar above sets onclick="openDayModal('YYYY-MM-DD')". Use
        // that string to identify the date for each cell.
        days.forEach(cell => {
          const click = cell.getAttribute('onclick')||'';
          const match = click.match(/openDayModal\('(\d{4}-\d{2}-\d{2})'\)/);
          if (!match) return;
          const ds = match[1];
          const badgesContainer = cell.querySelector('.cal-badges');
          if (!badgesContainer) return;
          const badge = transitBadgeFor(ds);
          if (badge && !badgesContainer.querySelector('.cdp-transit-badge')) {
            badgesContainer.insertAdjacentHTML('beforeend', badge);
          }
        });
      } catch(e){ /* fail silent */ }
    };
    window.renderCalendar._cdpEnhanced = true;
  }

  // ── BOOT ───────────────────────────────────────────────────────────────────
  function boot(){
    installExpandedLegend();
    installConvergenceHook();
    installTransitOverlay();
    // Re-trigger calendar render now that the overlay is installed
    if (typeof window.renderCalendar === 'function') {
      try { window.renderCalendar(); } catch(e){}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    // DOM already ready (script loaded at end of body)
    boot();
  }

})();

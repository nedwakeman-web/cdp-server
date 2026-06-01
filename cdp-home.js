/* ============================================================================
   CDP Home: the comprehensive two-drawer home surface
   ----------------------------------------------------------------------------
   Self contained and self mounting. Replaces cdp-home-drawers.js.

   Mount: drop this file into the alpha frontend at public/cdp-home.js and add
   one line before the closing body tag of app.html:

       <script src="/cdp-home.js"></script>

   What it builds, matched to the Five Year Home mockup:
     Left drawer  "Vault and patterns": What is live now, Patterns emerging,
       Seasonal maps, This is working, Calendar.
     Right drawer "People and reach":  Today and your reading, Daily card,
       The year and long view, Family oracles (profiles), Compatibility,
       Connected sources, Shared family context, The Vault. Plus an account
       footer (Guide, Tiers, Streak, Feedback, Share, Sign in) under which the
       updated Guide lives.

   Every module is draggable and reorderable, with order remembered per drawer
   in localStorage, plus up and down controls, exactly as the mockup shows.

   Two readiness tiers, kept honest:
     Built features are launchers into the real screens through the app own
       global handlers (showScreen, renderCard, initCompatScreen, and so on),
       feature detected, with a click by label fallback.
     Unbuilt features (connected sources, family sharing, the pattern and
       seasonal and this-is-working analytics) render an honest invitational
       state that fills only from real data. The mockup numbers are year five
       illustrations and are never hardcoded for a real user.

   Namespaced cdph, literal colours, so it cannot touch app.html styles.
   House style: no em or en dashes, no user visible exclamations.
   ========================================================================== */
(function () {
  'use strict';

  if (window.__cdpHomeMounted) return;
  window.__cdpHomeMounted = true;

  var NAVY = '#0A1828';
  var GOLD = '#C9A050';
  var GOLD_SOFT = '#E8C878';
  var GOLD_LINE = 'rgba(201,160,80,0.18)';
  var TEXT_LIGHT = '#F0E6CC';
  var TEXT_MUTED = '#C8BAA0';
  var TEXT_DIM = 'rgba(201,186,160,0.55)';
  var TEAL = '#1D9E75';

  /* ----- styles ----- */
  function injectStyle() {
    if (document.getElementById('cdph-style')) return;
    var css = [
      '.cdph-handle{position:fixed;top:50%;transform:translateY(-50%);z-index:430;width:27px;height:auto;min-height:120px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:' + GOLD + ';background:#122440;border:1px solid ' + GOLD + ';padding:16px 4px;font-family:Georgia,serif;transition:color .2s,border-color .2s,background .2s;}',
      '.cdph-handle:hover{color:' + GOLD_SOFT + ';background:#16294a;}',
      '.cdph-handle span{writing-mode:vertical-rl;text-orientation:mixed;font-size:10.5px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;white-space:nowrap;}',
      '.cdph-handle-left{left:0;border-left:none;border-radius:0 3px 3px 0;}',
      '.cdph-handle-right{right:0;border-right:none;border-radius:3px 0 0 3px;}',
      '.cdph-handle-right span{transform:rotate(180deg);}',
      '.cdph-drawer{position:fixed;top:0;bottom:0;width:344px;max-width:90vw;background:' + NAVY + ';z-index:460;overflow-y:auto;padding:64px 16px 40px;transition:transform .28s ease;box-shadow:0 0 44px rgba(0,0,0,0.5);font-family:Georgia,serif;color:' + TEXT_LIGHT + ';font-size:14px;line-height:1.55;box-sizing:border-box;}',
      '.cdph-drawer-left{left:0;border-right:1px solid ' + GOLD_LINE + ';transform:translateX(-100%);}',
      '.cdph-drawer-right{right:0;border-left:1px solid ' + GOLD_LINE + ';transform:translateX(100%);}',
      '.cdph-drawer.cdph-open{transform:translateX(0);}',
      '.cdph-drawer-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}',
      '.cdph-drawer-title{font-size:11px;letter-spacing:2px;color:' + GOLD + ';text-transform:uppercase;}',
      '.cdph-drawer-close{background:transparent;border:1px solid ' + TEXT_DIM + ';color:' + TEXT_MUTED + ';width:26px;height:26px;border-radius:2px;cursor:pointer;font-family:inherit;line-height:1;}',
      '.cdph-module{border:1px solid ' + GOLD_LINE + ';border-radius:3px;margin-bottom:11px;background:rgba(13,30,51,0.32);}',
      '.cdph-module.cdph-dragging{opacity:0.45;}',
      '.cdph-module-head{display:flex;align-items:center;gap:8px;padding:8px 11px;border-bottom:1px solid ' + GOLD_LINE + ';}',
      '.cdph-grip{cursor:grab;color:' + TEXT_DIM + ';font-size:10px;letter-spacing:1px;text-transform:uppercase;user-select:none;}',
      '.cdph-module-name{flex:1;font-size:11px;letter-spacing:1px;color:' + GOLD + ';text-transform:uppercase;}',
      '.cdph-move{background:transparent;border:none;color:' + TEXT_DIM + ';cursor:pointer;font-size:11px;padding:0 3px;font-family:inherit;}',
      '.cdph-move:hover{color:' + GOLD + ';}',
      '.cdph-module-body{padding:11px 13px;}',
      '.cdph-item{padding:7px 0;border-bottom:1px solid rgba(201,160,80,0.08);}',
      '.cdph-item:last-child{border-bottom:none;}',
      '.cdph-item-title{color:' + TEXT_LIGHT + ';font-size:13px;}',
      '.cdph-item-meta{color:' + TEXT_DIM + ';font-size:11px;margin-top:2px;}',
      '.cdph-soft{color:' + TEXT_MUTED + ';font-size:13px;}',
      '.cdph-dim{color:' + TEXT_DIM + ';font-size:12px;font-style:italic;margin-top:7px;}',
      '.cdph-opp{font-size:12px;color:' + TEXT_MUTED + ';padding:8px 10px;background:rgba(29,158,117,0.08);border-left:2px solid ' + TEAL + ';border-radius:2px;margin-top:8px;}',
      '.cdph-btn{display:inline-block;margin-top:9px;padding:8px 16px;background:' + GOLD + ';color:' + NAVY + ';border:none;font-size:11px;font-weight:600;letter-spacing:1px;cursor:pointer;border-radius:2px;font-family:Georgia,serif;}',
      '.cdph-btn:hover{background:' + GOLD_SOFT + ';}',
      '.cdph-btn-ghost{background:transparent;color:' + TEXT_LIGHT + ';border:1px solid ' + GOLD_LINE + ';}',
      '.cdph-btn + .cdph-btn{margin-left:7px;}',
      '.cdph-mirror{margin-top:13px;padding:12px 14px;border:1px solid ' + GOLD_LINE + ';border-radius:3px;background:rgba(201,160,80,0.06);font-size:13px;color:' + TEXT_LIGHT + ';}',
      '.cdph-account{margin-top:18px;padding-top:14px;border-top:1px solid ' + GOLD_LINE + ';}',
      '.cdph-account-title{font-size:10px;letter-spacing:2px;color:' + TEXT_DIM + ';text-transform:uppercase;margin-bottom:9px;}',
      '.cdph-account-row{display:flex;flex-wrap:wrap;gap:8px;}',
      '.cdph-account-link{background:transparent;border:1px solid ' + GOLD_LINE + ';color:' + TEXT_MUTED + ';font-size:11px;letter-spacing:.5px;padding:6px 11px;border-radius:2px;cursor:pointer;font-family:Georgia,serif;}',
      '.cdph-account-link:hover{color:' + GOLD + ';border-color:' + GOLD + ';}',
      '.cdph-scrim{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:450;opacity:0;pointer-events:none;transition:opacity .25s;}',
      '.cdph-scrim.cdph-on{opacity:1;pointer-events:auto;}',
      '.cdph-overlay{position:fixed;inset:0;z-index:560;display:flex;align-items:flex-start;justify-content:center;background:rgba(0,0,0,0.6);opacity:0;pointer-events:none;transition:opacity .25s;overflow-y:auto;padding:40px 16px;}',
      '.cdph-overlay.cdph-on{opacity:1;pointer-events:auto;}',
      '.cdph-overlay-card{width:min(94vw,760px);background:' + NAVY + ';border:1px solid ' + GOLD_LINE + ';border-radius:4px;box-shadow:0 18px 70px rgba(0,0,0,0.6);padding:30px 30px 36px;position:relative;font-family:Georgia,serif;color:' + TEXT_LIGHT + ';}',
      '.cdph-overlay-close{position:absolute;top:16px;right:18px;background:transparent;border:1px solid ' + TEXT_DIM + ';color:' + TEXT_MUTED + ';width:30px;height:30px;border-radius:2px;cursor:pointer;font-family:inherit;line-height:1;}',
      '.cdph-g h2{font-size:18px;color:' + GOLD + ';font-weight:400;letter-spacing:.5px;margin:0 0 4px;}',
      '.cdph-g .cdph-g-lead{color:' + TEXT_MUTED + ';font-style:italic;margin:0 0 22px;}',
      '.cdph-g h3{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:' + GOLD + ';margin:22px 0 7px;}',
      '.cdph-g p{color:' + TEXT_MUTED + ';font-size:13.5px;line-height:1.65;margin:0 0 10px;}',
      '.cdph-g strong{color:' + TEXT_LIGHT + ';}',
      '.cdph-g .cdph-g-row{color:' + TEXT_MUTED + ';font-size:13px;line-height:1.6;margin:0 0 6px;}'
    ].join('\n');
    var s = document.createElement('style');
    s.id = 'cdph-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ----- small helpers ----- */
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function escapeHtml(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function relDate(iso) {
    try {
      if (!iso) return '';
      var then = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
      var now = new Date();
      var d0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      var diff = Math.round((d0 - then.getTime()) / 86400000);
      if (isNaN(diff)) return '';
      if (diff <= 0) return 'today';
      if (diff === 1) return 'yesterday';
      if (diff < 7) return diff + ' days ago';
      return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    } catch (e) { return ''; }
  }
  function signedIn() {
    try { return !!(window.currentUser && window.currentUser.id); } catch (e) { return false; }
  }
  function heldItems() {
    try {
      if (window.cdpThreadsAPI && typeof window.cdpThreadsAPI.active === 'function') {
        return (window.cdpThreadsAPI.active() || []).filter(function (t) { return t && t.label; });
      }
    } catch (e) {}
    return [];
  }

  /* ----- navigation into the real app screens, feature detected ----- */
  function call(fn) {
    try { if (typeof window[fn] === 'function') { window[fn].apply(null, Array.prototype.slice.call(arguments, 1)); return true; } } catch (e) {}
    return false;
  }
  function clickByText(text) {
    var want = String(text).trim().toLowerCase();
    var nodes = document.querySelectorAll('.quiet-menu-item, .npill, button, a');
    for (var i = 0; i < nodes.length; i++) {
      var tx = (nodes[i].textContent || '').trim().toLowerCase();
      if (tx === want || tx.indexOf(want) === 0) { try { nodes[i].click(); return true; } catch (e) {} }
    }
    return false;
  }
  function nav(screen, after, fallbackLabel) {
    closeAll();
    var ok = call('showScreen', screen, null);
    if (ok && after) call(after);
    if (!ok && fallbackLabel) clickByText(fallbackLabel);
  }
  function openToday() {
    closeAll();
    try {
      var input = document.getElementById('v19Intention');
      if (input) { input.scrollIntoView({ behavior: 'smooth', block: 'center' }); input.focus(); return; }
    } catch (e) {}
    if (!call('showScreen', 'scompass', null)) clickByText('Compass');
  }

  /* ----- module definitions ----- */
  // Each: { id, side, name, render(bodyEl) }. Order is user controlled.
  var MODULES = [
    // LEFT, Vault and patterns
    {
      id: 'live', side: 'left', name: 'What is live now',
      render: function (b) {
        var items = heldItems();
        if (!items.length) {
          b.innerHTML =
            '<p class="cdph-soft"><strong>Nothing held yet.</strong></p>' +
            '<p class="cdph-soft">When you keep a question or set an intention, it lives here. Over time these gather into themes, and the mirror reflects your direction back to you, honestly, from your own data.</p>';
          return;
        }
        var h = '';
        items.slice(0, 10).forEach(function (t) {
          var when = relDate(t.date);
          h += '<div class="cdph-item"><div class="cdph-item-title">' + escapeHtml(t.label) + '</div>' +
            (when ? '<div class="cdph-item-meta">Set ' + escapeHtml(when) + '</div>' : '') + '</div>';
        });
        h += '<div class="cdph-mirror">The mirror reflects the direction you set, from your own readings. It names plainly when something you are holding is not moving.</div>';
        b.innerHTML = h;
      }
    },
    {
      id: 'patterns', side: 'left', name: 'Patterns emerging',
      render: function (b) {
        b.innerHTML =
          '<p class="cdph-soft">Patterns appear here once you have enough readings for them to be real, drawn from your own readings and the outcomes you record, never a forecast.</p>' +
          '<p class="cdph-dim">Nothing invented. This fills as you live the days.</p>';
      }
    },
    {
      id: 'seasonal', side: 'left', name: 'Seasonal maps',
      render: function (b) {
        b.innerHTML =
          '<p class="cdph-soft">As a year of readings accumulates, the seasons of your own rhythm take shape here, which stretches tend to growth and which to consolidation.</p>' +
          '<p class="cdph-dim">Built only from the days you keep.</p>';
      }
    },
    {
      id: 'working', side: 'left', name: 'This is working',
      render: function (b) {
        b.innerHTML =
          '<p class="cdph-soft">When you resolve an intention and mark how it went, it is counted here, so you can see what is moving and what has gone quiet.</p>' +
          '<p class="cdph-dim">No manufactured progress. Real entries only.</p>';
      }
    },
    {
      id: 'calendar', side: 'left', name: 'Calendar',
      render: function (b) {
        b.innerHTML =
          '<p class="cdph-soft">The month at a glance: Kin, moon phase, portal days, master number days, and the Black and Shiva Moon windows, so you can plan ahead.</p>';
        var btn = el('button', 'cdph-btn', 'Open the calendar');
        btn.type = 'button';
        btn.addEventListener('click', function () { nav('sc', null, 'Calendar'); });
        b.appendChild(btn);
      }
    },

    // RIGHT, People and reach
    {
      id: 'today', side: 'right', name: 'Today and your reading',
      render: function (b) {
        b.innerHTML = '<p class="cdph-soft">Open the day, set a line if it helps you focus, and let the compass meet you. The full reading carries all four frameworks in three voices.</p>';
        var t = el('button', 'cdph-btn', 'Open today');
        t.type = 'button';
        t.addEventListener('click', openToday);
        var r = el('button', 'cdph-btn cdph-btn-ghost', 'Full reading');
        r.type = 'button';
        r.addEventListener('click', function () { nav('sr', null, 'Reading'); });
        b.appendChild(t); b.appendChild(r);
      }
    },
    {
      id: 'card', side: 'right', name: 'Daily card',
      render: function (b) {
        b.innerHTML = '<p class="cdph-soft">A single shareable card with the day synthesis: personal day, moon, Kin, and life path.</p>';
        var btn = el('button', 'cdph-btn', 'Open the card');
        btn.type = 'button';
        btn.addEventListener('click', function () { nav('scard', 'renderCard', 'Daily Card'); });
        b.appendChild(btn);
      }
    },
    {
      id: 'year', side: 'right', name: 'The year, the long view',
      render: function (b) {
        b.innerHTML = '<p class="cdph-soft">Your cosmic context: the year, your fixed signature, and the slow planetary background. Read once, return when something shifts. Distinct from the patterns emerging on the left.</p>';
        var btn = el('button', 'cdph-btn', 'Open the long view');
        btn.type = 'button';
        btn.addEventListener('click', function () { nav('sctx', null, 'My Year'); });
        b.appendChild(btn);
      }
    },
    {
      id: 'profiles', side: 'right', name: 'Family oracles',
      render: function (b) {
        b.innerHTML =
          '<p class="cdph-soft">The people you keep on record. Save a profile, recall it before a reading, and the Oracle speaks to that person. Each oracle is private by default.</p>' +
          (signedIn() ? '' : '<p class="cdph-dim">Sign in to keep profiles across your devices.</p>');
        var btn = el('button', 'cdph-btn', 'Open profiles');
        btn.type = 'button';
        btn.addEventListener('click', function () { nav('sp', null, 'Profiles'); });
        b.appendChild(btn);
      }
    },
    {
      id: 'compat', side: 'right', name: 'Compatibility',
      render: function (b) {
        b.innerHTML = '<p class="cdph-soft">Read two signatures together across charts, numerology, and Dreamspell Kin. Pull from your saved profiles, or add someone new and save them.</p>';
        var btn = el('button', 'cdph-btn', 'Open compatibility');
        btn.type = 'button';
        btn.addEventListener('click', function () { nav('scompat', 'initCompatScreen', 'Compatibility'); });
        b.appendChild(btn);
      }
    },
    {
      id: 'sources', side: 'right', name: 'Connected sources',
      render: function (b) {
        b.innerHTML =
          '<p class="cdph-soft">In time, your calendar, your wearables, and the contexts you choose can feed the reading, only ever to add context, never to drive it.</p>' +
          '<p class="cdph-dim">Not yet connected. This arrives as the integrations are built.</p>';
      }
    },
    {
      id: 'shared', side: 'right', name: 'Shared family context',
      render: function (b) {
        b.innerHTML =
          '<p class="cdph-soft">A family can choose to share the few things that matter to all of them, a move, a season of care, a shared plan, shared only when everyone opts in.</p>' +
          '<p class="cdph-dim">Not yet built. Sharing will always be opt in.</p>';
      }
    },
    {
      id: 'vault', side: 'right', name: 'The Vault',
      render: function (b) {
        b.innerHTML =
          '<p class="cdph-soft">Every reading the Oracle has given you, kept and reopenable. As it grows it becomes searchable by keyword, theme, person, and season.</p>' +
          '<p class="cdph-dim">The one asset that cannot be copied, only grown.</p>';
        var btn = el('button', 'cdph-btn', 'Open your readings');
        btn.type = 'button';
        btn.addEventListener('click', function () { nav('shist', null, 'History'); });
        b.appendChild(btn);
      }
    }
  ];

  /* ----- order persistence ----- */
  function defaultOrder(side) {
    return MODULES.filter(function (m) { return m.side === side; }).map(function (m) { return m.id; });
  }
  function loadOrder(side) {
    var def = defaultOrder(side);
    try {
      var raw = localStorage.getItem('cdph_order_' + side);
      if (!raw) return def;
      var saved = JSON.parse(raw);
      if (!Array.isArray(saved)) return def;
      var ordered = saved.filter(function (id) { return def.indexOf(id) !== -1; });
      def.forEach(function (id) { if (ordered.indexOf(id) === -1) ordered.push(id); });
      return ordered;
    } catch (e) { return def; }
  }
  function saveOrder(side) {
    try {
      var cont = containers[side];
      if (!cont) return;
      var ids = Array.prototype.map.call(cont.querySelectorAll('.cdph-module'), function (n) { return n.getAttribute('data-id'); });
      localStorage.setItem('cdph_order_' + side, JSON.stringify(ids));
    } catch (e) {}
  }

  /* ----- module node + drag and drop + up/down ----- */
  function moduleById(id) {
    for (var i = 0; i < MODULES.length; i++) { if (MODULES[i].id === id) return MODULES[i]; }
    return null;
  }
  function buildModuleNode(mod, side) {
    var node = el('section', 'cdph-module');
    node.setAttribute('data-id', mod.id);
    node.setAttribute('draggable', 'true');
    var head = el('div', 'cdph-module-head');
    head.appendChild(el('span', 'cdph-grip', 'drag'));
    head.appendChild(el('span', 'cdph-module-name', escapeHtml(mod.name)));
    var up = el('button', 'cdph-move', 'up'); up.type = 'button';
    var down = el('button', 'cdph-move', 'down'); down.type = 'button';
    up.addEventListener('click', function () { moveNode(node, -1, side); });
    down.addEventListener('click', function () { moveNode(node, 1, side); });
    head.appendChild(up); head.appendChild(down);
    node.appendChild(head);
    var body = el('div', 'cdph-module-body');
    node.appendChild(body);
    try { mod.render(body); } catch (e) { body.innerHTML = '<p class="cdph-dim">This module is taking a moment.</p>'; }

    node.addEventListener('dragstart', function (e) {
      dragId = mod.id; node.classList.add('cdph-dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', mod.id); } catch (err) {}
    });
    node.addEventListener('dragend', function () {
      node.classList.remove('cdph-dragging'); dragId = null; saveOrder(side);
    });
    node.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (!dragId || dragId === mod.id) return;
      var cont = containers[side];
      var dragged = cont.querySelector('.cdph-module[data-id="' + dragId + '"]');
      if (!dragged) return;
      var rect = node.getBoundingClientRect();
      var after = (e.clientY - rect.top) > rect.height / 2;
      if (after) { if (node.nextSibling !== dragged) cont.insertBefore(dragged, node.nextSibling); }
      else { if (node.previousSibling !== dragged) cont.insertBefore(dragged, node); }
    });
    return node;
  }
  function moveNode(node, dir, side) {
    var cont = containers[side];
    if (dir < 0 && node.previousElementSibling) cont.insertBefore(node, node.previousElementSibling);
    else if (dir > 0 && node.nextElementSibling) cont.insertBefore(node.nextElementSibling, node);
    saveOrder(side);
  }

  /* ----- drawers, scrim, handles ----- */
  var drawers = {};
  var containers = {};
  var scrim = null;
  var dragId = null;

  function refreshScrim() {
    var open = (drawers.left && drawers.left.classList.contains('cdph-open')) ||
               (drawers.right && drawers.right.classList.contains('cdph-open'));
    if (scrim) scrim.classList.toggle('cdph-on', open);
  }
  function openDrawer(side) {
    closeAll();
    if (drawers[side]) { drawers[side].classList.add('cdph-open'); cdpHomeRefresh(); }
    refreshScrim();
  }
  function closeAll() {
    if (drawers.left) drawers.left.classList.remove('cdph-open');
    if (drawers.right) drawers.right.classList.remove('cdph-open');
    refreshScrim();
  }

  function renderDrawerModules(side) {
    var cont = containers[side];
    cont.innerHTML = '';
    loadOrder(side).forEach(function (id) {
      var mod = moduleById(id);
      if (mod) cont.appendChild(buildModuleNode(mod, side));
    });
  }

  function buildAccountFooter() {
    var foot = el('div', 'cdph-account');
    foot.appendChild(el('div', 'cdph-account-title', 'Account'));
    var row = el('div', 'cdph-account-row');
    var links = [
      { label: 'Guide', fn: function () { openGuide(); } },
      { label: 'Tiers', fn: function () { closeAll(); if (!call('showTierOverview')) clickByText('Tiers'); } },
      { label: 'Streak', fn: function () { nav('sstreak', null, 'Streak'); } },
      { label: 'Feedback', fn: function () { closeAll(); clickByText('Feedback'); } },
      { label: 'Share and invite', fn: function () { closeAll(); clickByText('Share'); } },
      { label: signedIn() ? 'Account' : 'Sign in', fn: function () { closeAll(); if (!call('openAuth')) clickByText('Sign In'); } }
    ];
    links.forEach(function (l) {
      var btn = el('button', 'cdph-account-link', escapeHtml(l.label));
      btn.type = 'button';
      btn.addEventListener('click', l.fn);
      row.appendChild(btn);
    });
    foot.appendChild(row);
    return foot;
  }

  function buildDrawer(side, title) {
    var d = el('aside', 'cdph-drawer cdph-drawer-' + side);
    d.setAttribute('data-side', side);
    var top = el('div', 'cdph-drawer-top');
    top.appendChild(el('div', 'cdph-drawer-title', escapeHtml(title)));
    var close = el('button', 'cdph-drawer-close', '&times;');
    close.type = 'button'; close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', closeAll);
    top.appendChild(close);
    d.appendChild(top);
    var cont = el('div', 'cdph-modules');
    containers[side] = cont;
    d.appendChild(cont);
    renderDrawerModules(side);
    if (side === 'right') d.appendChild(buildAccountFooter());
    return d;
  }
  function buildHandle(side, label) {
    var h = el('button', 'cdph-handle cdph-handle-' + side, '<span>' + escapeHtml(label) + '</span>');
    h.type = 'button'; h.setAttribute('aria-label', label);
    h.addEventListener('click', function () {
      var open = drawers[side] && drawers[side].classList.contains('cdph-open');
      if (open) closeAll(); else openDrawer(side);
    });
    return h;
  }

  /* ----- the Guide overlay (updated content, lives under the account) ----- */
  var GUIDE_HTML =
    '<div class="cdph-g">' +
    '<h2>Two telescopes. Pointed at the same sky.</h2>' +
    '<p class="cdph-g-lead">Cosmic Daily Planner is a place where ancient frameworks and modern neuroscience meet. Numerology, Western astrology, Mayan calendrics, and lunar cycles, sitting alongside circadian cognition, predictive processing, attachment, and default mode network research. They arrive at the same coordinates. CDP shows you both, in the language you prefer.</p>' +

    '<h3>1. The morning compass</h3>' +
    '<p>Your daily check in before any full reading. Three tiles at the top of the day: Kin, the Dreamspell signature with a star when it is a Galactic Activation Portal; Moon, the lunar phase with Black Moon and Shiva Moon flags when they apply; and your Personal Day, calculated from your birth date. Tap any tile for a quick Oracle drawer in your current voice. Below the tiles is a single intention input. Type a focus for today, even one phrase, and tomorrow the reading references it.</p>' +

    '<h3>2. Three voices</h3>' +
    '<p>Every reading section is written in three voices, toggled at the top of any reading. <strong>Tradition</strong> is symbolic and archetypal, the language of millennia of reflection. <strong>Science</strong> is mechanistic and causal, grounded in circadian cognition, the default mode network, interoception, predictive processing, attachment, and consolidation. <strong>Everyday</strong> is plain spoken, the language of a smart friend who happens to know what your day is asking for. Open more than one at once. See the same insight through different lenses without losing your place.</p>' +

    '<h3>3. The tabs</h3>' +
    '<p>Reading, your full daily Oracle across four frameworks in three voices. Daily Card, a single shareable card. Calendar, the month with Kin, moon phases, portals, master numbers, and the Black and Shiva windows, with the Best Day finder at the top. My Energy, your personal numerology and signature. Compatibility, a second person read across all frameworks. Profile, your birth details and context, which makes the Oracle more specific. History, your past readings, tap any to reopen.</p>' +

    '<h3>4. Reading depths</h3>' +
    '<p><strong>Free</strong>, the universal day, moon, and Kin, instant. <strong>Seeker</strong>, all four frameworks, priorities, shadow, the week ahead. <strong>Initiate</strong>, Seeker plus the monthly arc, lunation map, and wavespell. <strong>Mystic</strong>, natal chart integration, the yearly arc, transit themes. <strong>Oracle</strong>, maximum depth, all frameworks, Hellenistic lots, biorhythms, hormonal phase.</p>' +

    '<h3>5. Special days</h3>' +
    '<p>Portal, a Galactic Activation Portal, 52 such Kins per 260 day cycle. Black Moon, two days before the new moon, a liminal threshold to complete and release rather than initiate. Shiva Moon, two days after the new moon, generative and fertile, auspicious for fresh starts. Master number days, 11, 22, 33, 44, a heightened frequency. A 9 day for completion. A 7 day for reflection.</p>' +

    '<h3>6. Memory and continuity</h3>' +
    '<p>CDP is built to remember. The reading is in conversation with yesterday and the day before. When you write an intention into the Compass, the next reading references it, and the Yesterday thread panel appears at the top. When you are signed in, your intentions are saved to a private store scoped only to you and survive across devices. Anonymous use keeps your data to the session.</p>' +

    '<h3>7. Profiles</h3>' +
    '<p>Save multiple people, family, friends, colleagues. Switch the active profile before a reading to receive it for that person, and use Compatibility to read two together. The more context you add, the more specific the Oracle becomes. It speaks to your actual life, not a generic one.</p>' +

    '<h3>8. Asking the Oracle</h3>' +
    '<p>Tap any section heading or card in a reading to open a follow up. Pre built chips suggest common questions, or type your own. The Oracle answers in your current voice and references your full reading context.</p>' +

    '<h3>9. Pick a day</h3>' +
    '<p>Open the Calendar. Each day shows badges for Kin, moon phase, portal, and master numbers. Tap any day to see its energy and open a reading for it. The Best Day finder takes what you are planning and returns the most favourable day in the next month, with reasons specific to your numerology and the cosmic weather.</p>' +

    '<h3>10. A suggested daily flow</h3>' +
    '<p>Morning, open the Compass, tap a tile if anything calls, type one line of intention, then generate a reading if you have time. Midday, return to it and read the afternoon pacing, and try a different voice if the morning one feels stale. Evening, scroll to the reflection and close the day, the Oracle remembers what you wrote in the morning.</p>' +

    '<h3>11. Sources and integrity</h3>' +
    '<p>Astronomical positions from the Swiss Ephemeris and JPL Horizons. Maya scholarship from Sprajc, Inomata and Aveni 2023, and Aldana 2022, with Dreamspell always labelled as Arguelles 1987, a twentieth century system distinct from the ancient Kiche Maya tradition. Western astrology from Tarnas, Greene, Hand, Brennan. Numerology from Drayer and Kahn. Neuroscience from Cajochen and Schmidt, Raichle, Barrett, Walker, Clark. Every factual claim traces to a named authority. Symbolic claims are labelled as symbolic.</p>' +

    '<h3>12. What CDP is and is not</h3>' +
    '<p>It is a wellness and self knowledge companion, integrating ancient frameworks with modern neuroscience to give you the texture of your day in the language you choose. It is not a medical product, therapist, or doctor, and not a substitute for professional advice. If you are in crisis or need clinical support, please reach out to a qualified professional. UK, Samaritans 116 123, free and 24 hours, or NHS 111. US, 988 Suicide and Crisis Lifeline.</p>' +
    '<p class="cdph-g-lead" style="margin-top:22px">Two telescopes. Pointed at the same sky.</p>' +
    '</div>';

  var overlay = null;
  function openGuide() {
    closeAll();
    if (!overlay) {
      overlay = el('div', 'cdph-overlay');
      var card = el('div', 'cdph-overlay-card', GUIDE_HTML);
      var close = el('button', 'cdph-overlay-close', '&times;');
      close.type = 'button'; close.setAttribute('aria-label', 'Close');
      close.addEventListener('click', closeGuide);
      card.insertBefore(close, card.firstChild);
      overlay.appendChild(card);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) closeGuide(); });
      document.body.appendChild(overlay);
    }
    requestAnimationFrame(function () { overlay.classList.add('cdph-on'); });
  }
  function closeGuide() { if (overlay) overlay.classList.remove('cdph-on'); }

  /* ----- refresh data-bearing modules in place, order preserved ----- */
  function cdpHomeRefresh() {
    ['left', 'right'].forEach(function (side) {
      var cont = containers[side];
      if (!cont) return;
      Array.prototype.forEach.call(cont.querySelectorAll('.cdph-module'), function (node) {
        var mod = moduleById(node.getAttribute('data-id'));
        var body = node.querySelector('.cdph-module-body');
        if (mod && body) { try { mod.render(body); } catch (e) {} }
      });
    });
  }
  window.cdpHomeRefresh = cdpHomeRefresh;

  /* ----- mount ----- */
  function mount() {
    injectStyle();
    drawers.left = buildDrawer('left', 'Vault and patterns');
    drawers.right = buildDrawer('right', 'People and readings');
    scrim = el('div', 'cdph-scrim');
    scrim.addEventListener('click', closeAll);

    document.body.appendChild(buildHandle('left', 'Vault and patterns'));
    document.body.appendChild(buildHandle('right', 'People and readings'));
    document.body.appendChild(drawers.left);
    document.body.appendChild(drawers.right);
    document.body.appendChild(scrim);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeGuide(); closeAll(); }
    });
    try { document.addEventListener('cdp:reading-ready', cdpHomeRefresh); } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();

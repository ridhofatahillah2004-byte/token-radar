// Token Launch Radar — renders window.RADAR (written by main.ts) as a board,
// a filter and a detail view. No network: every value comes from data.js.
// Deep links for screenshots: ?q=text, ?cat=Category, ?wl=1 (watchlist only),
// ?sort=rank|tvl|change|age, ?slug=protocol-slug (detail view).

(function () {
  'use strict';

  var data = window.RADAR;
  var box = document.getElementById('rows');
  if (!data || !data.rows) {
    box.innerHTML = '<tr><td colspan="8">No radar data found. Run main.ts first.</td></tr>';
    return;
  }

  var rows = data.rows;
  var params = new URLSearchParams(window.location.search);

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtUSD(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n;
  }

  function fmtPct(v) {
    if (v === null || v === undefined) return '—';
    var s = (v > 0 ? '+' : '') + v.toFixed(1) + '%';
    return '<span class="' + (v >= 0 ? 'up' : 'down') + '">' + s + '</span>';
  }

  function fmtAge(days) {
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return days + 'd';
  }

  function chainsOf(r) {
    var c = r.chains || [];
    if (c.length === 0) return '—';
    if (c.length <= 2) return esc(c.join(', '));
    return esc(c.slice(0, 2).join(', ')) + ' +' + (c.length - 2);
  }

  // Meta line and category list.
  var watch = rows.filter(function (r) { return r.watchlist; }).length;
  document.getElementById('meta').innerHTML =
    '<b>' + rows.length + '</b> protocols &middot; <b>' + watch + '</b> watchlist<br>' +
    'Snapshot ' + esc(data.as_of) + ' &middot; model radar-v2';
  document.getElementById('src').textContent =
    'Source: DefiLlama protocol snapshot as of ' + data.as_of + '. Implied values are this radar’s own claim, not a prediction of a launch date or price.';

  var cats = [];
  rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
  });
  cats.sort();
  var catSel = document.getElementById('cat');
  cats.forEach(function (c) {
    var o = document.createElement('option');
    o.value = c; o.textContent = c;
    catSel.appendChild(o);
  });

  // Controls from the URL, then keep them in sync when they change.
  var qInput = document.getElementById('q');
  var sortSel = document.getElementById('sort');
  var wlBox = document.getElementById('wl');
  qInput.value = params.get('q') || '';
  catSel.value = params.get('cat') || '';
  sortSel.value = params.get('sort') || 'rank';
  wlBox.checked = params.get('wl') === '1';

  function go(next) {
    var p = new URLSearchParams(window.location.search);
    Object.keys(next).forEach(function (k) {
      if (next[k]) p.set(k, next[k]); else p.delete(k);
    });
    window.location.search = p.toString();
  }
  qInput.addEventListener('change', function () { go({ q: qInput.value.trim(), slug: '' }); });
  catSel.addEventListener('change', function () { go({ cat: catSel.value, slug: '' }); });
  wlBox.addEventListener('change', function () { go({ wl: wlBox.checked ? '1' : '', slug: '' }); });
  sortSel.addEventListener('change', function () { go({ sort: sortSel.value }); });

  // Scatter chart: TVL against implied value, log scales, drawn as inline SVG
  // from the same rows the table shows. Gold dots are watchlist rows.
  function renderChart() {
    var el = document.getElementById('chart');
    if (!el) return;
    var W = 1100, H = 300, PL = 64, PR = 16, PT = 14, PB = 36;
    var xs = rows.map(function (r) { return Math.log10(Math.max(1, r.tvl_usd)); });
    var ys = rows.map(function (r) { return Math.log10(Math.max(1, r.implied_value_usd)); });
    var x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
    var y0 = Math.floor(Math.min.apply(null, ys)), y1 = Math.ceil(Math.max.apply(null, ys));
    function X(v) { return PL + (v - x0) / (x1 - x0) * (W - PL - PR); }
    function Y(v) { return PT + (1 - (v - y0) / (y1 - y0)) * (H - PT - PB); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Scatter chart of TVL against implied value">';
    var t;
    for (t = x0; t <= x1; t++) {
      s += '<line x1="' + X(t) + '" y1="' + PT + '" x2="' + X(t) + '" y2="' + (H - PB) + '" class="grid"/>' +
        '<text x="' + X(t) + '" y="' + (H - 12) + '" class="axis" text-anchor="' + (t === x1 ? 'end' : 'middle') + '">$10^' + t + '</text>';
    }
    for (t = y0; t <= y1; t++) {
      s += '<line x1="' + PL + '" y1="' + Y(t) + '" x2="' + (W - PR) + '" y2="' + Y(t) + '" class="grid"/>' +
        '<text x="' + (PL - 8) + '" y="' + (Y(t) + 4) + '" class="axis" text-anchor="end">$10^' + t + '</text>';
    }
    s += '<text x="' + ((W - PL - PR) / 2 + PL) + '" y="' + (H - 2) + '" class="axislabel" text-anchor="middle">TVL (log)</text>';
    s += '<text x="14" y="' + ((H - PT - PB) / 2 + PT) + '" class="axislabel" text-anchor="middle" transform="rotate(-90 14 ' + ((H - PT - PB) / 2 + PT) + ')">Implied value (log)</text>';
    rows.forEach(function (r) {
      var cx = X(Math.log10(Math.max(1, r.tvl_usd))).toFixed(1);
      var cy = Y(Math.log10(Math.max(1, r.implied_value_usd))).toFixed(1);
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r.watchlist ? 5 : 3.5) + '" class="' + (r.watchlist ? 'dot-wl' : 'dot') + '"><title>' + esc(r.name) + ' — TVL ' + fmtUSD(r.tvl_usd) + ', implied ' + fmtUSD(r.implied_value_usd) + '</title></circle>';
    });
    s += '</svg>';
    el.innerHTML = s;
  }
  renderChart();

  function filtered() {
    var q = (params.get('q') || '').toLowerCase();
    var cat = params.get('cat') || '';
    var wlOnly = params.get('wl') === '1';
    var list = rows.filter(function (r) {
      if (cat && r.category !== cat) return false;
      if (wlOnly && !r.watchlist) return false;
      if (q && (r.name + ' ' + r.slug).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var sort = params.get('sort') || 'rank';
    var key = { rank: 'rank', tvl: 'tvl_usd', change: 'change_7d', age: 'age_days' }[sort] || 'rank';
    list = list.slice().sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (av === null || av === undefined) av = -Infinity;
      if (bv === null || bv === undefined) bv = -Infinity;
      if (key === 'rank') return av - bv;
      return (bv - av) || (a.slug < b.slug ? -1 : 1);
    });
    return list;
  }

  function renderBoard() {
    var list = filtered();
    document.getElementById('count').textContent = list.length + ' of ' + rows.length + ' shown';
    document.getElementById('empty').hidden = list.length > 0;
    box.innerHTML = list.map(function (r) {
      var cls = r.rank <= 3 ? ' class="rank' + r.rank + '"' : '';
      var badge = r.watchlist ? ' <span class="wl" title="On the house watchlist">&#9733; Watchlist</span>' : '';
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num"' + cls + '>' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span>' + badge + '<br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + chainsOf(r) + '</td>' +
        '<td class="num">' + fmtUSD(r.tvl_usd) + '</td>' +
        '<td class="num">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num"><b>' + fmtUSD(r.implied_value_usd) + '</b></td>' +
        '</tr>';
    }).join('');
    box.querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () { go({ slug: tr.getAttribute('data-slug') }); });
    });
  }

  function renderDetail(slug) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    var el = document.getElementById('detail');
    if (!r) {
      el.hidden = true;
      document.getElementById('boardWrap').hidden = false;
      document.getElementById('chartWrap').style.display = '';
      renderBoard();
      return;
    }
    document.getElementById('boardWrap').hidden = true;
    document.getElementById('chartWrap').style.display = 'none';
    document.getElementById('controls').style.display = 'none';
    el.hidden = false;
    el.innerHTML =
      '<span class="tag">Rank #' + r.rank + '</span>' +
      '<span class="tag">Records no token</span>' +
      (r.watchlist ? '<span class="tag tag-wl">&#9733; Watchlist</span>' : '') +
      '<span class="tag">' + esc(r.category || 'Uncategorised') + '</span>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<div class="big">' + fmtUSD(r.implied_value_usd) + ' <span style="font-size:14px;color:var(--muted)">implied value</span></div>' +
      '<div class="stats">' +
      '<span>TVL <b>' + fmtUSD(r.tvl_usd) + '</b></span>' +
      '<span>7-day change <b>' + fmtPct(r.change_7d).replace(/<[^>]+>/g, '') + '</b></span>' +
      '<span>Tracked for <b>' + fmtAge(r.age_days) + '</b></span>' +
      '<span>Market multiple <b>' + r.market_multiple.toFixed(4) + '</b></span>' +
      '<span>Growth factor <b>' + r.growth_factor.toFixed(2) + '</b></span>' +
      '<span>Maturity factor <b>' + r.maturity_factor.toFixed(2) + '</b></span>' +
      '<span>Diversity factor <b>' + r.diversity_factor.toFixed(2) + '</b></span>' +
      '<span>Chains <b>' + esc((r.chains || []).join(', ') || '—') + '</b></span>' +
      '</div>' +
      '<h3>How to farm it</h3>' +
      '<ol>' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<button class="back" id="backBtn">&larr; Back to the board</button>';
    document.getElementById('backBtn').addEventListener('click', function () { go({ slug: '' }); });
  }

  var slug = params.get('slug') || '';
  if (slug) renderDetail(slug); else renderBoard();
})();

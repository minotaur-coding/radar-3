// Token Radar's dark editorial dashboard, radar-3. It reads window.RADAR (written beside dashboard/
// by main.ts) and renders the ranked board, a sortable and filterable table, a per-protocol detail
// drawer with the model's own calibration and the protocol's farm plan, and a Live token view that
// keeps trading protocols apart. No network: every byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', tab: 'board', sort: 'implied', dir: -1, selected: null };

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var neg = n < 0;
    var a = Math.abs(n);
    var s;
    if (a >= 1e9) s = '$' + (a / 1e9).toFixed(2) + 'B';
    else if (a >= 1e6) s = '$' + (a / 1e6).toFixed(1) + 'M';
    else if (a >= 1e3) s = '$' + Math.round(a / 1e3) + 'K';
    else s = '$' + Math.round(a);
    return neg ? '-' + s : s;
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return String(n === null || n === undefined ? 'n/a' : n); }

  // The model in one function: the page recomputes a row from the snapshot figures and the
  // snapshot-calibrated anchors, and checks the number board.json carries, so the page's code and
  // the board's data are visibly the same arithmetic.
  function anchorOf(category) {
    var key = (category || '').trim().toLowerCase();
    var cal = DATA.calibration;
    if (cal && cal.categories && cal.categories[key] !== undefined) return cal.categories[key];
    if (cal && cal.categories) {
      for (var k in cal.categories) if (key.indexOf(k) >= 0 || k.indexOf(key) >= 0 && key) return cal.categories[k];
    }
    return { multiple: cal ? cal.global_multiple : 0.25, comparables: cal ? cal.global_comparables : 0, median_ratio: null };
  }
  function impliedOf(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var runway = model.runway_floor + (Math.min(Math.max(age, 0), model.runway_days) / model.runway_days) * model.runway_range;
    var anchor = anchorOf(row.category).multiple;
    var tie = row.model && row.model.tie_break ? row.model.tie_break : 1;
    return Math.max(1, Math.round(row.tvl_usd * anchor * growthMult * runway * tie));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and age
  // decide the action, the capital, the hold and every cost and time. No name is special-cased.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function fundingNote(chain) {
    var c = (chain || '').toLowerCase();
    if (c === 'ethereum') return { fee: 'about $3-8 in gas to move funds or swap on mainnet', time: '5-15 minutes' };
    if (c === 'solana' || c === 'sui' || c === 'aptos' || c === 'ton') return { fee: 'under $0.05 per transaction', time: '1-5 minutes' };
    if (c === 'bsc') return { fee: 'under $0.30 per transaction', time: '3-5 minutes' };
    if (['base', 'arbitrum', 'optimism', 'polygon', 'blast', 'scroll', 'linea', 'zksync'].indexOf(c) >= 0) return { fee: 'about $0.10-2 to bridge in on an L2', time: '5-10 minutes' };
    return { fee: 'a few dollars of gas depending on the chain', time: '5-15 minutes' };
  }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC as collateral in ' + name + "'s largest market on " + chain + ' and leave it unborrowed at first, then borrow at most 30% LTV after a week so the position shows real usage.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0 || c.indexOf('liquidity') >= 0) return 'Provide $' + capital + ' of liquidity (half USDC, half the other asset) into ' + name + "'s deepest pool on " + chain + ' and leave the LP position open, compounding fees weekly.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small, hedged long against an equivalent short elsewhere, so volume accrues without directional risk.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ', then bridge half of it back so the route sees volume in both directions.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Stake $' + capital + " of the chain's staking asset through " + name + ', keep the receipt token in the same wallet, and never move it to an exchange.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' on ' + name + ' and place one small position each week on its most liquid market, holding each bet to resolution.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('vault') >= 0) return 'Deposit $' + capital + ' into ' + name + "'s largest vault on " + chain + ' and keep the vault shares; add a second $' + Math.round(capital / 2) + ' tranche after two weeks.';
    if (c.indexOf('stable') >= 0) return 'Mint $' + capital + ' of the stable asset through ' + name + ' on ' + chain + ', then deposit the minted stable back into the protocol\u2019s own savings module.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + capital + ' of ' + name + "'s yield-bearing asset on " + chain + ' and hold it in the same wallet through at least one yield distribution.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' for a 30-day term and let it lapse unredeemed, then buy a second term.';
    if (c.indexOf('launch') >= 0 || c.indexOf('incubat') >= 0) return 'Join ' + name + "'s public track on " + chain + ' with $' + capital + ' and complete every quest it lists, screenshotting each completed task.';
    return 'Deposit $' + capital + ' of USDC into ' + name + "'s main pool on " + chain + ' and keep the position open, adding to it weekly rather than once.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var alt = p.chains && p.chains.length > 1 ? p.chains[1] : chain;
    var fund = fundingNote(chain);
    var altFund = p.chains && p.chains.length > 1 ? fundingNote(alt) : null;
    return [
      { text: 'Set up a fresh wallet used only for farming ' + p.name + ', and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: 'Fund it on ' + chain + ' with $' + capital + " of USDC or the chain's gas asset from an exchange withdrawal or a bridge you already use.", cost: '$' + capital + ' of capital plus ' + fund.fee, time: fund.time + ' to land' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week — a deposit, a swap, a borrow-repay or a vote — alternating between ' + chain + ' and ' + alt + ' where the protocol runs on both.', cost: 'about $2 of gas a week on ' + chain + (altFund ? ', similar on ' + alt : ''), time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity lands in more than one monthly snapshot, and record every transaction hash in a farm log the day you transact.', cost: 'the $' + capital + ' stays in the position (withdrawing early can cost the accrued allocation)', time: hold + ' days, ~5 minutes a week to check' },
      { text: 'Watch ' + p.name + "'s own announcements channel for a points program or an incentives season and join it in its first week; late joins are worth a fraction of early ones.", cost: 'no fee beyond gas', time: '5 minutes a week' },
      { text: "Before you withdraw, claim rewards only from the protocol's own page, then unwind in two tranches a week apart and log the exit prices.", cost: 'a few dollars of gas to exit', time: '15 minutes per tranche' }
    ].map(stepText);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function chainsOf(r) { return (r.chains || []).join(' '); }
  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && chainsOf(r).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, chainsOf(r)].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  // Stable sort on ties: equal values keep the board's own rank order, so flipping the sort
  // direction never shuffles rows that share a number.
  function sortedRows(list) {
    var key = state.sort;
    var boardOrder = {};
    DATA.rows.forEach(function (r, i) { boardOrder[r.slug] = i; });
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return boardOrder[a.slug] - boardOrder[b.slug];
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'TOKEN RADAR' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { class: 'ver', text: DATA.model_version })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: 'Which tokenless protocol is worth farming first?' }),
        el('p', { text: 'The watchlist is the floor: ' + DATA.watchlist_size + ' protocols with at least ' + fmtUsd(DATA.floor_usd) + ' of TVL, no token on record and no wrapped or staked parent. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value is this entry\u2019s own model of what each protocol\u2019s record implies for its future token \u2014 calibrated from the market\u2019s own MCap/TVL ratios \u2014 a claim, never a promise, and never make.fun\u2019s.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSelect = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    catSelect.addEventListener('change', function () { state.category = catSelect.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var boardTab = el('button', { type: 'button', 'aria-pressed': state.tab === 'board' ? 'true' : 'false', text: 'Board', onclick: function () { state.tab = 'board'; render(); } });
    var liveTab = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    var clear = el('button', { class: 'linklike', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSelect),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'View' }), el('div', { class: 'tabs' }, boardTab, liveTab)),
      clear,
      el('span', { class: 'count', text: state.tab === 'board' ? rows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', class: 'arrow', text: state.dir < 0 ? '\u25BC' : '\u25B2' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num rank', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' \u00B7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'unnamed chain') + (r.is_watchlist ? '  \u2022 watchlist' : '') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtUsd(r.implied_value_usd) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num strong', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status' + (r.is_watchlist ? ' onlist' : ' early'), text: r.is_watchlist ? 'watchlist' : 'early radar' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model breakdown and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', '#'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d growth'),
            sortHeader('age', 'Age, no token'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Share of leader' }),
            el('th', { scope: 'col', text: 'Source' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', { class: 'live-row' },
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' \u00B7 ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.ratio === null ? 'n/a' : r.ratio.toFixed(2) + 'x' }),
        el('td', null, el('span', { class: 'status onlist', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. Their MCap/TVL ratios are what calibrate the anchors.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'MCap / TVL' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var cal = DATA.calibration || { global_multiple: 0.25, global_comparables: 0, categories: {} };
    var names = Object.keys(cal.categories || {}).sort();
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures \u2014 TVL, seven-day growth, age without a token and the protocol\u2019s category. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        'implied = round( tvl_usd',
        el('br'),
        '  \u00D7 anchor_multiple(category)   \u2014 the market\u2019s own MCap/TVL, see the calibration below',
        el('br'),
        '  \u00D7 (1 + clamp(change_7d, ' + m.growth_floor + ', +' + m.growth_cap + ')/100 \u00D7 ' + m.growth_weight + ')   \u2014 momentum: half the clamped 7-day change',
        el('br'),
        '  \u00D7 (' + m.runway_floor + ' + 0.40 \u00D7 min(age_days, ' + m.runway_days + ')/' + m.runway_days + ')   \u2014 runway without a token; unknown age counts as ' + m.unknown_age_days + ' days',
        el('br'),
        '  \u00D7 tie_break(slug) )   \u2014 a stated \u00B10.01% offset from the slug, so whole dollars stay distinct'
      ),
      el('h3', { text: 'The calibration: anchors come from this snapshot, not from us' }),
      el('p', { class: 'sub', text: 'For every category, the model takes the protocols in this same snapshot whose token already trades, divides each one\u2019s market cap by its TVL, and the anchor is the median of those ratios \u2014 the market\u2019s own answer to what a dollar of TVL in that kind of protocol is worth as a token. A category with fewer than ' + m.min_comparables + ' live comparables takes the global median, ' + cal.global_multiple + 'x over ' + cal.global_comparables + ' live protocols. Each protocol\u2019s ratio is clamped to [' + m.ratio_clamp_min + ', ' + m.ratio_clamp_max + '] before the median so one overheated listing cannot move an anchor.' }),
      el('div', { class: 'mults' }, names.map(function (k) {
        var a = cal.categories[k];
        return el('span', { class: 'mult', title: a.comparables + ' live comparables' }, k + ' \u00D7' + a.multiple + ' (' + a.comparables + ' comps)');
      })),
      el('span', { class: 'mult global' }, 'global fallback \u00D7' + cal.global_multiple + ' (' + cal.global_comparables + ' live comps)'),
      el('p', { class: 'sub', text: 'The board separates protocols whose token already trades \u2014 the Live token view, priced by the market \u2014 from the pre-token rows this model ranks. The early radar fills the board past the watchlist floor: pre-token protocols below it, picked by a radar score of TVL \u00D7 growth \u00D7 young-protocol urgency. An implied value is this entry\u2019s claim about what the record implies, not a forecast of a launch.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  // One factor in the value-model breakdown: its label, its number, and a sparkline-like bar whose
  // width is the factor's share of the largest factor's contribution (clamped to 4..100%).
  function factorBar(label, value, share, why) {
    var pct = Math.max(4, Math.min(100, Math.round(share * 100)));
    return el('div', { class: 'eq-factor' },
      el('div', { class: 'eq-line' },
        el('span', { text: label }),
        el('b', { class: 'num', text: value })
      ),
      el('div', { class: 'eq-bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + pct + '%', title: pct + '% of the largest factor\u2019s contribution' })),
      el('span', { class: 'eq-why', text: why })
    );
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    var recompute = impliedOf(row, DATA.model);
    var anchor = anchorOf(row.category);
    // The factor bars: each factor's dollar contribution, and the largest one for the bar scale.
    var g = Math.min(DATA.model.growth_cap, Math.max(DATA.model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (g / 100) * DATA.model.growth_weight;
    var ageForModel = row.age_days === null || row.age_days === undefined ? DATA.model.unknown_age_days : row.age_days;
    var runwayMult = DATA.model.runway_floor + (Math.min(Math.max(ageForModel, 0), DATA.model.runway_days) / DATA.model.runway_days) * DATA.model.runway_range;
    var contributions = [row.tvl_usd, row.tvl_usd * anchor.multiple, row.tvl_usd * anchor.multiple * growthMult, row.tvl_usd * anchor.multiple * growthMult * runwayMult];
    var largestContribution = Math.max.apply(null, contributions);
    var maxAnchor = Math.max(1, anchor.multiple);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'RANK ' + row.rank + ' OF ' + DATA.board_size + (row.is_watchlist ? '  \u00B7  WATCHLIST' : '  \u00B7  EARLY RADAR') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + (row.listed_at ? ' \u00B7 listed ' + row.listed_at : ' \u00B7 listing date unknown') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Value model breakdown' }),
      el('div', { class: 'equation' },
        factorBar('TVL', fmtUsd(row.tvl_usd), 1, 'the raw capital the protocol holds'),
        factorBar('Anchor multiple (' + (row.category || 'no category') + '), median MCap/TVL of ' + anchor.comparables + ' live comparables', '\u00D7 ' + anchor.multiple, anchor.multiple / maxAnchor, 'the market\u2019s own multiple, calibrated from this snapshot'),
        factorBar('Seven-day growth \u2014 momentum ' + fmtPct(row.change_7d), '\u00D7 ' + fmtMult(row.model.growth_multiplier), Math.max(0, (row.model.growth_multiplier - 0.7)) / 0.6, 'half the clamped seven-day change'),
        factorBar('Age with no token \u2014 runway ' + fmtAge(row.age_days), '\u00D7 ' + fmtMult(row.model.runway_multiplier), Math.max(0, (row.model.runway_multiplier - 0.8)) / 0.4, '0.80 rising to 1.20 over three years'),
        factorBar('Tie-break \u2014 a stated \u00B10.01% offset from the slug', '\u00D7 ' + (row.model.tie_break || 1), 0.5, 'keeps whole-dollar values distinct'),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Each bar shows how strongly that factor pushes this protocol\u2019s implied value \u2014 its share of the largest factor\u2019s contribution (' + fmtUsd(largestContribution) + '). Model ' + DATA.model_version + ': the page recomputes this row as ' + fmtUsd(recompute) + (recompute === row.implied_value_usd ? ', the same number board.json carries \u2014 the page and the board run the same arithmetic.' : ', which differs from the board: the data would be stale.') + ' This is an estimate of what the record implies, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('p', { class: 'sub', text: 'Seven concrete steps, each with what it costs and how long it takes, derived from ' + row.name + '\u2019s own category, chains, TVL and age.' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'board' ? boardTable() : liveTable());
    if (state.tab === 'board') shell.appendChild(modelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();

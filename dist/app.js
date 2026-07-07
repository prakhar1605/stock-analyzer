'use strict';

/* ---------------- Groups (tabs) ---------------- */
const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'GOOGL', 'NVDA', 'TSLA', 'AMZN'];

// Preset groups are fixed. 'my' is user-editable and persisted.
const GROUPS = [
  { id: 'my',     label: 'My list',    editable: true,  symbols: null /* from state.watchlist */ },
  { id: 'mega',   label: 'Mega caps',  editable: false, symbols: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA'] },
  { id: 'ai',     label: 'AI & Chips', editable: false, symbols: ['NVDA', 'AMD', 'TSM', 'AVGO', 'INTC'] },
  { id: 'ev',     label: 'EV & Auto',  editable: false, symbols: ['TSLA', 'RIVN', 'F', 'GM'] },
  { id: 'fin',    label: 'Finance',    editable: false, symbols: ['JPM', 'V', 'MA', 'GS'] },
];

// Market overview indices (S&P 500, Nasdaq Composite, Dow Jones).
const OVERVIEW = [
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^IXIC', label: 'Nasdaq' },
  { symbol: '^DJI',  label: 'Dow' },
];

/* ---------------- State ---------------- */
const state = {
  watchlist: [],                     // My list — persisted
  activeTab: 'my',                   // current group id
  quotesByGroup: { my: {}, mega: {}, ai: {}, ev: {}, fin: {} },  // group -> (symbol -> quote)
  loadedGroups: new Set(),           // groups that have been fetched at least once
  overview: {},                      // symbol -> quote (for overview strip)
  overviewLoaded: false,
  selected: null,                    // currently open news symbol (in active tab)
  sort: 'pct-desc',                  // 'pct-desc' | 'pct-asc' | 'name'
};

// Helpers to work with the active group.
function activeGroupDef() { return GROUPS.find((g) => g.id === state.activeTab) || GROUPS[0]; }
function activeSymbols() {
  const g = activeGroupDef();
  return g.editable ? state.watchlist : g.symbols.slice();
}
function activeQuotes() { return state.quotesByGroup[state.activeTab] || (state.quotesByGroup[state.activeTab] = {}); }

/* ---------------- DOM refs ---------------- */
const $ = (id) => document.getElementById(id);
const els = {
  refreshBtn: $('refreshBtn'),
  marketDot: $('marketDot'),
  marketStatus: $('marketStatus'),
  overviewStrip: $('overviewStrip'),
  tabsBar: $('tabsBar'),
  addRow: $('addRow'),
  tickerInput: $('tickerInput'),
  addBtn: $('addBtn'),
  controlsRow: $('controlsRow'),
  moversRow: $('moversRow'),
  sortSelect: $('sortSelect'),
  trendsLoading: $('trendsLoading'),
  emptyWatchlist: $('emptyWatchlist'),
  watchlist: $('watchlist'),
};

// Per-symbol news cache: symbol -> { status: 'loading'|'ready'|'error'|'empty', items, msg }
const newsCache = {};

/* ---------------- Host API helpers ---------------- */
const APP_HEADERS = { 'X-Rowboat-App': '1', 'Content-Type': 'application/json' };

async function loadData() {
  try {
    const res = await fetch('/_rowboat/data/data.json');
    if (!res.ok) return { watchlist: DEFAULT_WATCHLIST.slice(), activeTab: 'my', sort: 'pct-desc' };
    const d = await res.json();
    const wl = Array.isArray(d.watchlist) ? d.watchlist : [];
    const validTab = GROUPS.some((g) => g.id === d.activeTab) ? d.activeTab : 'my';
    const validSort = ['pct-desc', 'pct-asc', 'name'].includes(d.sort) ? d.sort : 'pct-desc';
    return {
      watchlist: wl.length ? wl : DEFAULT_WATCHLIST.slice(),
      activeTab: validTab,
      sort: validSort,
    };
  } catch {
    return { watchlist: DEFAULT_WATCHLIST.slice(), activeTab: 'my', sort: 'pct-desc' };
  }
}

async function saveData() {
  try {
    await fetch('/_rowboat/data/data.json', {
      method: 'PUT',
      headers: APP_HEADERS,
      body: JSON.stringify({
        watchlist: state.watchlist,
        activeTab: state.activeTab,
        sort: state.sort,
      }),
    });
  } catch { /* non-fatal */ }
}

// Proxy a GET through the Rowboat host; returns { ok, status, text }
async function proxyGet(url) {
  const res = await fetch('/_rowboat/fetch', {
    method: 'POST',
    headers: APP_HEADERS,
    body: JSON.stringify({ url }),
  });
  if (!res.ok) return { ok: false, status: res.status, text: '' };
  const wrap = await res.json(); // { ok, status, text, truncated }
  return { ok: !!wrap.ok, status: wrap.status || 0, text: wrap.text || '' };
}

/* ---------------- Theme ---------------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
}

async function initTheme() {
  try {
    const info = await (await fetch('/_rowboat/app')).json();
    applyTheme(info.theme);
  } catch {
    applyTheme('light');
  }
  try {
    const events = new EventSource('/_rowboat/events');
    events.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'theme') applyTheme(msg.theme);
      } catch {}
    });
  } catch {}
}

/* ---------------- Quotes: Yahoo primary, Stooq fallback ---------------- */
function yahooUrl(sym) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
}
function stooqUrl(sym) {
  return `https://stooq.com/q/l/?s=${encodeURIComponent(sym.toLowerCase())}.us&f=sd2t2ohlcv&h&e=csv`;
}

// Parse Yahoo chart JSON -> quote record or a sentinel
function parseYahoo(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { kind: 'parse-error' }; }
  const chart = data && data.chart;
  if (!chart) return { kind: 'parse-error' };
  if (chart.error || !Array.isArray(chart.result) || !chart.result[0]) {
    return { kind: 'notfound' };
  }
  const result = chart.result[0];
  const meta = result.meta || {};
  const price = meta.regularMarketPrice;
  if (typeof price !== 'number') return { kind: 'notfound' };

  // Build the list of valid daily closes (drop nulls). The LAST entry is the
  // current/most-recent session; the SECOND-TO-LAST is the true previous close.
  // NOTE: chartPreviousClose is the close from BEFORE the range window (~a week
  // ago with range=5d) — using it mislabels a 5-day change as a day change.
  let closes = [];
  try {
    const raw = result.indicators.quote[0].close;
    closes = (raw || []).filter((c) => typeof c === 'number' && isFinite(c));
  } catch { closes = []; }

  let prev;
  if (closes.length >= 2) {
    prev = closes[closes.length - 2];
  } else if (typeof meta.chartPreviousClose === 'number') {
    // Fallback only when we genuinely lack a series.
    prev = meta.chartPreviousClose;
  }
  if (typeof prev !== 'number' || prev === 0) return { kind: 'notfound' };

  const change = price - prev;
  const pct = (change / prev) * 100;
  const name = meta.shortName || meta.longName || '';
  // Sparkline series: the valid closes, with the live price as the final point.
  const series = closes.slice();
  if (series.length && series[series.length - 1] !== price) series.push(price);
  return { kind: 'ok', price, change, pct, name, series };
}

// Parse Stooq CSV -> quote record. Header: Symbol,Date,Time,Open,High,Low,Close,Volume
function parseStooq(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (lines.length < 2) return { kind: 'notfound' };
  const header = lines[0].toLowerCase().split(',');
  const cols = lines[1].split(',');
  const idx = (name) => header.indexOf(name);
  const closeI = idx('close');
  const openI = idx('open');
  if (closeI < 0) return { kind: 'notfound' };
  const close = parseFloat(cols[closeI]);
  const open = parseFloat(cols[openI]);
  // Stooq returns "N/D" for unknown symbols
  if (!isFinite(close) || close === 0) return { kind: 'notfound' };
  // Stooq daily line has no previous close; approximate day change from open->close.
  const base = isFinite(open) && open !== 0 ? open : close;
  const change = close - base;
  const pct = base !== 0 ? (change / base) * 100 : 0;
  return { kind: 'ok', price: close, change, pct };
}

// Fetch a single quote with Yahoo primary + Stooq fallback
async function fetchQuote(sym) {
  let r;
  try {
    r = await proxyGet(yahooUrl(sym));
  } catch {
    r = { ok: false, status: 0, text: '' };
  }

  // Yahoo blocked (403/429) or network failure -> try Stooq
  if (r.status === 403 || r.status === 429 || (!r.ok && r.status !== 404 && !r.text)) {
    return await fetchQuoteStooq(sym);
  }

  const parsed = parseYahoo(r.text);
  if (parsed.kind === 'ok') {
    return { status: 'ok', price: parsed.price, change: parsed.change, pct: parsed.pct, name: parsed.name, series: parsed.series };
  }
  if (parsed.kind === 'notfound') {
    // Yahoo 404 / null result: could be truly unknown, or Yahoo being picky.
    // Try Stooq before declaring not-found.
    const fb = await fetchQuoteStooq(sym);
    if (fb.status === 'ok') return fb;
    return { status: 'notfound', msg: 'Symbol not found' };
  }
  // parse error -> try Stooq
  return await fetchQuoteStooq(sym);
}

async function fetchQuoteStooq(sym) {
  let r;
  try {
    r = await proxyGet(stooqUrl(sym));
  } catch {
    return { status: 'error', msg: 'Data unavailable' };
  }
  if (r.status === 429) return { status: 'error', msg: 'Rate limit — wait a moment' };
  if (!r.text) return { status: 'error', msg: 'Data unavailable' };
  const parsed = parseStooq(r.text);
  if (parsed.kind === 'ok') {
    return { status: 'ok', price: parsed.price, change: parsed.change, pct: parsed.pct };
  }
  return { status: 'notfound', msg: 'Symbol not found' };
}

// Fetch quotes for a specific group. If `force`, re-fetch even if cached.
async function loadGroup(groupId, { force = false } = {}) {
  const g = GROUPS.find((x) => x.id === groupId);
  if (!g) return;
  const symbols = g.editable ? state.watchlist : g.symbols.slice();
  const bucket = state.quotesByGroup[groupId] || (state.quotesByGroup[groupId] = {});

  if (symbols.length === 0) {
    state.loadedGroups.add(groupId);
    if (state.activeTab === groupId) renderActive();
    return;
  }

  const showSpinner = state.activeTab === groupId;
  if (showSpinner) {
    els.refreshBtn.classList.add('spinning');
    els.refreshBtn.disabled = true;
    els.trendsLoading.classList.remove('hidden');
  }

  // Mark all as loading (only for symbols we're about to fetch).
  for (const sym of symbols) {
    if (force || !bucket[sym] || bucket[sym].status !== 'ok') {
      bucket[sym] = { status: 'loading' };
    }
  }
  if (state.activeTab === groupId) renderActive();

  // Sequential fetch — gentle on free sources.
  for (const sym of symbols) {
    if (!force && bucket[sym] && bucket[sym].status === 'ok') continue;
    bucket[sym] = await fetchQuote(sym);
    if (state.activeTab === groupId) renderActive();
  }

  state.loadedGroups.add(groupId);
  if (showSpinner) {
    els.trendsLoading.classList.add('hidden');
    els.refreshBtn.classList.remove('spinning');
    els.refreshBtn.disabled = false;
  }
}

// Load the market overview strip (indices).
async function loadOverview({ force = false } = {}) {
  if (state.overviewLoaded && !force) { renderOverview(); return; }
  for (const item of OVERVIEW) {
    if (force || !state.overview[item.symbol] || state.overview[item.symbol].status !== 'ok') {
      state.overview[item.symbol] = { status: 'loading' };
    }
  }
  renderOverview();
  for (const item of OVERVIEW) {
    if (!force && state.overview[item.symbol] && state.overview[item.symbol].status === 'ok') continue;
    state.overview[item.symbol] = await fetchQuote(item.symbol);
    renderOverview();
  }
  state.overviewLoaded = true;
}

// Refresh button: refresh the CURRENT tab and the overview strip.
async function refreshAll() {
  renderMarketStatus();
  await Promise.all([
    loadGroup(state.activeTab, { force: true }),
    loadOverview({ force: true }),
  ]);
}

/* ---------------- News: Google News RSS ---------------- */
function newsUrl(sym) {
  const q = encodeURIComponent(`${sym} stock`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

function parseNewsXml(text) {
  const items = [];
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    const nodes = doc.querySelectorAll('item');
    nodes.forEach((node) => {
      const get = (tag) => {
        const el = node.getElementsByTagName(tag)[0];
        return el ? el.textContent : '';
      };
      const sourceEl = node.getElementsByTagName('source')[0];
      items.push({
        title: decodeEntities(get('title') || '(untitled)'),
        link: get('link') || '#',
        pubDate: get('pubDate') || '',
        source: sourceEl ? sourceEl.textContent : '',
      });
    });
  } catch {
    return null;
  }
  return items;
}

// Toggle the inline news panel for a ticker. One open at a time.
function toggleNews(sym) {
  if (state.selected === sym) {
    // collapse
    state.selected = null;
    renderWatchlist();
    return;
  }
  state.selected = sym;
  // If not cached (or previously errored), (re)fetch.
  const cached = newsCache[sym];
  if (!cached || cached.status === 'error') {
    newsCache[sym] = { status: 'loading', items: [] };
    fetchNews(sym);
  }
  renderWatchlist();
}

// Fetch + parse news for a symbol into newsCache, then re-render if still open.
async function fetchNews(sym) {
  let r;
  try {
    r = await proxyGet(newsUrl(sym));
  } catch {
    newsCache[sym] = { status: 'error', msg: 'Network error while loading news.' };
    if (state.selected === sym) renderWatchlist();
    return;
  }

  if (r.status === 429) {
    newsCache[sym] = { status: 'error', msg: 'Rate limit reached — wait a moment and try again.' };
  } else if (!r.text) {
    newsCache[sym] = { status: 'error', msg: 'Could not load news for this symbol.' };
  } else {
    const items = parseNewsXml(r.text);
    if (items === null) {
      newsCache[sym] = { status: 'error', msg: 'Could not parse news feed.' };
    } else if (items.length === 0) {
      newsCache[sym] = { status: 'empty', items: [] };
    } else {
      newsCache[sym] = { status: 'ready', items: items.slice(0, 25) };
    }
  }
  if (state.selected === sym) renderWatchlist();
}

// Build the inline news panel element for a symbol (based on newsCache).
function buildNewsPanel(sym) {
  const panel = document.createElement('li');
  panel.className = 'news-panel';

  const inner = document.createElement('div');
  inner.className = 'news-panel-inner';

  const header = document.createElement('div');
  header.className = 'news-header';
  const h = document.createElement('h2');
  h.innerHTML = `News · <span>${sym}</span>`;
  const close = document.createElement('button');
  close.className = 'btn btn-ghost news-close';
  close.title = 'Close news';
  close.setAttribute('aria-label', 'Close news');
  close.textContent = '✕';
  close.addEventListener('click', (e) => { e.stopPropagation(); state.selected = null; renderWatchlist(); });
  header.appendChild(h);
  header.appendChild(close);
  inner.appendChild(header);

  const c = newsCache[sym] || { status: 'loading' };
  if (c.status === 'loading') {
    const l = document.createElement('div');
    l.className = 'section-loading';
    l.innerHTML = '<span class="spinner"></span> Loading headlines…';
    inner.appendChild(l);
  } else if (c.status === 'error') {
    const e = document.createElement('div');
    e.className = 'inline-error';
    e.textContent = c.msg || 'Could not load news.';
    inner.appendChild(e);
  } else if (c.status === 'empty') {
    const m = document.createElement('div');
    m.className = 'muted news-empty';
    m.textContent = 'No recent headlines found.';
    inner.appendChild(m);
  } else {
    const ul = document.createElement('ul');
    ul.className = 'news-list';
    c.items.forEach((n) => {
      const li = document.createElement('li');
      li.className = 'news-item';
      const a = document.createElement('a');
      a.className = 'news-title';
      a.href = n.link;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = n.title;
      const meta = document.createElement('div');
      meta.className = 'news-meta';
      let dateStr = '';
      if (n.pubDate) {
        const d = new Date(n.pubDate);
        if (!isNaN(d.getTime())) dateStr = relativeTime(d);
      }
      meta.textContent = [n.source, dateStr].filter(Boolean).join(' · ');
      li.appendChild(a);
      li.appendChild(meta);
      ul.appendChild(li);
    });
    inner.appendChild(ul);
  }

  panel.appendChild(inner);
  return panel;
}

// US market open? 9:30–16:00 ET, Mon–Fri. Ignores holidays.
function marketStatus() {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const wd = parts.find((p) => p.type === 'weekday').value; // Mon..Sun
    const hh = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    const mm = parseInt(parts.find((p) => p.type === 'minute').value, 10);
    const mins = hh * 60 + mm;
    const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wd);
    const open = 9 * 60 + 30, close = 16 * 60;
    if (isWeekday && mins >= open && mins < close) {
      return { open: true, label: `US markets open · ${wd} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} ET` };
    }
    if (isWeekday && mins < open) return { open: false, label: `Pre-market · opens 09:30 ET` };
    if (isWeekday && mins >= close) return { open: false, label: `After hours · closed at 16:00 ET` };
    return { open: false, label: `Weekend · markets closed` };
  } catch {
    return { open: false, label: 'Market status unavailable' };
  }
}

function renderMarketStatus() {
  const s = marketStatus();
  if (els.marketStatus) els.marketStatus.textContent = s.label;
  if (els.marketDot) els.marketDot.classList.toggle('is-open', !!s.open);
}

function relativeTime(d) {
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ---------------- Rendering ---------------- */
function fmtMoney(v) {
  return '$' + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtSigned(v) {
  const n = Number(v);
  const s = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n > 0 ? '+' : n < 0 ? '−' : '') + s;
}

// Build a tiny inline SVG sparkline from a numeric series. No extra API calls.
function sparklineSvg(series, up) {
  const pts = (series || []).filter((v) => typeof v === 'number' && isFinite(v));
  if (pts.length < 2) return '';
  const W = 64, H = 24, P = 2;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const stepX = (W - 2 * P) / (pts.length - 1);
  const coords = pts.map((v, i) => {
    const x = P + i * stepX;
    const y = P + (H - 2 * P) * (1 - (v - min) / span);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const stroke = up ? 'var(--up)' : 'var(--down)';
  return `<svg class="sparkline" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`
    + `<polyline fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="${coords.join(' ')}"/></svg>`;
}

// Sort symbols according to state.sort using the given quotes bucket.
function sortSymbols(symbols, quotes) {
  const arr = symbols.slice();
  if (state.sort === 'name') {
    arr.sort((a, b) => a.localeCompare(b));
    return arr;
  }
  // % change based sorts — unknowns sink to the bottom, stable-ish.
  const pctOf = (s) => {
    const q = quotes[s];
    return (q && q.status === 'ok' && typeof q.pct === 'number') ? q.pct : null;
  };
  arr.sort((a, b) => {
    const pa = pctOf(a), pb = pctOf(b);
    if (pa === null && pb === null) return a.localeCompare(b);
    if (pa === null) return 1;
    if (pb === null) return -1;
    return state.sort === 'pct-desc' ? (pb - pa) : (pa - pb);
  });
  return arr;
}

function renderWatchlist() {
  els.watchlist.innerHTML = '';
  const g = activeGroupDef();
  const quotes = activeQuotes();
  const symbols = activeSymbols();

  // Empty-state only makes sense on the editable 'My list' tab.
  els.emptyWatchlist.classList.toggle('hidden', symbols.length !== 0);

  const ordered = sortSymbols(symbols, quotes);
  for (const sym of ordered) {
    const q = quotes[sym] || { status: 'idle' };
    const li = document.createElement('li');
    li.className = 'ticker-card' + (state.selected === sym ? ' selected' : '');

    // --- LEFT: symbol + company name (grid col 1) ---
    const left = document.createElement('div');
    left.className = 'ticker-left';
    const symEl = document.createElement('span');
    symEl.className = 'ticker-symbol';
    symEl.textContent = sym;
    left.appendChild(symEl);
    const sub = document.createElement('span');
    sub.className = 'ticker-sub';
    const nameTxt = (q.status === 'ok' && q.name) ? q.name : '';
    sub.textContent = nameTxt || 'View news ▸';
    left.appendChild(sub);

    // --- MIDDLE: sparkline (grid col 2, always present so cols align) ---
    const mid = document.createElement('div');
    mid.className = 'ticker-mid';
    if (q.status === 'ok') {
      const up = q.change >= 0;
      const spark = sparklineSvg(q.series, up);
      if (spark) mid.innerHTML = spark;
    }

    // --- RIGHT: price + change pill OR status msg (grid col 3) ---
    const right = document.createElement('div');
    right.className = 'ticker-right';

    if (q.status === 'loading') {
      const s = document.createElement('span');
      s.className = 'card-mini-spinner';
      s.innerHTML = '<span class="spinner"></span> Loading…';
      right.appendChild(s);
    } else if (q.status === 'ok') {
      const price = document.createElement('span');
      price.className = 'ticker-price';
      price.textContent = fmtMoney(q.price);
      const chg = document.createElement('span');
      const dir = q.change > 0 ? 'change-up' : (q.change < 0 ? 'change-down' : 'change-flat');
      chg.className = 'ticker-change ' + dir;
      const arrow = q.change > 0 ? '▲' : q.change < 0 ? '▼' : '·';
      chg.textContent = `${arrow} ${fmtSigned(q.change)} (${fmtSigned(q.pct)}%)`;
      right.appendChild(price);
      right.appendChild(chg);
    } else if (q.status === 'notfound' || q.status === 'error') {
      const m = document.createElement('span');
      m.className = 'ticker-msg';
      m.textContent = q.msg || (q.status === 'notfound' ? 'Symbol not found' : 'Error');
      right.appendChild(m);
    } else {
      const m = document.createElement('span');
      m.className = 'ticker-sub';
      m.textContent = 'Tap Refresh';
      right.appendChild(m);
    }

    li.appendChild(left);
    li.appendChild(mid);
    li.appendChild(right);

    // --- REMOVE (grid col 4) — only on the editable 'My list' tab ---
    if (g.editable) {
      const rm = document.createElement('button');
      rm.className = 'remove-btn';
      rm.title = 'Remove ' + sym;
      rm.setAttribute('aria-label', 'Remove ' + sym);
      rm.textContent = '✕';
      rm.addEventListener('click', (e) => { e.stopPropagation(); removeTicker(sym); });
      li.appendChild(rm);
    } else {
      // Empty spacer to keep grid columns aligned across cards.
      const spacer = document.createElement('span');
      spacer.className = 'remove-spacer';
      li.appendChild(spacer);
    }

    li.addEventListener('click', () => toggleNews(sym));
    els.watchlist.appendChild(li);

    // Inline expanding news panel directly under the selected card.
    if (state.selected === sym) {
      els.watchlist.appendChild(buildNewsPanel(sym));
    }
  }
}

/* ---------------- Overview / Tabs / Movers ---------------- */

function renderOverview() {
  els.overviewStrip.innerHTML = '';
  OVERVIEW.forEach((item) => {
    const q = state.overview[item.symbol] || { status: 'idle' };
    const card = document.createElement('div');
    card.className = 'overview-item';

    const label = document.createElement('div');
    label.className = 'ov-label';
    label.textContent = item.label;
    card.appendChild(label);

    if (q.status === 'ok') {
      const price = document.createElement('div');
      price.className = 'ov-price';
      price.textContent = Number(q.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const chg = document.createElement('div');
      const dir = q.change > 0 ? 'change-up' : (q.change < 0 ? 'change-down' : 'change-flat');
      chg.className = 'ov-change ' + dir;
      const arrow = q.change > 0 ? '▲' : q.change < 0 ? '▼' : '·';
      chg.textContent = `${arrow} ${fmtSigned(q.pct)}%`;
      card.appendChild(price);
      card.appendChild(chg);
    } else if (q.status === 'loading') {
      const s = document.createElement('div');
      s.className = 'card-mini-spinner';
      s.innerHTML = '<span class="spinner"></span>';
      card.appendChild(s);
    } else {
      const m = document.createElement('div');
      m.className = 'ov-msg muted';
      m.textContent = '—';
      card.appendChild(m);
    }
    els.overviewStrip.appendChild(card);
  });
}

function renderTabs() {
  els.tabsBar.innerHTML = '';
  GROUPS.forEach((g) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (state.activeTab === g.id ? ' active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', state.activeTab === g.id ? 'true' : 'false');
    btn.textContent = g.label;
    btn.addEventListener('click', () => switchTab(g.id));
    els.tabsBar.appendChild(btn);
  });
}

function renderMovers() {
  els.moversRow.innerHTML = '';
  const quotes = activeQuotes();
  const symbols = activeSymbols();
  const okOnes = symbols
    .map((s) => ({ sym: s, q: quotes[s] }))
    .filter((x) => x.q && x.q.status === 'ok' && typeof x.q.pct === 'number');

  if (okOnes.length < 2) return;
  const sorted = okOnes.slice().sort((a, b) => b.q.pct - a.q.pct);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  const mkChip = (label, item, kind) => {
    const chip = document.createElement('button');
    chip.className = 'mover-chip mover-' + kind;
    chip.title = `Jump to ${item.sym}`;
    chip.innerHTML = `
      <span class="mover-label">${label}</span>
      <span class="mover-sym">${item.sym}</span>
      <span class="mover-pct">${fmtSigned(item.q.pct)}%</span>
    `;
    chip.addEventListener('click', () => {
      // Open the news accordion for this symbol.
      state.selected = state.selected === item.sym ? null : item.sym;
      const cached = newsCache[item.sym];
      if (state.selected && (!cached || cached.status === 'error')) {
        newsCache[item.sym] = { status: 'loading', items: [] };
        fetchNews(item.sym);
      }
      renderWatchlist();
      // Scroll the row into view after DOM re-render (single frame, not polling).
      requestAnimationFrame(() => {
        const rows = els.watchlist.querySelectorAll('.ticker-card');
        rows.forEach((r) => {
          if (r.querySelector('.ticker-symbol')?.textContent === item.sym) {
            r.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });
      });
    });
    return chip;
  };

  els.moversRow.appendChild(mkChip('Top ▲', best, 'up'));
  if (worst.sym !== best.sym) els.moversRow.appendChild(mkChip('Bottom ▼', worst, 'down'));
}

function renderControls() {
  // Show "Add ticker" row only on editable tab.
  const g = activeGroupDef();
  els.addRow.classList.toggle('hidden', !g.editable);
  // Sort dropdown reflects current value.
  if (els.sortSelect.value !== state.sort) els.sortSelect.value = state.sort;
}

function renderActive() {
  renderControls();
  renderMovers();
  renderWatchlist();
}

async function switchTab(id) {
  if (state.activeTab === id) return;
  state.activeTab = id;
  state.selected = null;  // close any open news accordion
  saveData();  // persist active tab
  renderTabs();
  renderActive();
  // Lazy-load the group's quotes only when first opened.
  if (!state.loadedGroups.has(id)) {
    await loadGroup(id);
  }
}

function render() {
  renderTabs();
  renderControls();
  renderMovers();
  renderWatchlist();
}

/* ---------------- Actions ---------------- */
function normalizeSymbol(raw) {
  return String(raw || '').trim().toUpperCase();
}

async function addTicker() {
  if (!activeGroupDef().editable) return;  // only on 'My list'
  const sym = normalizeSymbol(els.tickerInput.value);
  els.tickerInput.value = '';
  if (!sym) return;
  if (state.watchlist.includes(sym)) return; // ignore duplicates
  state.watchlist.push(sym);
  await saveData();
  const bucket = state.quotesByGroup.my;
  bucket[sym] = { status: 'loading' };
  renderActive();
  bucket[sym] = await fetchQuote(sym);
  renderActive();
}

async function removeTicker(sym) {
  state.watchlist = state.watchlist.filter((s) => s !== sym);
  delete state.quotesByGroup.my[sym];
  if (state.selected === sym) state.selected = null;
  delete newsCache[sym];
  await saveData();
  renderActive();
}

/* ---------------- Wire up ---------------- */
function bind() {
  els.refreshBtn.addEventListener('click', refreshAll);
  els.addBtn.addEventListener('click', addTicker);
  els.tickerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTicker(); });
  els.sortSelect.addEventListener('change', () => {
    state.sort = els.sortSelect.value;
    saveData();
    renderActive();
  });

  window.addEventListener('rowboat:data-change', async (e) => {
    e.preventDefault();
    const d = await loadData();
    state.watchlist = d.watchlist;
    // If the user edited My list from elsewhere, drop stale 'my' quotes so
    // they get re-fetched next time the tab is active.
    if (state.activeTab === 'my') renderActive();
  });
}

async function init() {
  bind();
  await initTheme();
  renderMarketStatus();
  const d = await loadData();
  state.watchlist = d.watchlist;
  state.activeTab = d.activeTab;
  state.sort = d.sort;
  render();
  // Zero-setup: load overview + the active tab immediately.
  loadOverview();
  loadGroup(state.activeTab);
}

init();

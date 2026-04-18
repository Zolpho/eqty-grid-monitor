/* ============================================================
   EQTY Grid Monitor · app.js
   Supabase-backed community grid bot dashboard
   ============================================================ */

'use strict';

// ── Supabase client (tiny REST wrapper, no build step needed) ──
const sb = (() => {
  const headers = () => ({
    'apikey': SUPABASE_ANON,
    'Authorization': `Bearer ${SUPABASE_ANON}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  });
  const url = (path, qs = '') => `${SUPABASE_URL}/rest/v1/${path}${qs}`;
  return {
    async select(table, qs = '') {
      const r = await fetch(url(table, qs), { headers: headers() });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    async insert(table, data) {
      const r = await fetch(url(table), {
        method: 'POST', headers: headers(), body: JSON.stringify(data)
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    async remove(table, id) {
      const r = await fetch(url(table, `?id=eq.${id}`), {
        method: 'DELETE', headers: headers()
      });
      return r.ok;
    },
    async patch(table, id, data) {
      const r = await fetch(url(table, `?id=eq.${id}`), {
        method: 'PATCH', headers: { ...headers(), 'Prefer': 'return=representation' },
        body: JSON.stringify(data)
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  };
})();

// ── State ──────────────────────────────────────────────────────
const state = {
  bots: [],
  livePrice: null,
  manualPrice: null,
  supabaseReady: false,
};

// ── DOM refs ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  priceVal: $('priceVal'), priceDot: $('priceDot'),
  kBotsTotal: $('kBotsTotal'), kCapital: $('kCapital'),
  kPnl: $('kPnl'), kApr: $('kApr'), kAlerts: $('kAlerts'),
  cardsGrid: $('cardsGrid'), emptyState: $('emptyState'),
  botTableBody: $('botTableBody'), tableEmpty: $('tableEmpty'),
  submitModal: $('submitModal'),
  openSubmitModal: $('openSubmitModal'), closeModal: $('closeModal'),
  emptyAddBtn: $('emptyAddBtn'),
  ownerInput: $('ownerInput'), strategyInput: $('strategyInput'),
  botPasteInput: $('botPasteInput'), noteInput: $('noteInput'),
  submitPaste: $('submitPaste'), submitMsg: $('submitMsg'),
  loadSample: $('loadSample'),
  apiOwner: $('apiOwner'), apiKey: $('apiKey'),
  apiSecret: $('apiSecret'), apiPassphrase: $('apiPassphrase'),
  apiStrategy: $('apiStrategy'), submitApi: $('submitApi'), apiMsg: $('apiMsg'),
  filterStrategy: $('filterStrategy'), sortBy: $('sortBy'),
  filterAlert: $('filterAlert'),
  refreshBtn: $('refreshBtn'), exportBtn: $('exportBtn'),
  themeToggle: $('themeToggle'), themeIcon: $('themeIcon'),
  lastRefresh: $('lastRefresh'),
};

const SAMPLE_PASTE = `Spot Grid
EQTY/USDT0.002806
6d 18h 20m
24h/Total Arbitrage: 5/10 time(s)
Investment(USDT)
728.892428
Total Profit(USDT)
+11.007453
(+1.51%)
Grid Profit/Unrealized PNL
13.358862
-2.351408
Break-Even
0.002621
Price Range/No. of Grids
0.0022~0.0029
9:1
Grid APR/APR
+95.63%
+78.84%`;

// ── Parser ─────────────────────────────────────────────────────
function parseBotText(raw) {
  const text = raw.replace(/\u00a0/g, ' ').trim();
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const j = lines.join('\n');
  const n = s => { const v = Number(String(s ?? '').replace(/[^0-9+\-.]/g, '')); return isFinite(v) ? v : null; };

  const pairPrice     = j.match(/([A-Z0-9]+\/[A-Z0-9]+)\s*([0-9]*\.?[0-9]+)/);
  const arbitrage     = j.match(/24h\/Total Arbitrage:\s*(\d+)\/(\d+)/i);
  const investment    = j.match(/Investment\(USDT\)\s*\n?\s*([+\-]?[0-9]*\.?[0-9]+)/i);
  const totalProfit   = j.match(/Total Profit\(USDT\)\s*\n?\s*([+\-]?[0-9]*\.?[0-9]+)/i);
  const totalProfitPct= j.match(/\(([+\-]?[0-9]*\.?[0-9]+)%\)/);
  const gpBlock       = j.match(/Grid Profit\/Unrealized PNL\s*\n?\s*([+\-]?[0-9]*\.?[0-9]+)\s*\n\s*([+\-]?[0-9]*\.?[0-9]+)/i);
  const breakEven     = j.match(/Break-Even\s*\n?\s*([0-9]*\.?[0-9]+)/i);
  const rangeBlock    = j.match(/Price Range\/No\. of Grids\s*\n?\s*([0-9]*\.?[0-9]+)\s*[~\-]\s*([0-9]*\.?[0-9]+)\s*\n\s*([0-9]+:[0-9]+)/i);
  const aprBlock      = j.match(/Grid APR\/APR\s*\n?\s*([+\-]?[0-9]*\.?[0-9]+)%\s*\n\s*([+\-]?[0-9]*\.?[0-9]+)%/i);
  const runtimeLine   = lines.find(l => /\d+d\s+\d+h/i.test(l) || /\d+h\s+\d+m/i.test(l)) || '—';

  return {
    pair:           pairPrice?.[1] ?? 'Unknown',
    snapshotPrice:  n(pairPrice?.[2]),
    runtime:        runtimeLine,
    arb24h:         n(arbitrage?.[1]) ?? 0,
    arbTotal:       n(arbitrage?.[2]) ?? 0,
    investment:     n(investment?.[1]) ?? 0,
    totalProfit:    n(totalProfit?.[1]) ?? 0,
    totalProfitPct: n(totalProfitPct?.[1]) ?? 0,
    gridProfit:     n(gpBlock?.[1]) ?? 0,
    unrealized:     n(gpBlock?.[2]) ?? 0,
    breakEven:      n(breakEven?.[1]) ?? 0,
    rangeLow:       n(rangeBlock?.[1]),
    rangeHigh:      n(rangeBlock?.[2]),
    gridBalance:    rangeBlock?.[3] ?? '—',
    gridApr:        n(aprBlock?.[1]) ?? 0,
    apr:            n(aprBlock?.[2]) ?? 0,
  };
}

// ── Range health ───────────────────────────────────────────────
function rangeHealth(price, low, high) {
  if (!isFinite(price) || !isFinite(low) || !isFinite(high))
    return { label: 'No live price', cls: 'warn', detail: 'Set a price above to enable range checks.', urgency: 1, pct: null };
  if (price < low) {
    const d = ((low - price) / low * 100).toFixed(2);
    return { label: 'Below range', cls: 'out', detail: `Price is ${d}% below the lower bound.`, urgency: 5, pct: 0 };
  }
  if (price > high) {
    const d = ((price - high) / high * 100).toFixed(2);
    return { label: 'Above range', cls: 'out', detail: `Price is ${d}% above the upper bound.`, urgency: 5, pct: 100 };
  }
  const pct = (price - low) / (high - low) * 100;
  if (pct <= 12) return { label: 'Near lower edge', cls: 'warn', detail: 'Bot is in range but close to its buy floor.', urgency: 3, pct };
  if (pct >= 88) return { label: 'Near upper edge', cls: 'warn', detail: 'Bot is in range but close to selling out.', urgency: 3, pct };
  return { label: 'Healthy', cls: 'ok', detail: 'Price sits comfortably within the configured range.', urgency: 0, pct };
}

// ── Helpers ────────────────────────────────────────────────────
const fmt = (n, d = 2) => isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const fmtP = n => isFinite(n) ? n.toFixed(6) : '—';
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m]);
const currentPrice = () => isFinite(state.manualPrice) ? state.manualPrice : state.livePrice;

// ── Render ─────────────────────────────────────────────────────
function getVisible() {
  const p = currentPrice();
  let list = state.bots.map(b => ({ ...b, health: rangeHealth(p, b.rangeLow, b.rangeHigh) }));
  const sf = el.filterStrategy.value, af = el.filterAlert.value;
  if (sf !== 'all') list = list.filter(b => b.strategy === sf);
  if (af !== 'all') list = list.filter(b => b.health.cls === af);
  switch (el.sortBy.value) {
    case 'pnl-asc':       list.sort((a,b) => a.totalProfit - b.totalProfit); break;
    case 'capital-desc':  list.sort((a,b) => b.investment - a.investment); break;
    case 'alert-first':   list.sort((a,b) => b.health.urgency - a.health.urgency || b.totalProfit - a.totalProfit); break;
    case 'newest':        list.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)); break;
    default:              list.sort((a,b) => b.totalProfit - a.totalProfit);
  }
  return list;
}

function renderKpis(bots) {
  const p = currentPrice();
  const totalCap  = bots.reduce((s, b) => s + (b.investment ?? 0), 0);
  const totalPnl  = bots.reduce((s, b) => s + (b.totalProfit ?? 0), 0);
  const aprs      = bots.filter(b => b.apr > 0).map(b => b.apr);
  const avgApr    = aprs.length ? aprs.reduce((a,v) => a+v, 0) / aprs.length : null;
  const alerts    = bots.filter(b => rangeHealth(p, b.rangeLow, b.rangeHigh).urgency >= 3).length;

  el.kBotsTotal.textContent = state.bots.length;
  el.kCapital.textContent   = `${fmt(totalCap)} USDT`;
  el.kPnl.textContent       = `${totalPnl >= 0 ? '+' : ''}${fmt(totalPnl)} USDT`;
  el.kPnl.className         = `kpi-value kpi-pnl ${totalPnl >= 0 ? 'pos' : 'neg'}`;
  el.kApr.textContent       = avgApr != null ? `${fmt(avgApr)}%` : '—';
  el.kAlerts.textContent    = alerts;
  el.kAlerts.className      = `kpi-value kpi-alert ${alerts > 0 ? 'active' : ''}`;
}

function barColor(cls) {
  return { ok: 'var(--color-success)', warn: 'var(--color-warning)', out: 'var(--color-error)' }[cls] ?? 'var(--color-text-faint)';
}

function renderCards(bots) {
  el.emptyState.hidden = bots.length > 0;
  const p = currentPrice();
  el.cardsGrid.innerHTML = bots.map(b => {
    const h       = b.health;
    const pnlCls  = b.totalProfit >= 0 ? 'pnl-pos' : 'pnl-neg';
    const buf     = isFinite(p) && b.breakEven > 0 ? ((p - b.breakEven) / b.breakEven * 100) : null;
    const barPct  = h.pct != null ? Math.min(100, Math.max(0, h.pct)) : 50;
    const apiTag  = b.apiLinked ? `<span class="badge badge-api">API</span>` : '';
    const rangeWidth = (isFinite(b.rangeHigh) && isFinite(b.rangeLow)) ? ((b.rangeHigh - b.rangeLow) / b.rangeLow * 100).toFixed(1) : '—';
    return `
    <article class="panel bot-card" id="card-${esc(b.id)}">
      <div class="card-header">
        <div class="card-meta">
          <div class="card-owner">${esc(b.owner)}</div>
          <div class="card-badges">
            <span class="badge badge-strategy">Strategy ${esc(b.strategy)}</span>
            <span class="badge badge-${h.cls}">${esc(h.label)}</span>
            ${apiTag}
          </div>
        </div>
        <button class="card-remove" onclick="removeBot('${esc(b.id)}')" aria-label="Remove ${esc(b.owner)}'s bot">✕</button>
      </div>
      <div>
        <div class="helper">${esc(b.pair)} · ${esc(b.runtime)}</div>
        <div class="pnl-row" style="margin-top:.5rem">
          <div class="pnl-main ${pnlCls}">${b.totalProfit >= 0 ? '+' : ''}${fmt(b.totalProfit)} USDT</div>
          <div class="pnl-pct">${b.totalProfitPct >= 0 ? '+' : ''}${fmt(b.totalProfitPct)}%</div>
        </div>
      </div>
      <div class="range-bar-wrap">
        <div style="display:flex;justify-content:space-between;margin-bottom:.25rem">
          <span class="helper">${fmtP(b.rangeLow)}</span>
          <span class="helper">${rangeWidth}% wide</span>
          <span class="helper">${fmtP(b.rangeHigh)}</span>
        </div>
        <div class="range-bar-track">
          <div class="range-bar-fill" style="width:${barPct}%;background:${barColor(h.cls)}"></div>
          <div class="range-bar-cursor" style="left:${barPct}%;background:${barColor(h.cls)}"></div>
        </div>
      </div>
      <div class="metrics-grid">
        <div class="metric"><div class="metric-label">Investment</div><div class="metric-value">${fmt(b.investment)} USDT</div></div>
        <div class="metric"><div class="metric-label">Break-even</div><div class="metric-value">${fmtP(b.breakEven)}</div></div>
        <div class="metric"><div class="metric-label">Grid profit</div><div class="metric-value ${b.gridProfit >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmt(b.gridProfit)}</div></div>
        <div class="metric"><div class="metric-label">Unrealized</div><div class="metric-value ${b.unrealized >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmt(b.unrealized)}</div></div>
        <div class="metric"><div class="metric-label">Grid APR</div><div class="metric-value">${fmt(b.gridApr)}%</div></div>
        <div class="metric"><div class="metric-label">Total APR</div><div class="metric-value">${fmt(b.apr)}%</div></div>
        <div class="metric"><div class="metric-label">Grids ↓:↑</div><div class="metric-value">${esc(b.gridBalance)}</div></div>
        <div class="metric"><div class="metric-label">Buffer vs BE</div><div class="metric-value ${buf != null && buf >= 0 ? 'pnl-pos' : 'pnl-neg'}">${buf != null ? `${buf >= 0 ? '+' : ''}${fmt(buf)}%` : '—'}</div></div>
      </div>
      <div class="card-alert ${h.cls}">${esc(h.detail)}</div>
      <div class="card-footer">
        <span class="card-ts">${new Date(b.createdAt).toLocaleString()}</span>
        ${b.note ? `<span class="card-note">${esc(b.note)}</span>` : ''}
      </div>
    </article>`;
  }).join('');
}

function renderTable(bots) {
  el.tableEmpty.style.display = bots.length ? 'none' : 'block';
  el.botTableBody.innerHTML = bots.map(b => {
    const h = b.health;
    const pnlSign = b.totalProfit >= 0 ? '+' : '';
    return `<tr>
      <td>${esc(b.owner)}</td>
      <td><span class="badge badge-strategy">${esc(b.strategy)}</span></td>
      <td>${fmtP(b.rangeLow)}–${fmtP(b.rangeHigh)}</td>
      <td><span class="badge badge-${h.cls}">${esc(h.label)}</span></td>
      <td style="color:${b.totalProfit >= 0 ? 'var(--color-success)' : 'var(--color-error)'}">${pnlSign}${fmt(b.totalProfit)} USDT</td>
      <td>${fmt(b.investment)}</td>
      <td>${fmtP(b.breakEven)}</td>
      <td>${fmt(b.apr)}%</td>
      <td>${b.arb24h}/${b.arbTotal}</td>
    </tr>`;
  }).join('');
}

function render() {
  const bots = getVisible();
  renderKpis(bots);
  renderCards(bots);
  renderTable(bots);
  el.lastRefresh.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
}

// ── Remove bot ────────────────────────────────────────────────
window.removeBot = async (id) => {
  if (state.supabaseReady) {
    try { await sb.remove('bots', id); } catch { /* offline fallback */ }
  }
  state.bots = state.bots.filter(b => b.id !== id);
  render();
};

// ── Submit (paste) ────────────────────────────────────────────
async function submitPasteBot() {
  const raw = el.botPasteInput.value.trim();
  if (!raw) { showMsg(el.submitMsg, 'Paste a KuCoin bot snapshot first.', 'error'); return; }
  const owner = el.ownerInput.value.trim() || 'Anonymous';
  const strategy = el.strategyInput.value;
  const note = el.noteInput.value.trim();
  const parsed = parseBotText(raw);
  const record = { owner, strategy, note, ...parsed, apiLinked: false, createdAt: new Date().toISOString() };

  el.submitPaste.disabled = true;
  el.submitPaste.textContent = 'Saving…';

  if (state.supabaseReady) {
    try {
      const [saved] = await sb.insert('bots', {
        owner, strategy, note, pair: parsed.pair,
        snapshot_price: parsed.snapshotPrice,
        runtime: parsed.runtime,
        arb_24h: parsed.arb24h, arb_total: parsed.arbTotal,
        investment: parsed.investment, total_profit: parsed.totalProfit,
        total_profit_pct: parsed.totalProfitPct,
        grid_profit: parsed.gridProfit, unrealized: parsed.unrealized,
        break_even: parsed.breakEven,
        range_low: parsed.rangeLow, range_high: parsed.rangeHigh,
        grid_balance: parsed.gridBalance,
        grid_apr: parsed.gridApr, apr: parsed.apr,
        api_linked: false,
      });
      record.id = saved.id;
      showMsg(el.submitMsg, '✓ Bot saved to community dashboard.', 'success');
    } catch (err) {
      showMsg(el.submitMsg, `Supabase error: ${err.message} — saved locally.`, 'error');
      record.id = crypto.randomUUID();
    }
  } else {
    record.id = crypto.randomUUID();
    showMsg(el.submitMsg, '⚠ Supabase not configured — bot saved locally only.', 'error');
  }

  state.bots.unshift(record);
  render();
  el.botPasteInput.value = '';
  el.ownerInput.value = '';
  el.noteInput.value = '';
  el.submitPaste.disabled = false;
  el.submitPaste.textContent = 'Submit bot';
  setTimeout(() => closeModal(), 800);
}

// ── Submit (API key) ──────────────────────────────────────────
async function submitApiBot() {
  const key = el.apiKey.value.trim(), secret = el.apiSecret.value.trim(), pass = el.apiPassphrase.value.trim();
  if (!key || !secret || !pass) { showMsg(el.apiMsg, 'All three API fields are required.', 'error'); return; }
  const owner = el.apiOwner.value.trim() || 'Anonymous';
  const strategy = el.apiStrategy.value;
  el.submitApi.disabled = true; el.submitApi.textContent = 'Saving…';

  if (state.supabaseReady) {
    try {
      // API creds are passed to a Supabase Edge Function that stores them encrypted
      // and performs the first fetch. The public table only stores the fetched stats.
      const res = await fetch(`${SUPABASE_URL}/functions/v1/sync-kucoin-bot`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_ANON}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner, strategy, apiKey: key, apiSecret: secret, apiPassphrase: pass })
      });
      if (!res.ok) throw new Error(await res.text());
      showMsg(el.apiMsg, '✓ API key stored. Bot will auto-sync every 5 minutes.', 'success');
      await loadBots();
    } catch (err) {
      showMsg(el.apiMsg, `Error: ${err.message}`, 'error');
    }
  } else {
    showMsg(el.apiMsg, '⚠ Supabase not configured. API sync requires a Supabase project.', 'error');
  }
  el.submitApi.disabled = false; el.submitApi.textContent = 'Save & sync';
}

// ── Load from Supabase ────────────────────────────────────────
async function loadBots() {
  if (!state.supabaseReady) return;
  try {
    const rows = await sb.select('bots', '?order=created_at.desc');
    state.bots = rows.map(r => ({
      id: r.id, owner: r.owner, strategy: r.strategy, note: r.note ?? '',
      pair: r.pair ?? 'EQTY/USDT', snapshotPrice: r.snapshot_price,
      runtime: r.runtime ?? '—', arb24h: r.arb_24h ?? 0, arbTotal: r.arb_total ?? 0,
      investment: r.investment ?? 0, totalProfit: r.total_profit ?? 0,
      totalProfitPct: r.total_profit_pct ?? 0,
      gridProfit: r.grid_profit ?? 0, unrealized: r.unrealized ?? 0,
      breakEven: r.break_even ?? 0, rangeLow: r.range_low, rangeHigh: r.range_high,
      gridBalance: r.grid_balance ?? '—', gridApr: r.grid_apr ?? 0, apr: r.apr ?? 0,
      apiLinked: r.api_linked ?? false, createdAt: r.created_at,
    }));
    render();
  } catch (err) {
    console.warn('Supabase load failed:', err.message);
  }
}

// ── Live price ────────────────────────────────────────────────
async function fetchPrice() {
  try {
    const r = await fetch('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=EQTY-USDT');
    if (!r.ok) throw new Error();
    const d = await r.json();
    const p = Number(d?.data?.price);
    if (!isFinite(p)) throw new Error();
    state.livePrice = p;
    el.priceVal.textContent = p.toFixed(6);
    el.priceDot.className = 'price-dot live';
    render();
  } catch {
    el.priceDot.className = 'price-dot error';
    if (!isFinite(state.manualPrice)) el.priceVal.textContent = 'n/a';
  }
}

// ── Helpers ───────────────────────────────────────────────────
function showMsg(el, msg, type) {
  el.textContent = msg;
  el.className = `submit-msg helper ${type}`;
  setTimeout(() => { el.textContent = ''; el.className = 'submit-msg helper'; }, 6000);
}

function closeModal() {
  el.submitModal.hidden = true;
  document.body.style.overflow = '';
}
function openModal() {
  el.submitModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  el.themeIcon.innerHTML = t === 'dark'
    ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
    : '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>';
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state.bots, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `eqty-grid-bots-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Tab switching ─────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected','false'); });
    document.querySelectorAll('.tab-panel').forEach(p => p.hidden = true);
    tab.classList.add('active'); tab.setAttribute('aria-selected','true');
    document.getElementById('tab-' + tab.dataset.tab).hidden = false;
  });
});

// ── Events ────────────────────────────────────────────────────
el.openSubmitModal.addEventListener('click', openModal);
el.emptyAddBtn.addEventListener('click', openModal);
el.closeModal.addEventListener('click', closeModal);
el.submitModal.addEventListener('click', e => { if (e.target === el.submitModal) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
el.submitPaste.addEventListener('click', submitPasteBot);
el.submitApi.addEventListener('click', submitApiBot);
el.loadSample.addEventListener('click', () => { el.botPasteInput.value = SAMPLE_PASTE; el.ownerInput.value = '@you'; });
el.refreshBtn.addEventListener('click', () => { fetchPrice(); loadBots(); });
el.exportBtn.addEventListener('click', exportJson);
el.filterStrategy.addEventListener('change', render);
el.filterAlert.addEventListener('change', render);
el.sortBy.addEventListener('change', render);
el.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  setTheme(next);
});
el.botPasteInput.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitPasteBot(); });

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  // Check if Supabase is configured
  state.supabaseReady = (
    typeof SUPABASE_URL === 'string' && SUPABASE_URL.includes('supabase.co') &&
    typeof SUPABASE_ANON === 'string' && SUPABASE_ANON.length > 10
  );

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(prefersDark ? 'dark' : 'light');

  render();
  await fetchPrice();
  await loadBots();

  setInterval(fetchPrice, PRICE_INTERVAL);
  setInterval(loadBots, BOT_INTERVAL);
})();

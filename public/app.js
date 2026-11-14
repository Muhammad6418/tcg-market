const S = { tab: 'today', game: 'all', lang: 'en', cap: 150, range: 52, char: null, meta: null };
const $ = (s) => document.querySelector(s);
const api = (p, q = {}) => fetch(`${p}?${new URLSearchParams(q)}`).then((r) => r.json());
const gbp = (v) => (v == null ? '—' : `£${v < 100 ? v.toFixed(2) : Math.round(v).toLocaleString('en-GB')}`);
const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`);
const cls = (v) => (v == null ? '' : v >= 0 ? 'up' : 'down');
const GAME = { pokemon: 'Pokémon', onepiece: 'One Piece' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sparkSvg(arr) {
  if (!arr) return '';
  const v = arr.filter((x) => x != null);
  if (v.length < 3) return '';
  const lo = Math.min(...v), hi = Math.max(...v), w = 100, h = 28;
  const pts = arr.map((x, i) => (x == null ? null : `${(i / (arr.length - 1)) * w},${h - 2 - ((x - lo) / (hi - lo || 1)) * (h - 4)}`)).filter(Boolean).join(' ');
  const col = v.at(-1) >= v[0] ? 'var(--up)' : 'var(--down)';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${pts}"/></svg>`;
}

function cardTile(c, i) {
  const sig = c.why?.length && i != null
    ? `<div class="why">${c.why.slice(0, 2).map(esc).join('<br>')}${c.risk?.[0] ? `<span class="warn">⚠ ${esc(c.risk[0])}</span>` : ''}</div>`
    : c.why?.[0] ? `<div class="why">${esc(c.why[0])}</div>` : '';
  return `<div class="card" data-key="${esc(c.key)}">
    ${i != null ? `<span class="rank">#${i + 1}</span>` : ''}
    <img loading="lazy" src="${esc(c.img)}" alt="${esc(c.name)}">
    <div class="nm">${esc(c.name)}</div>
    <div class="meta">${esc(c.set)}${c.number ? ` · ${esc(c.number)}` : ''}${c.variant && c.variant !== 'Normal' ? ` · ${esc(c.variant)}` : ''}</div>
    <div class="meta">${c.rarity ? `<span class="tag">${esc(c.rarity)}</span>` : ''}<span class="tag">${GAME[c.game]}</span>${c.lang === 'jp' ? '<span class="tag jp">Japanese</span>' : ''}</div>
    <div class="px"><b>${gbp(c.gbp)}</b><span class="chg ${cls(c.chg52 ?? c.chg13)}">${pct(c.chg52 ?? c.chg13)} ${c.chg52 != null ? '12m' : '3m'}</span></div>
    ${c.cm?.gbp ? `<div class="meta cmline">Cardmarket ${gbp(c.cm.gbp)}${c.cm.gbp < c.gbp * 0.95 ? ' <span class="up">cheaper</span>' : ''}</div>` : ''}
    ${sparkSvg(c.spark)}
    ${sig}
  </div>`;
}

function listRow(c, field) {
  return `<div class="li" data-key="${esc(c.key)}"><img loading="lazy" src="${esc(c.img)}" alt="">
    <div><div class="nm">${esc(c.name)}</div><div class="meta">${esc(c.set)} ${c.number ? '· ' + esc(c.number) : ''}</div></div>
    <div class="r"><b>${gbp(c.gbp)}</b><br><span class="chg ${cls(c[field])}">${pct(c[field])}</span></div></div>`;
}

// ---------- tabs ----------
async function renderToday() {
  $('#topGrid').innerHTML = '<div class="empty">Ranking cards…</div>';
  const list = await api('/api/top', { game: S.game, lang: S.lang, cap: S.cap });
  const why = S.game === 'onepiece' && S.lang === 'jp'
    ? "Japanese One Piece cards aren't covered yet: our price source only lists English One Piece. Switch to English or Both."
    : 'No cards match. Try a higher max price.';
  $('#topGrid').innerHTML = list.length ? list.map(cardTile).join('') : `<div class="empty">${why}</div>`;
}

async function renderBudget() {
  const budget = Number($('#budgetIn').value) || 100;
  $('#budgetOut').innerHTML = '<div class="empty">Working out the best mix…</div>';
  const r = await api('/api/budget', { budget, game: S.game, lang: S.lang });
  if (!r.plan.length) { $('#budgetOut').innerHTML = '<div class="empty">Nothing in the top 50 fits that budget yet.</div>'; return; }
  $('#budgetOut').innerHTML = `
    <div class="summary"><div>Budget<b>${gbp(r.budget)}</b></div><div>Spend incl. postage<b>${gbp(r.spent)}</b></div><div>Left over<b>${gbp(r.left)}</b></div></div>
    <p class="note">Picked from today's top 50, spread across a few cards so one bad pick can't sink the lot. Prices are TCGplayer market prices converted to pounds. UK listings on eBay and Cardmarket usually sit near these, so check the sold prices before you buy. Postage is £${r.assumptions.postage.toFixed(2)} a card to buy, and the break-even price allows £${r.assumptions.sellPostage.toFixed(2)} postage when you resell on eBay UK as a private seller (no selling fee).</p>
    <div class="plan">${r.plan.map((c) => `
      <div class="pick">
        <img src="${esc(c.img)}" data-key="${esc(c.key)}" alt="${esc(c.name)}">
        <div>
          <h4>Buy ${c.qty} × ${esc(c.name)}</h4>
          <div class="meta">${esc(c.set)}${c.number ? ' · ' + esc(c.number) : ''} · ${esc(c.rarity || '')} ${c.variant !== 'Normal' ? '· ' + esc(c.variant) : ''}</div>
          <div class="stats">
            <div>Price each<b>${gbp(c.gbp)}</b></div><div>Line total<b>${gbp(c.lineCost)}</b></div>
            <div>12 months<b class="${cls(c.chg52)}">${pct(c.chg52)}</b></div><div>4 weeks<b class="${cls(c.chg4)}">${pct(c.chg4)}</b></div>
            <div>Break-even sell<b>${gbp(c.sellAt)}</b></div><div>Rise needed<b>${pct(c.needed)}</b></div>
          </div>
          <ul>${c.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
          ${c.risk.length ? `<ul class="risk">${c.risk.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
          ${buyLinks(c.links)}
        </div>
      </div>`).join('')}</div>`;
}

function buyLinks(l) {
  return `<div class="buy">
    <a class="exact" href="${esc(l.tcgplayer)}" target="_blank" rel="noopener">TCGplayer: this exact card ↗</a>
    <a href="${esc(l.ebay)}" target="_blank" rel="noopener">eBay UK ↗</a>
    <a href="${esc(l.ebaySold)}" target="_blank" rel="noopener">eBay UK sold prices ↗</a>
    <a href="${esc(l.cardmarket)}" target="_blank" rel="noopener">Cardmarket ↗</a>
    <a href="${esc(l.vinted)}" target="_blank" rel="noopener">Vinted ↗</a>
  </div>
  <div class="note">eBay, Cardmarket and Vinted links search for "${esc(l.query)}": the card's name, number and version, in trading-card categories only.</div>`;
}

// full list of fallers / risers, 50 at a time, following the game, language and max-price controls
const MV = { dir: 'fall', win: 'chg4', min: 3, offset: 0 };
const WIN_LABEL = { chg4: '4 weeks', chg13: '3 months', chg52: '12 months' };
async function renderMovers(append = false) {
  if (!append) MV.offset = 0;
  const r = await api('/api/movers', { game: S.game, lang: S.lang, cap: S.cap, min: MV.min, window: MV.win, dir: MV.dir, offset: MV.offset });
  const rows = r.items.map((c) => {
    const ch = c[MV.win];
    const was = c.gbp / (1 + ch);
    return `<tr data-key="${esc(c.key)}" class="link">
      <td><img loading="lazy" src="${esc(c.img)}" alt=""></td>
      <td><b>${esc(c.name)}</b><div class="meta">${esc(c.set)}${c.number ? ' · ' + esc(c.number) : ''}${c.lang === 'jp' ? ' · Japanese' : ''}</div></td>
      <td>${gbp(was)}</td><td><b>${gbp(c.gbp)}</b></td>
      <td class="${cls(ch)}"><b>${pct(ch)}</b></td>
      <td>${c.cm?.gbp ? gbp(c.cm.gbp) : '—'}</td></tr>`;
  }).join('');
  $('#mvBody').innerHTML = append ? $('#mvBody').innerHTML + rows : rows || `<tr><td colspan="6" class="empty">No cards ${MV.dir === 'fall' ? 'fell' : 'rose'} in this range.</td></tr>`;
  MV.offset += r.items.length;
  $('#mvNote').textContent = `${r.total.toLocaleString()} cards ${MV.dir === 'fall' ? 'fell' : 'rose'} over the last ${WIN_LABEL[MV.win]} (between £${MV.min} and £${S.cap}), biggest move first. Showing ${MV.offset.toLocaleString()}. Tap a card for its chart.`;
  $('#mvMore').hidden = MV.offset >= r.total;
}
const segPick = (id, key) => { $(id).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; MV[key] = b.dataset.v; $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); renderMovers(); }; };

let idxChart;
async function renderMarket() {
  const game = S.game === 'all' ? 'pokemon' : S.game;
  $('#mkTitle').textContent = `${GAME[game]} market`;
  const m = await api('/api/market', { game, lang: S.lang === 'jp' ? 'jp' : 'en', cap: S.cap });
  const n = S.range;
  const cut = (o) => ({ dates: o.dates.slice(-n - 1), values: o.values.slice(-n - 1) });
  const all = cut(m.index.all), chase = cut(m.index.chase), sealed = cut(m.index.sealed);
  const rebase = (v) => v.map((x) => +(100 * x / v[0]).toFixed(1));
  $('#mkNote').textContent = `${S.lang === 'jp' ? 'Index uses English cards; risers and fallers show Japanese cards. ' : ''}Price index (start = 100), based on ${m.index.all.n.toLocaleString()} singles, ${m.index.chase.n.toLocaleString()} chase-rarity cards and ${m.index.sealed.n} booster boxes priced every week. ${S.game === 'all' ? 'Pick One Piece at the top to switch.' : ''}`;
  idxChart?.destroy();
  idxChart = new Chart($('#idxChart'), {
    type: 'line',
    data: { labels: all.dates, datasets: [
      { label: 'All singles', data: rebase(all.values), borderColor: '#2f5bea', pointRadius: 0, tension: .2 },
      { label: 'Chase rarities', data: rebase(chase.values), borderColor: '#d9822b', pointRadius: 0, tension: .2 },
      { label: 'Booster boxes', data: rebase(sealed.values), borderColor: '#12805c', pointRadius: 0, tension: .2 },
    ] },
    options: chartOpts((v) => v.toFixed(0)),
  });
  $('#g4').innerHTML = m.gainers4.map((c) => listRow(c, 'chg4')).join('');
  $('#l4').innerHTML = m.losers4.map((c) => listRow(c, 'chg4')).join('');
  $('#g52').innerHTML = m.gainers52.map((c) => listRow(c, 'chg52')).join('');
  renderMovers();
  const meta = S.meta;
  const f = (x) => S.game === 'all' || x.game === S.game;
  $('#news').innerHTML = meta.news.filter(f).map((x) => `<div class="n"><span class="d">${x.date} · ${GAME[x.game]} · ${esc(x.source)}</span><br><b>${esc(x.headline)}</b><br>${esc(x.why)}</div>`).join('');
  $('#cats').innerHTML = meta.catalysts.filter(f).map((x) => `<div class="n"><span class="d">${x.date} · ${GAME[x.game]}</span><br>${esc(x.event)}</div>`).join('');
}

function chartOpts(fmt) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const grid = dark ? '#262c35' : '#e3e6ea', ink = dark ? '#9aa3ae' : '#646b76';
  return {
    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: ink, boxWidth: 12 } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
    scales: { x: { ticks: { color: ink, maxTicksLimit: 8 }, grid: { display: false } }, y: { ticks: { color: ink, callback: fmt }, grid: { color: grid } } },
  };
}

function renderChips() {
  const games = S.game === 'all' ? ['pokemon', 'onepiece'] : [S.game];
  $('#chips').innerHTML = games.map((g) => `<span class="lbl">${GAME[g]}</span>${S.meta.popular[g].map((n) => `<button data-char="${esc(n)}" data-g="${g}" class="${S.char?.name === n ? 'on' : ''}">${esc(n)}</button>`).join('')}`).join('');
}

async function renderChars() {
  renderChips();
  if (!S.char) { $('#charTitle').textContent = 'Pick a character to see every version of their cards'; $('#charGrid').innerHTML = ''; return; }
  const list = await api('/api/search', { q: S.char.name, game: S.char.game, lang: S.lang, cap: S.cap });
  $('#charTitle').textContent = `${S.char.name}: ${list.length} card versions under ${gbp(S.cap)}, most valuable first`;
  $('#charGrid').innerHTML = list.map((c) => cardTile(c)).join('') || '<div class="empty">None under this price.</div>';
}

let qTimer;
async function renderSearch() {
  const q = $('#q').value.trim();
  if (q.length < 2) { $('#searchGrid').innerHTML = ''; return; }
  const list = await api('/api/search', { q, game: S.game, lang: S.lang, cap: S.cap });
  $('#searchGrid').innerHTML = list.map((c) => cardTile(c)).join('') || '<div class="empty">No cards found under this price.</div>';
}

// ---------- card modal ----------
let cardChart;
async function openCard(key) {
  const c = await api('/api/card', { key, cap: S.cap });
  if (c.error) return;
  const m = $('#modal');
  $('#modalBody').innerHTML = `
    <button class="close" onclick="modal.close()">×</button>
    <div class="mHead">
      <img src="${esc(c.img.replace('_400w', '_in_1000x1000'))}" onerror="this.src='${esc(c.img)}'" alt="${esc(c.name)}">
      <div>
        <h2>${esc(c.name)}</h2>
        <div class="meta">${GAME[c.game]} · ${esc(c.set)}${c.number ? ' · ' + esc(c.number) : ''} · ${esc(c.rarity || '')} · ${esc(c.variant)}</div>
        <div class="stats">
          <div>TCGplayer (US)<b>${gbp(c.gbp)}</b></div>
          <div>Cardmarket (EU/UK)<b>${c.cm?.gbp ? gbp(c.cm.gbp) : '—'}</b>${c.cm?.avg30 ? `<small>30-day avg ${gbp(c.cm.avg30)}</small>` : ''}</div>
          <div>4 weeks<b class="${cls(c.chg4)}">${pct(c.chg4)}</b></div>
          <div>3 months<b class="${cls(c.chg13)}">${pct(c.chg13)}</b></div>
          <div>12 months<b class="${cls(c.chg52)}">${pct(c.chg52)}</b></div>
          <div>24 months<b class="${cls(c.chg104)}">${pct(c.chg104)}</b></div>
          <div>Sell at to break even<b>${gbp(c.breakEven.sellAt)}</b></div>
        </div>
        ${c.why.length ? `<ul>${c.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${c.risk.length ? `<ul class="risk" style="color:var(--warn)">${c.risk.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${buyLinks(c.links)}
        ${cardToolsHtml(c)}
      </div>
    </div>
    <div class="row between" style="padding:0 20px"><h3>Price history (£)</h3>
      <div class="seg" id="mRange"><button data-r="13">3m</button><button data-r="52" class="on">12m</button><button data-r="104">24m</button></div></div>
    <div class="mChart"><canvas id="cardChart"></canvas></div>
    ${c.variants.length ? `<div class="mVar"><h3>Other versions of ${esc(c.base)} under ${gbp(S.cap)}</h3><div class="grid">${c.variants.map((v) => cardTile(v)).join('')}</div></div>` : ''}`;
  const draw = (n) => {
    cardChart?.destroy();
    const d = c.history.dates.slice(-n - 1), v = c.history.gbp.slice(-n - 1);
    cardChart = new Chart($('#cardChart'), {
      type: 'line',
      data: { labels: d, datasets: [{ label: 'Market price', data: v, borderColor: '#2f5bea', backgroundColor: 'rgba(47,91,234,.08)', fill: true, pointRadius: 0, tension: .2, spanGaps: true }] },
      options: { ...chartOpts((x) => gbp(x)), plugins: { ...chartOpts(gbp).plugins, legend: { display: false } } },
    });
  };
  draw(52);
  wireCardTools(c);
  $('#mRange').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $('#mRange').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); draw(+b.dataset.r); };
  if (!m.open) m.showModal();
  m.scrollTop = 0;
}

// ---------- wiring ----------
const RENDER = { today: renderToday, budget: renderBudget, market: renderMarket, chars: renderChars, search: renderSearch, mine: () => renderMine(), sets: () => renderSets(), scan: () => renderScan() };
const rerender = () => RENDER[S.tab]();

$('#tabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.tab = b.dataset.tab;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === S.tab));
  rerender();
};
$('#game').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.game = b.dataset.game;
  document.querySelectorAll('#game button').forEach((x) => x.classList.toggle('on', x === b));
  if (S.char && S.game !== 'all' && S.char.game !== S.game) S.char = null;
  rerender();
};
$('#lang').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.lang = b.dataset.lang;
  document.querySelectorAll('#lang button').forEach((x) => x.classList.toggle('on', x === b));
  rerender();
};
$('#cap').oninput = (e) => { S.cap = +e.target.value; $('#capv').textContent = `£${S.cap}`; };
$('#cap').onchange = rerender;
$('#range').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.range = +b.dataset.r; document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x === b)); renderMarket(); };
$('#budgetGo').onclick = renderBudget;
segPick('#mvDir', 'dir'); segPick('#mvWin', 'win');
$('#mvMin').onchange = (e) => { MV.min = Math.max(0, +e.target.value || 0); renderMovers(); };
$('#mvMore').onclick = () => renderMovers(true);
$('#budgetIn').onkeydown = (e) => { if (e.key === 'Enter') renderBudget(); };
$('#chips').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.char = { name: b.dataset.char, game: b.dataset.g }; renderChars(); };
$('#q').oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(renderSearch, 250); };
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-key]');
  if (el && !e.target.closest('a')) openCard(el.dataset.key);
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') e.target.close(); });

// start once every script on the page has loaded (tools.js, mine.js… define functions used here)
window.addEventListener('DOMContentLoaded', async () => {
  S.meta = await api('/api/meta');
  $('#updated').textContent = `Prices ${new Date(S.meta.updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · £1 = $${(1 / S.meta.fx).toFixed(2)} · ${S.meta.weeks} weeks of history`;
  rerender();
  checkAlertsOnOpen().catch(() => {});
  initAccounts().catch((e) => console.warn('accounts unavailable:', e.message));
  $('#acctBtn').onclick = () => openAuth('signin');
});

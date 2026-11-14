// "My cards": collection, watchlist and price alerts. Saved in this browser (localStorage),
// with export/import so people can back up or move to another device. No account needed.
const STORE_KEY = 'tcgm.v1';
const Store = {
  read() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return { collection: d.collection || [], watch: d.watch || [], alerts: d.alerts || [] };
    } catch { return { collection: [], watch: [], alerts: [] }; }
  },
  write(d) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); return true; }
    catch { toast('Could not save: your browser is blocking storage (private mode?)'); return false; }
  },
  update(fn) { const d = Store.read(); fn(d); Store.write(d); updateBadge(); return d; },
};

function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

function updateBadge() {
  const d = Store.read();
  const hits = d.alerts.filter((a) => a.hit && !a.seen).length;
  const b = document.querySelector('[data-tab="mine"]');
  if (b) b.dataset.badge = hits || '';
}

// ---------- actions used by the card view ----------
function addToCollection(c, { qty, paid, date, where }) {
  Store.update((d) => d.collection.push({ id: newId(), key: c.key, qty, paid, date, where: where || '' }));
  toast(`Added ${qty} × ${c.name} to your collection`);
}
function toggleWatch(key) {
  let on;
  Store.update((d) => { on = !d.watch.includes(key); d.watch = on ? [...d.watch, key] : d.watch.filter((k) => k !== key); });
  toast(on ? 'Added to your watchlist' : 'Removed from your watchlist');
  return on;
}
const isWatched = (key) => Store.read().watch.includes(key);

// ---------- the My cards tab ----------
let valueChart;
async function renderMine() {
  const d = Store.read();
  const el = $('#mineBody');
  const keys = [...new Set([...d.collection.map((x) => x.key), ...d.watch, ...d.alerts.map((a) => a.key)])];
  if (!keys.length) {
    el.innerHTML = `${accountNote()}<div class="empty">Nothing saved yet. Open any card and tap <b>Add to collection</b>, <b>Watch</b> or <b>Price alert</b>.<br><br><button class="ghost" id="importBtn2">Import a backup</button></div>`;
    $('#importBtn2').onclick = importData;
    return;
  }
  el.innerHTML = '<div class="empty">Loading your cards…</div>';
  const cards = new Map((await api('/api/cards', { keys: keys.join(',') })).map((c) => [c.key, c]));
  checkAlerts(cards);

  // collection totals
  const rows = d.collection.map((x) => ({ ...x, c: cards.get(x.key) })).filter((x) => x.c);
  const cost = rows.reduce((a, x) => a + x.paid * x.qty, 0);
  const value = rows.reduce((a, x) => a + x.c.gbp * x.qty, 0);
  const cmValue = rows.reduce((a, x) => a + (x.c.cm?.gbp ?? x.c.gbp) * x.qty, 0);
  const takeHome = rows.reduce((a, x) => a + sellNet(x.c.gbp, 'ebay').net * x.qty, 0);
  const pl = value - cost;
  const fresh = Store.read();

  el.innerHTML = `${accountNote()}
    <div class="row between"><h2>My collection</h2>
      <div class="row"><button class="ghost" id="exportBtn">Export backup</button><button class="ghost" id="importBtn">Import</button></div></div>
    ${rows.length ? `
    <div class="summary">
      <div>Cards<b>${rows.reduce((a, x) => a + x.qty, 0)}</b></div>
      <div>You paid<b>${gbp(cost)}</b></div>
      <div>Worth now (TCGplayer)<b>${gbp(value)}</b></div>
      <div>Worth now (Cardmarket)<b>${gbp(cmValue)}</b></div>
      <div>Profit / loss<b class="${cls(pl)}">${pl >= 0 ? '+' : '−'}${gbp(Math.abs(pl))} (${cost ? pct(pl / cost) : '—'})</b></div>
      <div>If you sold all on eBay now<b>${gbp(takeHome)}</b><small>after fees and postage</small></div>
    </div>
    <div class="row between"><h3>Collection value</h3><div class="seg" id="vRange"><button data-r="13">3m</button><button data-r="52" class="on">12m</button><button data-r="104">24m</button></div></div>
    <div class="chartBox" style="height:240px"><canvas id="valueChart"></canvas></div>
    <table class="tbl">
      <thead><tr><th></th><th>Card</th><th>Qty</th><th>Paid each</th><th>Now</th><th>P/L</th><th>Sell on eBay, you get</th><th></th></tr></thead>
      <tbody>${rows.map((x) => {
        const p = (x.c.gbp - x.paid) * x.qty;
        return `<tr>
          <td><img src="${esc(x.c.img)}" data-key="${esc(x.key)}" alt=""></td>
          <td><b data-key="${esc(x.key)}" class="link">${esc(x.c.name)}</b><div class="meta">${esc(x.c.set)}${x.c.number ? ' · ' + esc(x.c.number) : ''}${x.date ? ' · bought ' + esc(x.date) : ''}${x.where ? ' · ' + esc(x.where) : ''}</div></td>
          <td>${x.qty}</td><td>${gbp(x.paid)}</td><td>${gbp(x.c.gbp)}</td>
          <td class="${cls(p)}">${p >= 0 ? '+' : '−'}${gbp(Math.abs(p))}</td>
          <td>${gbp(sellNet(x.c.gbp, 'ebay').net)} each</td>
          <td><button class="ghost sm" data-del="${esc(x.id)}">Remove</button></td></tr>`;
      }).join('')}</tbody>
    </table>` : '<p class="note">No cards in your collection yet.</p>'}

    <h2 style="margin-top:28px">Watchlist</h2>
    ${fresh.watch.length ? `<div class="grid">${fresh.watch.map((k) => cards.get(k)).filter(Boolean).map((c) => cardTile(c)).join('')}</div>` : '<p class="note">Tap <b>Watch</b> on any card to follow its price here.</p>'}

    <h2 style="margin-top:28px">Price alerts</h2>
    <div id="alertList">${alertListHtml(cards)}</div>`;

  if (rows.length) {
    const items = rows.map((x) => `${x.key}:${x.qty}`).join(',');
    const drawValue = async (w) => {
      const v = await api('/api/value', { items, weeks: w });
      valueChart?.destroy();
      valueChart = new Chart($('#valueChart'), {
        type: 'line',
        data: { labels: v.dates, datasets: [
          { label: 'Value', data: v.values, borderColor: '#2f5bea', backgroundColor: 'rgba(47,91,234,.08)', fill: true, pointRadius: 0, tension: .2 },
          { label: 'What you paid', data: v.dates.map(() => Math.round(cost * 100) / 100), borderColor: '#9aa3ae', borderDash: [5, 4], pointRadius: 0 },
        ] },
        options: chartOpts(gbp),
      });
    };
    drawValue(52);
    $('#vRange').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $('#vRange').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); drawValue(+b.dataset.r); };
  }
  el.querySelectorAll('[data-del]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    if (!confirm('Remove this card from your collection?')) return;
    Store.update((dd) => { dd.collection = dd.collection.filter((x) => x.id !== b.dataset.del); });
    renderMine();
  });
  el.querySelectorAll('[data-alert-del]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    Store.update((dd) => { dd.alerts = dd.alerts.filter((a) => a.id !== b.dataset.alertDel); });
    renderMine();
  });
  $('#exportBtn').onclick = exportData;
  $('#importBtn').onclick = importData;
  Store.update((dd) => dd.alerts.forEach((a) => { if (a.hit) a.seen = true; }));
}

function exportData() {
  const blob = new Blob([JSON.stringify(Store.read(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tcg-market-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function importData() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    try {
      const d = JSON.parse(await inp.files[0].text());
      if (!Array.isArray(d.collection) || !Array.isArray(d.watch)) throw new Error('not a backup');
      const clean = {
        collection: d.collection.filter((x) => typeof x.key === 'string').map((x) => ({ id: String(x.id || newId()), key: x.key, qty: Math.max(1, +x.qty || 1), paid: Math.max(0, +x.paid || 0), date: String(x.date || '').slice(0, 10), where: String(x.where || '').slice(0, 40) })),
        watch: d.watch.filter((k) => typeof k === 'string'),
        alerts: (d.alerts || []).filter((a) => typeof a.key === 'string' && ['below', 'above'].includes(a.type)).map((a) => ({ id: String(a.id || newId()), key: a.key, type: a.type, value: +a.value, created: a.created })),
      };
      if (!confirm(`Replace what's saved here with this backup (${clean.collection.length} collection entries, ${clean.watch.length} watched)?`)) return;
      Store.write(clean); updateBadge(); renderMine(); toast('Backup imported');
    } catch { toast("That file isn't a TCG Market backup"); }
  };
  inp.click();
}

function accountNote() {
  if (typeof Cloud === 'undefined' || !Cloud.client) return '<p class="note">Saved on this device only. Use <b>Export backup</b> to move it to another device.</p>';
  if (Cloud.user) return `<p class="note">Saved to your account (${esc(Cloud.user.email)}): it's on every device you sign in on.</p>`;
  return '<div class="nudge">Saved on this device only. <a href="#" onclick="openAuth(\'signup\');return false">Create a free account</a> or <a href="#" onclick="openAuth(\'signin\');return false">sign in</a> to keep your cards on every device and get price alerts by email.</div>';
}

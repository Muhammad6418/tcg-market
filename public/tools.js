// Card tools shown inside the card view: add to collection, watch, price alert, sell, grade.

// ---------- selling ----------
function sellNet(price, platform = 'ebay') {
  const p = S.meta.platforms[platform];
  const fee = price * p.fee + p.fixed;
  return { net: Math.round((price - fee - p.postage) * 100) / 100, fee: Math.round(fee * 100) / 100, postage: p.postage };
}

function listingTitle(c) {
  const bits = [c.base];
  if (c.number) bits.push(c.number);
  if (/alternate art/i.test(c.name)) bits.push('Alt Art');
  if (/manga/i.test(c.name)) bits.push('Manga');
  if (/\(sp\)/i.test(c.name)) bits.push('SP');
  if (/parallel/i.test(c.name)) bits.push('Parallel');
  if (/reverse/i.test(c.variant)) bits.push('Reverse Holo');
  if (/1st edition/i.test(c.variant)) bits.push('1st Edition');
  if (c.rarity && !/^(C|UC|R|Common|Uncommon|Rare)$/i.test(c.rarity)) bits.push(c.rarity);
  bits.push(c.set.replace(/^[A-Za-z0-9]+:\s*/, ''));
  bits.push(c.lang === 'jp' ? 'Japanese' : '');
  bits.push(c.game === 'onepiece' ? 'One Piece TCG' : 'Pokemon TCG');
  bits.push('NM');
  let t = bits.filter(Boolean).join(' ').replace(/\s+/g, ' ');
  while (t.length > 80) { bits.splice(bits.length - 3, 1); t = bits.filter(Boolean).join(' '); } // eBay limit: 80 chars
  return t.slice(0, 80);
}
function listingBody(c) {
  return [
    `${c.name}${c.number ? ` (${c.number})` : ''}`,
    `Set: ${c.set}`,
    c.rarity ? `Rarity: ${c.rarity}` : '',
    c.variant && c.variant !== 'Normal' ? `Version: ${c.variant}` : '',
    `Language: ${c.lang === 'jp' ? 'Japanese' : 'English'}`,
    'Condition: Near Mint, straight from pack to sleeve (see photos).',
    'Posted in a penny sleeve and toploader, in a rigid envelope, tracked.',
  ].filter(Boolean).join('\n');
}

// ---------- grading ----------
// Expected value of sending a card to PSA, from prices the person checks on eBay sold listings.
function gradeMaths({ raw, psa10, psa9, fee, post, gem }) {
  const ev = gem * psa10 + (1 - gem) * psa9 - fee - post;
  return { ev: Math.round(ev * 100) / 100, gain: Math.round((ev - raw) * 100) / 100 };
}

// ---------- the card view's tool bar ----------
function cardToolsHtml(c) {
  const sellPrice = c.cm?.gbp ?? c.gbp;
  const today = new Date().toISOString().slice(0, 10);
  const q = encodeURIComponent;
  const sold = (grade) => `https://www.ebay.co.uk/sch/i.html?_nkw=${q(`${grade} ${c.links.query}`)}&LH_Sold=1&LH_Complete=1`;
  return `
  <div class="toolbar">
    <button class="tool" data-panel="add">＋ Add to collection</button>
    <button class="tool" id="watchBtn">${isWatched(c.key) ? '★ Watching' : '☆ Watch'}</button>
    <button class="tool" data-panel="alert">🔔 Price alert</button>
    <button class="tool" data-panel="sell">£ Sell it</button>
    ${c.sealed ? '' : '<button class="tool" data-panel="grade">PSA Worth grading?</button>'}
  </div>
  <div class="panel" id="p-add" hidden>
    <div class="form">
      <label>How many<input type="number" id="addQty" min="1" value="1"></label>
      <label>Paid each (£)<input type="number" id="addPaid" min="0" step="0.01" value="${c.gbp}"></label>
      <label>Date<input type="date" id="addDate" value="${today}"></label>
      <label>Where<select id="addWhere"><option>eBay</option><option>Cardmarket</option><option>Vinted</option><option>Facebook</option><option>Shop</option><option>Pack</option><option>Other</option></select></label>
      <button class="primary" id="addGo">Save</button>
    </div>
  </div>
  <div class="panel" id="p-alert" hidden>
    <div class="form">
      <label>Tell me when the price<select id="alType"><option value="below">drops below</option><option value="above">rises above</option></select></label>
      <label>£<input type="number" id="alVal" min="0" step="0.5" value="${Math.round(c.gbp * 0.9)}"></label>
      <button class="primary" id="alGo">Set alert</button>
    </div>
    <p class="note">Alerts are checked every time you open the site (with a notification if you allow it). Signed in, you'll also get an email the morning it triggers. Alerts use the TCGplayer price in pounds, updated daily.</p>
  </div>
  <div class="panel" id="p-sell" hidden>
    <div class="form"><label>Selling price (£)<input type="number" id="sellAt" min="0" step="0.5" value="${sellPrice}"></label></div>
    <table class="tbl sm" id="sellTable"></table>
    <p class="note" id="sellNote"></p>
    <h4>Ready-made eBay listing</h4>
    <div class="copyrow"><input id="lTitle" value="${esc(listingTitle(c))}" maxlength="80"><button class="ghost sm" data-copy="lTitle">Copy title</button></div>
    <div class="copyrow"><textarea id="lBody" rows="6">${esc(listingBody(c))}</textarea><button class="ghost sm" data-copy="lBody">Copy text</button></div>
    <p class="note">Suggested price: ${gbp(sellPrice)} (${c.cm?.gbp ? 'Cardmarket trend' : 'TCGplayer market'}). Check <a href="${esc(c.links.ebaySold)}" target="_blank" rel="noopener">recent eBay UK sold prices ↗</a> before you list. Use your own photos: buyers expect the real card.</p>
  </div>
  <div class="panel" id="p-grade" hidden>
    <p class="note">Look up what graded copies actually sold for, then enter the numbers: <a href="${esc(sold('PSA 10'))}" target="_blank" rel="noopener">PSA 10 sold ↗</a> · <a href="${esc(sold('PSA 9'))}" target="_blank" rel="noopener">PSA 9 sold ↗</a></p>
    <div class="form">
      <label>Raw (ungraded) £<input type="number" id="gRaw" step="0.5" value="${c.gbp}"></label>
      <label>PSA 10 sells for £<input type="number" id="g10" step="1" placeholder="from sold listings"></label>
      <label>PSA 9 sells for £<input type="number" id="g9" step="1" placeholder="from sold listings"></label>
      <label>Grading fee £<input type="number" id="gFee" step="1" value="25"></label>
      <label>Postage + insurance £<input type="number" id="gPost" step="1" value="8"></label>
      <label>Chance of a 10<select id="gGem"><option value="0.15">Low (15%): older or centring issues</option><option value="0.3" selected>Typical modern (30%)</option><option value="0.5">High (50%): perfect card</option></select></label>
    </div>
    <div id="gOut" class="gradeOut"></div>
  </div>`;
}

function wireCardTools(c) {
  const box = $('#modalBody');
  box.querySelectorAll('[data-panel]').forEach((b) => b.onclick = () => {
    const id = `p-${b.dataset.panel}`;
    box.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== id ? true : !p.hidden; });
    box.querySelectorAll('.tool').forEach((t) => t.classList.toggle('on', t === b && !$('#' + id).hidden));
  });
  $('#watchBtn').onclick = () => { $('#watchBtn').textContent = toggleWatch(c.key) ? '★ Watching' : '☆ Watch'; };
  $('#addGo').onclick = () => {
    const qty = Math.max(1, Math.round(+$('#addQty').value || 1));
    const paid = Math.max(0, +$('#addPaid').value || 0);
    addToCollection(c, { qty, paid, date: $('#addDate').value, where: $('#addWhere').value });
    $('#p-add').hidden = true;
  };
  $('#alGo').onclick = () => {
    const v = +$('#alVal').value;
    if (!(v > 0)) return toast('Enter a price above £0');
    createAlert(c, $('#alType').value, v);
    $('#p-alert').hidden = true;
  };
  const drawSell = () => {
    const price = +$('#sellAt').value || 0;
    const rows = Object.entries(S.meta.platforms).map(([k, p]) => {
      const r = sellNet(price, k);
      return `<tr><td><b>${esc(p.name)}</b></td><td>fee ${gbp(r.fee)}</td><td>postage ${gbp(r.postage)}</td><td>you get <b>${gbp(r.net)}</b></td></tr>`;
    });
    $('#sellTable').innerHTML = rows.join('');
    $('#sellNote').textContent = Object.values(S.meta.platforms).map((p) => `${p.name}: ${p.note}`).join(' ');
  };
  $('#sellAt').oninput = drawSell; drawSell();
  box.querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => {
    try { await navigator.clipboard.writeText($('#' + b.dataset.copy).value); toast('Copied'); } catch { $('#' + b.dataset.copy).select(); toast('Press Ctrl/Cmd+C to copy'); }
  });
  if ($('#gRaw')) {
    const drawGrade = () => {
      const v = { raw: +$('#gRaw').value || 0, psa10: +$('#g10').value || 0, psa9: +$('#g9').value || 0, fee: +$('#gFee').value || 0, post: +$('#gPost').value || 0, gem: +$('#gGem').value };
      if (!v.psa10 || !v.psa9) { $('#gOut').innerHTML = '<p class="note">Enter the PSA 10 and PSA 9 sold prices to see the answer.</p>'; return; }
      const r = gradeMaths(v);
      const yes = r.gain > Math.max(10, v.raw * 0.2);
      $('#gOut').innerHTML = `<div class="verdict ${yes ? 'up' : 'down'}">${yes ? 'Worth grading' : r.gain > 0 ? 'Only marginal: probably not worth the wait and risk' : 'Not worth grading: sell it raw'}</div>
        <p>Expected value after grading: <b>${gbp(r.ev)}</b> vs <b>${gbp(v.raw)}</b> raw. That's <b class="${cls(r.gain)}">${r.gain >= 0 ? '+' : '−'}${gbp(Math.abs(r.gain))}</b> on average, assuming a ${Math.round(v.gem * 100)}% chance of a 10, otherwise a 9.</p>
        <p class="note">Grading takes weeks to months, and a card can come back an 8 or lower, which is usually worth less than raw.</p>`;
    };
    ['gRaw', 'g10', 'g9', 'gFee', 'gPost', 'gGem'].forEach((id) => { $('#' + id).oninput = drawGrade; });
    drawGrade();
  }
}

// ---------- price alerts ----------
function createAlert(c, type, value) {
  Store.update((d) => d.alerts.push({ id: newId(), key: c.key, type, value, created: new Date().toISOString().slice(0, 10) }));
  toast(`Alert set: ${c.name} ${type === 'below' ? 'below' : 'above'} ${gbp(value)}`);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

// marks alerts whose condition is met; returns the newly hit ones
function checkAlerts(cards) {
  const fresh = [];
  Store.update((d) => d.alerts.forEach((a) => {
    const c = cards.get(a.key);
    if (!c) return;
    const met = a.type === 'below' ? c.gbp <= a.value : c.gbp >= a.value;
    if (met && !a.hit) { a.hit = new Date().toISOString().slice(0, 10); a.seen = false; fresh.push({ a, c }); }
    if (!met && a.hit) { delete a.hit; delete a.seen; }
  }));
  for (const { a, c } of fresh) {
    toast(`🔔 ${c.name} is now ${gbp(c.gbp)}`);
    try { if (Notification.permission === 'granted') new Notification('TCG Market price alert', { body: `${c.name} is now ${gbp(c.gbp)} (${a.type} ${gbp(a.value)})`, icon: c.img }); } catch { /* not supported */ }
  }
  return fresh;
}

function alertListHtml(cards) {
  const d = Store.read();
  if (!d.alerts.length) return '<p class="note">Open a card and tap <b>Price alert</b> to get told when it drops or rises past a price.</p>';
  return `<div class="list">${d.alerts.map((a) => {
    const c = cards.get(a.key);
    if (!c) return '';
    return `<div class="li ${a.hit ? 'hit' : ''}" data-key="${esc(a.key)}"><img src="${esc(c.img)}" alt="">
      <div><div class="nm">${esc(c.name)}</div><div class="meta">${a.type === 'below' ? 'Below' : 'Above'} ${gbp(a.value)} · now ${gbp(c.gbp)}${a.hit ? ` · <b class="up">triggered ${esc(a.hit)}</b>` : ''}${a.emailed ? ' · emailed ✓' : ''}</div></div>
      <div class="r"><button class="ghost sm" data-alert-del="${esc(a.id)}">Delete</button></div></div>`;
  }).join('')}</div>`;
}

// check alerts quietly whenever the site opens
async function checkAlertsOnOpen() {
  const d = Store.read();
  if (!d.alerts.length) { updateBadge(); return; }
  const cards = new Map((await api('/api/cards', { keys: [...new Set(d.alerts.map((a) => a.key))].join(',') })).map((c) => [c.key, c]));
  checkAlerts(cards);
  updateBadge();
}

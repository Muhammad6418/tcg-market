// Sets: what each set's cards are worth, its booster box price, and your progress through it.
let openSetId = null;

async function renderSets() {
  const el = $('#setsBody');
  if (openSetId) return renderSet(openSetId);
  el.innerHTML = '<div class="empty">Loading sets…</div>';
  const { pids } = ownedPids();
  const list = await api('/api/sets', { game: S.game, lang: S.lang, owned: [...pids].slice(0, 400).join(',') });
  el.innerHTML = `
    <p class="lede">Every set, newest first: what all its cards are worth together, the booster box price, and its most valuable card. Open a set to see which cards you own and which you're missing.</p>
    <input id="setQ" class="bigsearch" placeholder="Filter sets (e.g. 151, Romance Dawn, Evolving Skies)">
    <div class="setlist">${list.map((st) => {
      const have = st.owned || 0;
      return `<div class="setrow" data-set="${st.id}" data-name="${esc(st.name.toLowerCase())}">
        ${st.top ? `<img loading="lazy" src="${esc(st.top.img)}" alt="">` : '<span></span>'}
        <div><div class="nm">${esc(st.name)}</div>
          <div class="meta">${GAME[st.game]}${st.lang === 'jp' ? ' · Japanese' : ''} · ${esc(st.date || '')} · ${st.count} cards over 40p${have ? ` · <b>you own ${have}</b>` : ''}</div>
          ${have ? `<div class="bar"><i style="width:${Math.min(100, (100 * have) / st.count)}%"></i></div>` : ''}</div>
        <div class="r"><div class="meta">All cards</div><b>${gbp(st.value)}</b>${st.box ? `<div class="meta">Box ${gbp(st.box.gbp)}</div>` : ''}</div>
      </div>`;
    }).join('')}</div>`;
  $('#setQ').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    el.querySelectorAll('.setrow').forEach((r) => { r.hidden = q && !r.dataset.name.includes(q); });
  };
  el.querySelectorAll('.setrow').forEach((r) => r.onclick = () => { openSetId = +r.dataset.set; renderSet(openSetId); window.scrollTo(0, 0); });
}

function ownedPids() {
  return { pids: new Set(Store.read().collection.map((x) => Number(String(x.key).split('-')[0]))) };
}

let setMissingOnly = false;
async function renderSet(id) {
  const el = $('#setsBody');
  el.innerHTML = '<div class="empty">Loading set…</div>';
  const cards = await api('/api/set', { id });
  if (!cards.length) { openSetId = null; return renderSets(); }
  const { pids } = ownedPids();
  const have = cards.filter((c) => pids.has(c.pid));
  const missing = cards.filter((c) => !pids.has(c.pid));
  const total = cards.reduce((a, c) => a + c.gbp, 0);
  const toComplete = missing.reduce((a, c) => a + c.gbp, 0);
  const shown = setMissingOnly ? missing : cards;
  el.innerHTML = `
    <button class="ghost" id="setBack">← All sets</button>
    <h2>${esc(cards[0].set)}</h2>
    <div class="summary">
      <div>Cards over 40p<b>${cards.length}</b></div>
      <div>You own<b>${have.length} (${Math.round((100 * have.length) / cards.length)}%)</b></div>
      <div>All of them together<b>${gbp(total)}</b></div>
      <div>Cost to complete<b>${gbp(toComplete)}</b><small>at today's prices</small></div>
    </div>
    <div class="bar big"><i style="width:${(100 * have.length) / cards.length}%"></i></div>
    <label class="note"><input type="checkbox" id="missOnly" ${setMissingOnly ? 'checked' : ''}> Show only cards I'm missing</label>
    <p class="note">Cards worth under about 40p aren't tracked, so this is the list of cards worth collecting rather than every common. Add cards from their card view to tick them off.</p>
    <div class="grid">${shown.map((c) => cardTile(c).replace('class="card"', `class="card ${pids.has(c.pid) ? 'owned' : 'missing'}"`)).join('')}</div>`;
  $('#setBack').onclick = () => { openSetId = null; renderSets(); };
  $('#missOnly').onchange = (e) => { setMissingOnly = e.target.checked; renderSet(id); };
}

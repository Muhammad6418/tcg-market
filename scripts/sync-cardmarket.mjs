// Adds Cardmarket (EU/UK marketplace) prices to our cards.
//
// Cardmarket publishes free daily price guides keyed by its own product ids. The hard part is
// knowing which Cardmarket product is which TCGplayer card, so we keep a link table in
// data/cm-map.json and grow it a little every run:
//   • One Piece: Cardmarket names include the card number ("Monkey.D.Luffy (OP01-024)").
//     Versions of one number are paired in order only when both sides list the same count;
//     otherwise only the plain version is linked.
//   • Pokémon (English): TCGdex returns, per card, both the TCGplayer and Cardmarket ids. A link
//     is only saved when TCGdex's TCGplayer id is exactly our card's id.
// Writes data/cardmarket.json: { updated, eurToGbp, prices: { cardKey: [trend, low, avg30, name] } }
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'tcg-market/1.0 (+https://github.com/Muhammad6418/tcg-market)' };
const CM = 'https://downloads.s3.cardmarket.com/productCatalog';
const TCGDEX = 'https://api.tcgdex.net/v2/en';
const MAX_LOOKUPS = Number(process.env.CM_LOOKUPS || 2500); // TCGdex card lookups per run
const RETRY_DAYS = 14;                                       // re-check unmatched cards after this

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)));
    }
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const OP_NUM = /\(((?:OP|ST|EB|PRB)\d{2}-\d{3}|P-\d{3})\)/;
// plain card = just a name, optionally followed by a 3-digit number like "(022)"; anything else is a special version
const isPlain = (name) => /^[^()\[\]]+?( \(\d{3}\))?$/.test(name.trim());

async function main() {
  const catalog = JSON.parse(await readFile(path.join(ROOT, 'data/catalog.json'), 'utf8'));
  const setById = new Map(catalog.sets.map((s) => [s.id, s]));
  const cards = catalog.cards.map((c) => ({ ...c, ...setById.get(c.setId) && { game: setById.get(c.setId).game, lang: setById.get(c.setId).lang } }));
  const eurToGbp = await getJSON('https://api.frankfurter.app/latest?from=EUR&to=GBP').then((d) => d.rates.GBP).catch(() => 0.84);

  const mapPath = path.join(ROOT, 'data/cm-map.json');
  const map = existsSync(mapPath) ? JSON.parse(await readFile(mapPath, 'utf8')) : { links: {}, tried: {}, sets: {} };
  map.sets ||= {};

  const guide = new Map();
  const names = new Map();
  for (const g of [6, 18]) {
    const [pg, ps] = await Promise.all([getJSON(`${CM}/priceGuide/price_guide_${g}.json`), getJSON(`${CM}/productList/products_singles_${g}.json`)]);
    for (const p of pg.priceGuides) guide.set(p.idProduct, p);
    for (const p of ps.products) names.set(p.idProduct, p.name);
    console.log(`cardmarket game ${g}: ${pg.priceGuides.length} prices, ${ps.products.length} singles`);
    if (g === 18) linkOnePiece(ps.products, cards, map, guide, eurToGbp, catalog.usdToGbp);
  }

  await linkPokemon(cards, map);
  map.updated = new Date().toISOString();
  await writeFile(mapPath, JSON.stringify(map));

  // build today's prices for every linked card
  const prices = {};
  const usdToGbp = catalog.usdToGbp;
  let rejected = 0;
  for (const c of cards) {
    const id = map.links[c.pid];
    const p = id && guide.get(id);
    if (!p) continue;
    const rev = /reverse/i.test(c.variant);
    const pick = (f) => p[rev ? `${f}-holo` : f] ?? null;
    const trend = pick('trend'), low = pick('low'), avg30 = pick('avg30');
    if (!trend && !low) continue;
    // safety net: a price more than ~3x away from TCGplayer almost always means a wrong pairing
    const ours = c.usd ?? c.low;
    const ratio = ((trend || low) * eurToGbp) / (ours * usdToGbp);
    if (ours && (ratio > 3.2 || ratio < 0.31)) { rejected++; continue; }
    prices[c.key] = [trend || null, low || null, avg30 || null, names.get(id) || null];
  }
  await writeFile(path.join(ROOT, 'data/cardmarket.json'), JSON.stringify({ updated: new Date().toISOString(), eurToGbp, prices }));
  console.log(`linked ${Object.keys(map.links).length} products; ${Object.keys(prices).length} cards have Cardmarket prices (${rejected} hidden as implausible); EUR→GBP ${eurToGbp}`);
}

// Cardmarket names every version of a One Piece card the same ("Luffy (OP01-024)" for both the
// plain card and its alt art), so versions are paired by price: each TCGplayer version takes the
// unused Cardmarket version whose trend price is closest to its own, and only within 0.5x–2x.
function linkOnePiece(products, cards, map, guide, eurToGbp, usdToGbp) {
  for (const c of cards) if (c.game === 'onepiece') delete map.links[c.pid];
  const cmByNum = new Map();
  for (const p of products) {
    const m = p.name.match(OP_NUM);
    const g = guide.get(p.idProduct);
    const eur = g && (g.trend || g.avg30 || g.low);
    if (m && eur) (cmByNum.get(m[1]) || cmByNum.set(m[1], []).get(m[1])).push({ id: p.idProduct, gbp: eur * eurToGbp });
  }
  const tcgByNum = new Map();
  const seen = new Set();
  for (const c of cards) {
    const usd = c.usd ?? c.low;
    if (c.game !== 'onepiece' || !c.number || !usd || seen.has(c.pid)) continue;
    seen.add(c.pid);
    (tcgByNum.get(c.number) || tcgByNum.set(c.number, []).get(c.number)).push({ c, gbp: usd * usdToGbp });
  }
  let n = 0;
  for (const [num, tcg] of tcgByNum) {
    const cm = cmByNum.get(num);
    if (!cm) continue;
    const pairs = [];
    for (const t of tcg) for (const m of cm) {
      const d = Math.abs(Math.log(m.gbp / t.gbp));
      if (d <= Math.log(2)) pairs.push([d, t, m]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const usedT = new Set(), usedM = new Set();
    for (const [, t, m] of pairs) {
      if (usedT.has(t) || usedM.has(m)) continue;
      // when two Cardmarket versions sit at similar prices we can't tell them apart: skip
      const rivals = cm.filter((x) => x !== m && !usedM.has(x) && Math.abs(Math.log(x.gbp / m.gbp)) < Math.log(1.25));
      if (rivals.length && t.gbp > 5) continue;
      usedT.add(t); usedM.add(m);
      map.links[t.c.pid] = m.id; n++;
    }
  }
  console.log(`one piece: ${n} card versions linked by number + price`);
}

async function linkPokemon(cards, map) {
  // cards worth linking: English Pokémon singles over ~$2 that aren't linked or recently tried
  const now = Date.now();
  const want = new Map();
  for (const c of cards) {
    if (c.game !== 'pokemon' || c.lang !== 'en' || c.sealed || !c.number || !((c.usd ?? c.low) >= 2)) continue;
    if (map.links[c.pid] || (map.tried[c.pid] && now - map.tried[c.pid] < RETRY_DAYS * 864e5)) continue;
    want.set(c.pid, c);
  }
  console.log(`pokemon: ${want.size} cards still to link`);
  if (!want.size) return;

  // which TCGdex set is which TCGplayer set: learned by probing a card, then remembered
  const dexSets = await getJSON(`${TCGDEX}/sets`);
  const setCards = new Map();
  const wantSets = new Set([...want.values()].map((c) => c.setId));
  const knownDex = new Map(Object.entries(map.sets).map(([dex, gid]) => [dex, Number(gid)]));
  await pool(dexSets, 4, async (s) => {
    if (knownDex.has(s.id) && !wantSets.has(knownDex.get(s.id))) return;
    const full = await getJSON(`${TCGDEX}/sets/${s.id}`);
    if (!full?.cards?.length) return;
    setCards.set(s.id, full.cards);
    if (knownDex.has(s.id)) return;
    for (const probe of [full.cards.at(-1), full.cards.at(-5), full.cards[0]].filter(Boolean)) {
      const card = await getJSON(`${TCGDEX}/cards/${probe.id}`);
      const pids = Object.values(card?.pricing?.tcgplayer || {}).map((v) => v?.productId).filter(Boolean);
      const hit = pids.map((pid) => cards.find((c) => c.pid === pid)).find(Boolean);
      if (hit) { map.sets[s.id] = hit.setId; knownDex.set(s.id, hit.setId); break; }
    }
  });
  const dexByGroup = new Map();
  for (const [dex, gid] of knownDex) if (setCards.has(dex)) (dexByGroup.get(gid) || dexByGroup.set(gid, []).get(gid)).push(dex);

  const jobs = [];
  for (const c of want.values()) {
    const local = String(c.number).split('/')[0].replace(/^0+(?=\d)/, '');
    for (const dex of dexByGroup.get(c.setId) || []) {
      const hit = setCards.get(dex).find((x) => String(x.localId).replace(/^0+(?=\d)/, '') === local);
      if (hit) { jobs.push([c, hit.id]); break; }
    }
    if (!jobs.length || jobs.at(-1)[0] !== c) map.tried[c.pid] = now;
  }
  let linked = 0, looked = 0;
  await pool(jobs.slice(0, MAX_LOOKUPS), 6, async ([c, dexId]) => {
    looked++;
    const card = await getJSON(`${TCGDEX}/cards/${dexId}`).catch(() => null);
    const pids = Object.values(card?.pricing?.tcgplayer || {}).map((v) => v?.productId);
    const cmId = card?.pricing?.cardmarket?.idProduct;
    if (cmId && pids.includes(c.pid)) { map.links[c.pid] = cmId; linked++; } else map.tried[c.pid] = now;
  });
  console.log(`pokemon: looked up ${looked} of ${jobs.length}, linked ${linked} (only exact TCGplayer id matches)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

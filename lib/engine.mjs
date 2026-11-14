// Ranking, budget and market maths. All prices shown to the user are GBP.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const CHASE = /special illustration|illustration rare|hyper|secret|sec|alternate art|manga|sp\b|treasure|gold|rainbow|shiny ultra|parallel/i;
const UK_POSTAGE = 1.6;       // what a UK seller typically charges you to post one card (buying)

// Selling costs per platform, UK private seller. Estimates from public fee pages/guides (Nov 2026);
// the site shows them as estimates. Edit here and every calculation follows.
export const PLATFORMS = {
  ebay: { name: 'eBay UK', fee: 0, fixed: 0, postage: 2.0,
    note: 'No selling fee for private sellers since Oct 2024 (the buyer pays a protection fee). You pay postage: about £2 tracked with a toploader. Frequent resellers may count as a business, and business fees apply.' },
  cardmarket: { name: 'Cardmarket', fee: 0.05, fixed: 0, postage: 1.5,
    note: 'About 5% commission for private sellers. Payment fees may apply.' },
  vinted: { name: 'Vinted', fee: 0, fixed: 0, postage: 0,
    note: 'No seller fee; the buyer pays postage and buyer protection.' },
};
export const sellNet = (price, platform = 'ebay') => {
  const p = PLATFORMS[platform];
  return round(price * (1 - p.fee) - p.fixed - p.postage);
};

export function loadData(root) {
  const catalog = JSON.parse(readFileSync(path.join(root, 'data/catalog.json'), 'utf8'));
  const history = readHistory(root);
  const signals = JSON.parse(readFileSync(path.join(root, 'data/signals.json'), 'utf8'));
  const cmPath = path.join(root, 'data/cardmarket.json');
  const cm = existsSync(cmPath) ? JSON.parse(readFileSync(cmPath, 'utf8')) : { prices: {}, eurToGbp: 0.84 };
  // fill weeks the archive was missing with the previous week's price
  for (const f of history.series.values()) {
    for (let i = 1; i < f.length; i++) if (Number.isNaN(f[i]) && !Number.isNaN(f[i - 1])) f[i] = f[i - 1];
  }
  const fx = catalog.usdToGbp;
  const today = new Date(catalog.updated);

  const byKey = new Map();
  const sets = new Map(catalog.sets.map((st) => [st.id, st]));
  for (const c of catalog.cards) {
    const st = sets.get(c.setId);
    if (!st) continue;
    c.game = st.game; c.lang = st.lang || 'en'; c.set = st.name; c.setDate = st.date;
    c.sealed = !!c.sealed; c.presale = !!c.presale;
    const f = history.series.get(c.key);
    const s = f ? Array.from(f, (v) => (Number.isNaN(v) ? null : v)) : null;
    const usdNow = c.usd ?? lastVal(s) ?? c.low;
    if (usdNow == null) continue;
    const card = Object.assign(c, {
      base: baseName(c),
      gbp: round(usdNow * fx),
      chase: CHASE.test(`${c.rarity || ''} ${c.name}`),
      ageDays: c.setDate ? Math.round((today - new Date(c.setDate)) / 864e5) : 9999,
    });
    delete card.low;
    Object.assign(card, stats(s, usdNow));
    card.signal = matchSignal(card, signals.characters);
    const m = cm.prices[c.key];
    if (m) {
      const g = (v) => (v == null ? null : round(v * cm.eurToGbp));
      card.cm = { gbp: g(m[0] ?? m[1]), low: g(m[1]), avg30: g(m[2]), name: m[3] };
    }
    byKey.set(c.key, card);
  }
  // Keep only history the app can show, packed into Float32Arrays (NaN = no price) so the
  // whole thing fits in a small hosting plan's memory. Read it back with seriesOf().
  for (const k of [...history.series.keys()]) if (!byKey.has(k)) history.series.delete(k);
  const data = { history, signals, fx, sets: catalog.sets, byKey, cards: [...byKey.values()], updated: catalog.updated };
  data.index = {};
  for (const game of ['pokemon', 'onepiece']) {
    data.index[game] = {
      all: marketIndex(data, { game, filter: (c) => !c.sealed }),
      chase: marketIndex(data, { game, filter: (c) => c.chase && !c.sealed }),
      sealed: marketIndex(data, { game, filter: (c) => c.sealed && /booster box$/i.test(c.name) }),
    };
  }
  return data;
}

// History comes as data/history.bin (float32 rows) + data/history-index.json; series are
// Float32Array views into that one buffer, so nothing has to be parsed. NaN = no price.
function readHistory(root) {
  const series = new Map();
  const ip = path.join(root, 'data/history-index.json');
  if (!existsSync(ip)) return { dates: [], series };
  const { dates, keys } = JSON.parse(readFileSync(ip, 'utf8'));
  const raw = readFileSync(path.join(root, 'data/history.bin'));
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const w = dates.length;
  keys.forEach((k, r) => series.set(k, all.subarray(r * w, r * w + w)));
  return { dates, series };
}

// a card's weekly USD prices as a plain array (null where there was no price), or null if none
export function seriesOf(data, key) {
  const f = data.history.series.get(key);
  return f ? Array.from(f, (v) => (Number.isNaN(v) ? null : Math.round(v * 100) / 100)) : null;
}

const round = (v) => Math.round(v * 100) / 100;
const lastVal = (s) => { if (!s) return null; for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return s[i]; return null; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const median = (a) => { const v = a.filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };

// price around `weeksAgo`, as the median of the 3 surrounding weeks so one bad listing can't fake a move
function at(s, weeksAgo) {
  if (!s) return null;
  const i = s.length - 1 - weeksAgo;
  if (i < 1) return null;
  return median([s[i - 1], s[i], s[i + 1]]);
}

function stats(s, live) {
  const now = s ? (median([live, s.at(-1), s.at(-2)]) ?? live) : live;
  const ch = (w) => { const p = at(s, w); return p ? round(now / p - 1) : null; };
  let high13 = null, cover = 0, rets = [];
  if (s) {
    const tail = s.slice(-26);
    cover = tail.filter((v) => v != null).length / Math.max(1, tail.length);
    for (const v of s.slice(-13)) if (v != null) high13 = Math.max(high13 ?? 0, v);
    for (let i = 1; i < tail.length; i++) if (tail[i] && tail[i - 1]) rets.push(Math.log(tail[i] / tail[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const vol = rets.length > 4 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) : null;
  return {
    chg4: ch(4), chg13: ch(13), chg52: ch(52), chg104: ch(104),
    fromHigh: high13 ? round(now / high13 - 1) : null,
    vol: vol != null ? round(vol) : null,
    cover: round(cover),
  };
}

export function baseName(c) {
  let n = c.name.replace(/\s*\(\d{3}\)\s*/g, ' ').replace(/\s+-\s+[\w/]+$/, '');
  n = n.replace(/\s*\((alternate art|manga|sp|parallel|full art|special illustration rare|illustration rare|secret|.*?)\)/gi, '');
  return n.trim();
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.\-']/g, '').replace(/\s+/g, ' ');

function matchSignal(card, list) {
  const n = norm(card.name);
  for (const s of list) if (s.game === card.game && n.includes(norm(s.match))) return s;
  return null;
}

// ---- Top picks -------------------------------------------------------------
export function score(c) {
  const why = [], risk = [];
  let sc = 0;
  if (c.chg52 != null) {
    sc += clamp(c.chg52, -0.5, 1) * 30;
    if (c.chg52 > 0.15) why.push(`Up ${pct(c.chg52)} over 12 months: steady demand`);
    if (c.chg52 < -0.2) risk.push(`Down ${pct(-c.chg52)} over 12 months`);
  } else if (c.chg13 != null) sc += clamp(c.chg13, -0.5, 1) * 20;
  if (c.chg4 != null) {
    sc += clamp(c.chg4, -0.3, 0.3) * 25;
    if (c.chg4 > 0.05 && c.chg4 <= 0.5) why.push(`Rising: ${pct(c.chg4)} in the last 4 weeks`);
    if (c.chg4 > 0.5) { sc -= 15; risk.push(`Spiked ${pct(c.chg4)} in 4 weeks: you may be buying the top`); }
  }
  if ((c.chg52 ?? c.chg13 ?? 0) > 0.1 && c.fromHigh != null && c.fromHigh <= -0.08 && c.fromHigh >= -0.35) {
    sc += 12; why.push(`Dip: ${pct(-c.fromHigh)} below its 3-month high while the long-term trend is up`);
  }
  if (c.signal) {
    sc += c.signal.boost * 12;
    (c.signal.boost > 0 ? why : risk).push(c.signal.why);
  }
  if (c.chase) { sc += 8; why.push(`Chase rarity (${c.rarity || 'special art'}): these hold value best`); }
  if (c.sealed && /booster box$/i.test(c.name)) { sc += 6; why.push('Sealed booster box: supply only shrinks once it is out of print'); }
  if (c.vol != null) { sc -= c.vol * 40; if (c.vol > 0.15) risk.push('Price swings a lot week to week'); }
  const be = breakEven(c.gbp);
  if (be.needed > 0.35) { sc -= Math.min(be.needed, 2) * 15; risk.push(`Needs a ${pct(be.needed)} rise to cover postage when you sell`); }
  if (/promotion|promo/i.test(c.set)) { sc -= 8; risk.push('Promo card: fewer UK listings, harder to resell'); }
  return { score: Math.round(sc * 10) / 10, why, risk };
}

const NICHE = /participant|finalist|winner|judge|staff|pre-?release|japanese version|championship|regional|tournament|prize|top \d+|serial|error|jumbo|oversize/i;
const GOOD_SEALED = /(booster box|elite trainer box|booster bundle)$/i;

export function eligible(c, { cap = 150, min = 3 } = {}) {
  if (c.presale || c.gbp < min || c.gbp > cap || c.cover < 0.6 || c.ageDays < 56 || c.chg13 == null) return false;
  if (NICHE.test(`${c.name} ${c.set}`)) return false;           // hard to find / resell in the UK
  if (c.sealed && !GOOD_SEALED.test(c.name)) return false;       // tins, blisters, decks: skip
  // plain commons/uncommons trade too thinly for their "market price" to mean much
  if (!c.sealed && /^(common|uncommon|rare|c|uc|r|promo|pr)$/i.test(c.rarity || '') && !/alternate art|parallel|\(sp\)|manga|full art|wanted poster|1st edition/i.test(`${c.name} ${c.variant}`)) return false;
  return believable(c);
}

// TCGplayer data has occasional mispricings (a card listed at 20p, then £100).
// Drop anything whose history looks like that rather than a real move.
function believable(c) {
  for (const [w, max, minDrop] of [['chg4', 3, -0.75], ['chg13', 5, -0.85], ['chg52', 10, -0.92]]) {
    const v = c[w];
    if (v == null) continue;
    if (v > max || v < minDrop) return false; // a crash this fast is almost always a bad listing in the feed
    if (c.gbp / (1 + v) < 1.5) return false; // was under ~£1.50 at the start of the window
  }
  return true;
}

export function topPicks(data, { game = 'all', lang = 'en', cap = 150, limit = 50 } = {}) {
  const out = [];
  for (const c of data.cards) {
    if (game !== 'all' && c.game !== game) continue;
    if (lang !== 'all' && c.lang !== lang) continue;
    if (!eligible(c, { cap })) continue;
    out.push({ ...c, ...score(c) });
  }
  out.sort((a, b) => b.score - a.score);
  // one entry per product (skip duplicate variants of the same card at the top)
  // one entry per product, and at most 3 per character so one news story can't fill the list
  const seen = new Set(), per = new Map(), res = [];
  for (const c of out) {
    if (seen.has(c.pid)) continue;
    const g = `${c.game}:${(c.signal?.match || c.base.split(/\s+(ex|EX|GX|V|VMAX|VSTAR)\b/)[0]).toLowerCase()}`;
    if ((per.get(g) || 0) >= 3) continue;
    seen.add(c.pid); per.set(g, (per.get(g) || 0) + 1); res.push(c);
    if (res.length >= limit) break;
  }
  return res;
}

export function breakEven(gbp) {
  // price you must sell at on eBay UK (private seller) to get back what you paid incl. postage
  const p = PLATFORMS.ebay;
  const cost = gbp + UK_POSTAGE;
  const sell = (cost + p.fixed + p.postage) / (1 - p.fee);
  return { cost: round(cost), sellAt: round(sell), needed: round(sell / gbp - 1) };
}

export function budgetPlan(data, { budget = 100, game = 'all', lang = 'en' } = {}) {
  const picks = topPicks(data, { game, lang, cap: Math.max(10, budget * 0.45), limit: 50 }).filter((c) => c.score > 5);
  const plan = [];
  let left = budget;
  for (const c of picks) {
    if (plan.length >= 5) break;
    const unit = c.gbp + UK_POSTAGE;
    if (unit > left) continue;
    const qty = plan.length < 3 && unit * 2 <= left && unit * 2 <= budget * 0.45 ? 2 : 1;
    plan.push({ ...c, qty, lineCost: round(unit * qty), ...breakEven(c.gbp) });
    left -= unit * qty;
  }
  return { budget, spent: round(budget - left), left: round(left), plan, assumptions: { postage: UK_POSTAGE, sellPostage: PLATFORMS.ebay.postage } };
}

// ---- Market ----------------------------------------------------------------
export function marketIndex(data, { game, filter = () => true }) {
  const { dates, series } = data.history;
  if (!dates.length) return { dates: [], values: [], n: 0 };
  const basket = [];
  for (const c of data.cards) {
    if (c.game !== game || c.lang !== 'en' || !(c.usd >= 2) || !filter(c)) continue;
    const f = series.get(c.key);
    if (f && f.every((v) => !Number.isNaN(v) && v > 0)) basket.push(f);
  }
  const values = dates.map((_, i) => {
    let s = 0;
    for (const f of basket) s += Math.log(f[i] / f[0]);
    return round(100 * Math.exp(s / (basket.length || 1)));
  });
  return { dates, values, n: basket.length };
}

// every card that fell (dir -1) or rose (dir 1) over a period, biggest move first, a page at a time
export function allMovers(data, { game = 'all', lang = 'en', cap = 150, min = 3, window = 'chg4', dir = -1, offset = 0, limit = 50 }) {
  const seen = new Set();
  const list = data.cards
    .filter((c) => (game === 'all' || c.game === game) && (lang === 'all' || c.lang === lang)
      && c[window] != null && dir * c[window] > 0 && eligible(c, { cap, min }))
    .sort((a, b) => dir * (b[window] - a[window]))
    .filter((c) => !seen.has(c.pid) && seen.add(c.pid));
  return { total: list.length, items: list.slice(offset, offset + limit) };
}

export function movers(data, { game, lang = 'en', cap = 150, window = 'chg4', dir = 1, limit = 12 }) {
  return data.cards
    .filter((c) => c.game === game && (lang === 'all' || c.lang === lang) && c[window] != null && eligible(c, { cap }))
    .sort((a, b) => dir * (b[window] - a[window]))
    .slice(0, limit);
}

// ---- Search / characters ---------------------------------------------------
export function search(data, { q, game = 'all', lang = 'all', cap = Infinity, limit = 300 }) {
  const n = norm(q);
  if (n.length < 2) return [];
  const lim = n.startsWith('/') ? 400 : limit;
  return data.cards
    .filter((c) => (game === 'all' || c.game === game) && (lang === 'all' || c.lang === lang) && c.gbp <= cap && (norm(c.name).includes(n) || (c.number && (n.startsWith('/') ? norm(c.number).endsWith(n) : norm(c.number).startsWith(n)))))
    .sort((a, b) => b.gbp - a.gbp)
    .slice(0, lim);
}

export function links(c) {
  const isOP = c.game === 'onepiece';
  const extra = [];
  if (/alternate art/i.test(c.name)) extra.push('alt art');
  if (/manga/i.test(c.name)) extra.push('manga');
  if (/\(sp\)/i.test(c.name)) extra.push('SP');
  if (/reverse/i.test(c.variant)) extra.push('reverse holo');
  if (/1st edition/i.test(c.variant)) extra.push('1st edition');
  if (c.lang === 'jp') extra.push('Japanese');
  const q = c.sealed ? c.name : [c.base, c.number, ...extra, isOP ? '' : c.set.replace(/^[A-Za-z0-9]+:\s*/, '')].filter(Boolean).join(' ');
  // Cardmarket search: its own product name when we know it (without the attack list), else ours
  const cmName = c.cm?.name ? c.cm.name.replace(/\s*\[.*\]\s*/, ' ').trim() : c.base;
  const cmQuery = c.sealed ? c.name : isOP ? `${cmName}${c.number && !cmName.includes(c.number) ? ' ' + c.number : ''}` : cmName;
  const e = encodeURIComponent;
  return {
    query: q,
    tcgplayer: `https://www.tcgplayer.com/product/${c.pid}`,
    ebay: `https://www.ebay.co.uk/sch/i.html?_nkw=${e(q)}&_sacat=${c.sealed ? 183456 : 183454}&LH_PrefLoc=1`,
    ebaySold: `https://www.ebay.co.uk/sch/i.html?_nkw=${e(q)}&_sacat=${c.sealed ? 183456 : 183454}&LH_Sold=1&LH_Complete=1&LH_PrefLoc=1`,
    cardmarket: `https://www.cardmarket.com/en/${isOP ? 'OnePiece' : 'Pokemon'}/Products/Search?searchString=${e(cmQuery)}`,
    vinted: `https://www.vinted.co.uk/catalog?search_text=${e(q)}`,
  };
}

export const pct = (v) => `${Math.round(v * 100)}%`;

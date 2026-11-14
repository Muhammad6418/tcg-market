// Ranking, budget and market maths. All prices shown to the user are GBP.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const CHASE = /special illustration|illustration rare|hyper|secret|sec|alternate art|manga|sp\b|treasure|gold|rainbow|shiny ultra|parallel/i;
const UK_POSTAGE = 1.6;       // tracked large-letter / toploader, typical UK seller
const SELL_FEE = 0.128;       // eBay UK final value fee on trading cards
const SELL_FIXED = 0.3;

export function loadData(root) {
  const catalog = JSON.parse(readFileSync(path.join(root, 'data/catalog.json'), 'utf8'));
  const hPath = path.join(root, 'data/history.json');
  const history = existsSync(hPath) ? JSON.parse(readFileSync(hPath, 'utf8')) : { dates: [], series: {} };
  const signals = JSON.parse(readFileSync(path.join(root, 'data/signals.json'), 'utf8'));
  // fill weeks the archive was missing with the previous week's price
  for (const s of Object.values(history.series)) {
    for (let i = 1; i < s.length; i++) if (s[i] == null && s[i - 1] != null) s[i] = s[i - 1];
  }
  const fx = catalog.usdToGbp;
  const today = new Date(catalog.updated);

  const byKey = new Map();
  for (const c of catalog.cards) {
    const s = history.series[c.key] || null;
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
    byKey.set(c.key, card);
  }
  // keep only history the app can show, to stay inside small hosting plans' memory
  for (const k of Object.keys(history.series)) if (!byKey.has(k)) delete history.series[k];
  return { history, signals, fx, byKey, cards: [...byKey.values()], updated: catalog.updated };
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
  if (be.needed > 0.35) { sc -= Math.min(be.needed, 2) * 15; risk.push(`Needs a ${pct(be.needed)} rise to cover fees and postage when you sell`); }
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
  for (const [w, max] of [['chg4', 3], ['chg13', 5], ['chg52', 10]]) {
    const v = c[w];
    if (v == null) continue;
    if (v > max) return false;
    if (c.gbp / (1 + v) < 1.5) return false; // was under ~£1.50 at the start of the window
  }
  return true;
}

export function topPicks(data, { game = 'all', cap = 150, limit = 50 } = {}) {
  const out = [];
  for (const c of data.cards) {
    if (game !== 'all' && c.game !== game) continue;
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
  // price you must sell at (eBay UK) to get your money back, incl. postage both ways
  const cost = gbp + UK_POSTAGE;
  const sell = (cost + SELL_FIXED + UK_POSTAGE) / (1 - SELL_FEE);
  return { cost: round(cost), sellAt: round(sell), needed: round(sell / gbp - 1) };
}

export function budgetPlan(data, { budget = 100, game = 'all' } = {}) {
  const picks = topPicks(data, { game, cap: Math.max(10, budget * 0.45), limit: 50 }).filter((c) => c.score > 5);
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
  return { budget, spent: round(budget - left), left: round(left), plan, assumptions: { postage: UK_POSTAGE, sellFee: SELL_FEE } };
}

// ---- Market ----------------------------------------------------------------
export function marketIndex(data, { game, filter = () => true }) {
  const { dates, series } = data.history;
  if (!dates.length) return { dates: [], values: [], n: 0 };
  const basket = data.cards.filter((c) => c.game === game && filter(c) && series[c.key] && series[c.key].every((v) => v != null) && c.usd >= 2);
  const values = dates.map((_, i) => {
    let s = 0;
    for (const c of basket) s += Math.log(series[c.key][i] / series[c.key][0]);
    return round(100 * Math.exp(s / (basket.length || 1)));
  });
  return { dates, values, n: basket.length };
}

export function movers(data, { game, cap = 150, window = 'chg4', dir = 1, limit = 12 }) {
  return data.cards
    .filter((c) => c.game === game && c[window] != null && eligible(c, { cap }))
    .sort((a, b) => dir * (b[window] - a[window]))
    .slice(0, limit);
}

// ---- Search / characters ---------------------------------------------------
export function search(data, { q, game = 'all', cap = Infinity, limit = 300 }) {
  const n = norm(q);
  if (n.length < 2) return [];
  return data.cards
    .filter((c) => (game === 'all' || c.game === game) && c.gbp <= cap && norm(c.name).includes(n))
    .sort((a, b) => b.gbp - a.gbp)
    .slice(0, limit);
}

export function links(c) {
  const isOP = c.game === 'onepiece';
  const extra = [];
  if (/alternate art/i.test(c.name)) extra.push('alt art');
  if (/manga/i.test(c.name)) extra.push('manga');
  if (/\(sp\)/i.test(c.name)) extra.push('SP');
  if (/reverse/i.test(c.variant)) extra.push('reverse holo');
  if (/1st edition/i.test(c.variant)) extra.push('1st edition');
  const q = c.sealed ? c.name : [c.base, c.number, ...extra, isOP ? '' : c.set].filter(Boolean).join(' ');
  const e = encodeURIComponent;
  return {
    query: q,
    tcgplayer: c.url,
    ebay: `https://www.ebay.co.uk/sch/i.html?_nkw=${e(q)}&_sacat=${c.sealed ? 183456 : 183454}&LH_PrefLoc=1`,
    ebaySold: `https://www.ebay.co.uk/sch/i.html?_nkw=${e(q)}&_sacat=${c.sealed ? 183456 : 183454}&LH_Sold=1&LH_Complete=1&LH_PrefLoc=1`,
    cardmarket: `https://www.cardmarket.com/en/${isOP ? 'OnePiece' : 'Pokemon'}/Products/Search?searchString=${e(c.sealed ? c.name : [c.base, c.number && isOP ? c.number : ''].filter(Boolean).join(' '))}`,
    vinted: `https://www.vinted.co.uk/catalog?search_text=${e(q)}`,
  };
}

export const pct = (v) => `${Math.round(v * 100)}%`;

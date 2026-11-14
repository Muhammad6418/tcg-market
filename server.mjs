// TCG market app. Run: npm start  →  http://localhost:4321
// When hosted, set DATA_URL to where the daily data lives (the repo's `data` branch); the server
// downloads it on start and every 6 hours. Without DATA_URL it uses the local data/ folder.
import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as E from './lib/engine.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4321);
const DATA_URL = process.env.DATA_URL?.replace(/\/$/, '');
const cache = new Map();

async function fetchData() {
  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  for (const f of ['catalog.json', 'history-index.json', 'history.bin', 'cardmarket.json']) {
    let r;
    for (let attempt = 1; attempt <= 4; attempt++) {
      r = await fetch(`${DATA_URL}/${f}?t=${Date.now()}`); // skip GitHub's short-lived file cache
      if (r.ok) break;
      console.warn(`${f}: ${r.status}, retrying (${attempt}/4)`);
      await new Promise((ok) => setTimeout(ok, 20000 * attempt));
    }
    if (!r.ok) throw new Error(`${f}: ${r.status}`);
    const tmp = path.join(ROOT, 'data', `${f}.tmp`);
    await writeFile(tmp, Buffer.from(await r.arrayBuffer()));
    await rename(tmp, path.join(ROOT, 'data', f));
  }
}

function load() {
  data = null; // let the old copy be freed before the new one is built
  data = E.loadData(ROOT);
  cache.clear();
  console.log(`loaded ${data.cards.length} items, ${data.history.dates.length} weeks of history, prices ${data.updated}`);
}

let data;
if (DATA_URL) await fetchData();
load();
if (DATA_URL) {
  setInterval(() => fetchData().then(load).catch((e) => console.error('refresh failed:', e.message)), 6 * 3600e3);
}

const slim = (c) => ({
  key: c.key, pid: c.pid, game: c.game, name: c.name, base: c.base, variant: c.variant, set: c.set,
  setDate: c.setDate, number: c.number, rarity: c.rarity, sealed: c.sealed, presale: c.presale,
  img: `https://tcgplayer-cdn.tcgplayer.com/product/${c.pid}_400w.jpg`, lang: c.lang, gbp: c.gbp, chg4: c.chg4, chg13: c.chg13, chg52: c.chg52, chg104: c.chg104,
  fromHigh: c.fromHigh, score: c.score, why: c.why, risk: c.risk, qty: c.qty, lineCost: c.lineCost,
  sellAt: c.sellAt, needed: c.needed, spark: spark(c.key),
  cm: c.cm ? { gbp: c.cm.gbp, low: c.cm.low, avg30: c.cm.avg30 } : null,
});

const toGbp = (s) => s.map((v) => (v == null ? null : Math.round(v * data.fx * 100) / 100));
function spark(key) {
  const s = E.seriesOf(data, key);
  return s ? toGbp(s.slice(-52)) : null;
}

const POPULAR = {
  pokemon: ['Pikachu', 'Charizard', 'Umbreon', 'Gengar', 'Mewtwo', 'Mew', 'Eevee', 'Lugia', 'Rayquaza', 'Gardevoir', 'Lucario', 'Greninja', 'Snorlax', 'Mimikyu', 'Sylveon', 'Espeon', 'Raichu', 'Dragonite', 'Gyarados', 'Blastoise', 'Venusaur', 'Suicune'],
  onepiece: ['Luffy', 'Zoro', 'Sanji', 'Nami', 'Robin', 'Shanks', 'Ace', 'Law', 'Yamato', 'Hancock', 'Kid', 'Whitebeard', 'Kaido', 'Loki', 'Brook', 'Chopper', 'Usopp', 'Franky', 'Jinbe', 'Mihawk', 'Buggy', 'Uta', 'Vivi', 'Imu', 'Sabo', 'Perona'],
};

const routes = {
  '/api/meta': () => ({
    updated: data.updated, fx: data.fx, weeks: data.history.dates.length,
    first: data.history.dates[0], last: data.history.dates.at(-1),
    popular: POPULAR, news: data.signals.news, catalysts: data.signals.catalysts, platforms: E.PLATFORMS,
  }),
  '/api/top': (q) => E.topPicks(data, { game: q.game || 'all', lang: q.lang || 'en', cap: num(q.cap, 150), limit: num(q.limit, 50) }).map(slim),
  '/api/budget': (q) => {
    const r = E.budgetPlan(data, { budget: num(q.budget, 100), game: q.game || 'all', lang: q.lang || 'en' });
    return { ...r, plan: r.plan.map((c) => ({ ...slim(c), links: E.links(c) })) };
  },
  '/api/search': (q) => E.search(data, { q: q.q || '', game: q.game || 'all', lang: q.lang || 'all', cap: num(q.cap, Infinity) })
    .map((c) => ({ ...slim({ ...c, ...E.score(c) }), spark: null })),
  '/api/card': (q) => {
    const c = data.byKey.get(q.key);
    if (!c) return { error: 'not found' };
    const s = E.seriesOf(data, c.key) || [];
    const cap = num(q.cap, Infinity);
    const variants = data.cards.filter((x) => x.game === c.game && x.base === c.base && x.key !== c.key && x.gbp <= cap)
      .sort((a, b) => b.gbp - a.gbp).slice(0, 40).map((x) => ({ ...slim(x), spark: null }));
    return {
      ...slim({ ...c, ...E.score(c) }), links: E.links(c), breakEven: E.breakEven(c.gbp),
      history: { dates: data.history.dates, gbp: toGbp(s) },
      variants,
    };
  },
  // sets: value of their cards, booster box price, and the chase cards
  '/api/sets': (q) => {
    const game = q.game === 'onepiece' ? 'onepiece' : q.game === 'pokemon' ? 'pokemon' : 'all';
    const lang = q.lang === 'jp' ? 'jp' : q.lang === 'all' ? 'all' : 'en';
    const ck = `sets:${game}:${lang}`;
    const by = new Map();
    if (!cache.has(ck)) for (const c of data.cards) {
      if ((game !== 'all' && c.game !== game) || (lang !== 'all' && c.lang !== lang)) continue;
      let st = by.get(c.setId);
      if (!st) by.set(c.setId, st = { id: c.setId, name: c.set, date: c.setDate, game: c.game, lang: c.lang, count: 0, value: 0, pids: new Set(), box: null, top: null });
      if (c.sealed) { if (/booster box$/i.test(c.name) && !st.box) st.box = { key: c.key, gbp: c.gbp }; continue; }
      if (st.pids.has(c.pid)) continue; // count each card once (its main version)
      st.pids.add(c.pid); st.count++; st.value += c.gbp;
      if (c.chg52 != null) st.old = (st.old || 0) + 1;
      if (!st.top || c.gbp > st.top.gbp) st.top = { key: c.key, gbp: c.gbp, name: c.name, img: slim(c).img };
    }
    let out = cache.get(ck);
    if (!out) {
      // the feed sometimes stamps old sets with today's date: if most cards already have a year of
      // prices, the date can't be right, so drop it (those sets sort last)
      const recent = Date.parse(data.updated) - 120 * 864e5;
      for (const st of by.values()) if (st.date && Date.parse(st.date) > recent && (st.old || 0) > st.count / 2) st.date = null;
      out = [...by.values()].filter((st) => st.count >= 5 && !/promo|prize|deck|collection|tin|box set|kit/i.test(st.name))
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .map(({ old, ...st }) => ({ ...st, value: Math.round(st.value) }));
      cache.set(ck, out);
    }
    const owned = new Set(String(q.owned || '').split(',').filter(Boolean).slice(0, 400).map(Number));
    return out.map(({ pids, ...st }) => ({ ...st, owned: owned.size ? [...owned].filter((p) => pids.has(p)).length : 0 }));
  },
  '/api/set': (q) => {
    const id = Number(q.id);
    const n = (c) => parseInt(String(c.number || '').replace(/^\D+/, ''), 10) || 9999;
    const seen = new Set();
    return data.cards.filter((c) => c.setId === id && !c.sealed && !seen.has(c.pid) && seen.add(c.pid))
      .sort((a, b) => n(a) - n(b) || a.name.localeCompare(b.name))
      .map((c) => ({ ...slim(c), spark: null }));
  },
  // several cards at once (collection, watchlist, alerts): ?keys=a,b,c
  '/api/cards': (q) => String(q.keys || '').split(',').filter(Boolean).slice(0, 400)
    .map((k) => data.byKey.get(k)).filter(Boolean)
    .map((c) => ({ ...slim({ ...c, ...E.score(c) }), links: E.links(c), breakEven: E.breakEven(c.gbp) })),
  // value of a collection week by week: ?items=key:qty,key:qty&weeks=52
  '/api/value': (q) => {
    const weeks = Math.min(num(q.weeks, 52), data.history.dates.length - 1);
    const dates = data.history.dates.slice(-weeks - 1);
    const values = dates.map(() => 0);
    for (const part of String(q.items || '').split(',').slice(0, 400)) {
      const [k, n] = part.split(':');
      const c = data.byKey.get(k);
      const qty = Math.max(0, Math.min(999, Number(n) || 0));
      if (!c || !qty) continue;
      const s = (E.seriesOf(data, k) || []).slice(-weeks - 1);
      let last = null;
      for (let i = 0; i < dates.length; i++) {
        if (s[i] != null) last = s[i];
        values[i] += (i === dates.length - 1 ? c.gbp : (last ?? 0) * data.fx) * qty;
      }
    }
    return { dates, values: values.map((v) => Math.round(v * 100) / 100) };
  },
  '/api/market': (q) => {
    const game = q.game || 'pokemon';
    const cap = num(q.cap, 150);
    const lang = q.lang === 'jp' ? 'jp' : 'en';
    const ck = `market:${game}:${lang}:${cap}`;
    if (cache.has(ck)) return cache.get(ck);
    const out = {
      index: data.index[game] || data.index.pokemon,
      gainers4: E.movers(data, { game, lang, cap, window: 'chg4', dir: 1 }).map(slim),
      losers4: E.movers(data, { game, lang, cap, window: 'chg4', dir: -1 }).map(slim),
      gainers52: E.movers(data, { game, lang, cap, window: 'chg52', dir: 1 }).map(slim),
    };
    if (cache.size > 200) cache.clear();
    cache.set(ck, out);
    return out;
  },
};

const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // card thumbnails via our own server, so the scanner can compare pictures (TCGplayer's image
    // server doesn't always allow other sites to read them)
    const thumb = url.pathname.match(/^\/thumb\/(\d{1,9})\.jpg$/);
    if (thumb) {
      const r = await fetch(`https://tcgplayer-cdn.tcgplayer.com/product/${thumb[1]}_200w.jpg`);
      if (!r.ok) return send(res, 404, { error: 'no image' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (url.pathname === '/api/reload' && !DATA_URL) { load(); return send(res, 200, { ok: true }); }
    const fn = routes[url.pathname];
    if (fn) return send(res, 200, fn(Object.fromEntries(url.searchParams)));
    const file = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, { error: 'forbidden' });
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`TCG Market running on http://localhost:${PORT}`));

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

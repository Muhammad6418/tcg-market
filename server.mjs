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
  for (const f of ['catalog.json', 'history.json']) {
    const r = await fetch(`${DATA_URL}/${f}`);
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
  img: c.img, gbp: c.gbp, chg4: c.chg4, chg13: c.chg13, chg52: c.chg52, chg104: c.chg104,
  fromHigh: c.fromHigh, score: c.score, why: c.why, risk: c.risk, qty: c.qty, lineCost: c.lineCost,
  sellAt: c.sellAt, needed: c.needed, spark: spark(c.key),
});

function spark(key) {
  const s = data.history.series[key];
  if (!s) return null;
  return s.slice(-52).map((v) => (v == null ? null : Math.round(v * data.fx * 100) / 100));
}

const POPULAR = {
  pokemon: ['Pikachu', 'Charizard', 'Umbreon', 'Gengar', 'Mewtwo', 'Mew', 'Eevee', 'Lugia', 'Rayquaza', 'Gardevoir', 'Lucario', 'Greninja', 'Snorlax', 'Mimikyu', 'Sylveon', 'Espeon', 'Raichu', 'Dragonite', 'Gyarados', 'Blastoise', 'Venusaur', 'Suicune'],
  onepiece: ['Luffy', 'Zoro', 'Sanji', 'Nami', 'Robin', 'Shanks', 'Ace', 'Law', 'Yamato', 'Hancock', 'Kid', 'Whitebeard', 'Kaido', 'Loki', 'Brook', 'Chopper', 'Usopp', 'Franky', 'Jinbe', 'Mihawk', 'Buggy', 'Uta', 'Vivi', 'Imu', 'Sabo', 'Perona'],
};

const routes = {
  '/api/meta': () => ({
    updated: data.updated, fx: data.fx, weeks: data.history.dates.length,
    first: data.history.dates[0], last: data.history.dates.at(-1),
    popular: POPULAR, news: data.signals.news, catalysts: data.signals.catalysts,
  }),
  '/api/top': (q) => E.topPicks(data, { game: q.game || 'all', cap: num(q.cap, 150), limit: num(q.limit, 50) }).map(slim),
  '/api/budget': (q) => {
    const r = E.budgetPlan(data, { budget: num(q.budget, 100), game: q.game || 'all' });
    return { ...r, plan: r.plan.map((c) => ({ ...slim(c), links: E.links(c) })) };
  },
  '/api/search': (q) => E.search(data, { q: q.q || '', game: q.game || 'all', cap: num(q.cap, Infinity) })
    .map((c) => ({ ...slim({ ...c, ...E.score(c) }), spark: null })),
  '/api/card': (q) => {
    const c = data.byKey.get(q.key);
    if (!c) return { error: 'not found' };
    const s = data.history.series[c.key] || [];
    const cap = num(q.cap, Infinity);
    const variants = data.cards.filter((x) => x.game === c.game && x.base === c.base && x.key !== c.key && x.gbp <= cap)
      .sort((a, b) => b.gbp - a.gbp).slice(0, 40).map((x) => ({ ...slim(x), spark: null }));
    return {
      ...slim({ ...c, ...E.score(c) }), links: E.links(c), breakEven: E.breakEven(c.gbp),
      history: { dates: data.history.dates, gbp: s.map((v) => (v == null ? null : Math.round(v * data.fx * 100) / 100)) },
      variants,
    };
  },
  '/api/market': (q) => {
    const game = q.game || 'pokemon';
    const cap = num(q.cap, 150);
    const ck = `market:${game}:${cap}`;
    if (cache.has(ck)) return cache.get(ck);
    const out = {
      index: {
        all: E.marketIndex(data, { game, filter: (c) => !c.sealed }),
        chase: E.marketIndex(data, { game, filter: (c) => c.chase && !c.sealed }),
        sealed: E.marketIndex(data, { game, filter: (c) => c.sealed && /booster box$/i.test(c.name) }),
      },
      gainers4: E.movers(data, { game, cap, window: 'chg4', dir: 1 }).map(slim),
      losers4: E.movers(data, { game, cap, window: 'chg4', dir: -1 }).map(slim),
      gainers52: E.movers(data, { game, cap, window: 'chg52', dir: 1 }).map(slim),
    };
    if (cache.size > 200) cache.clear();
    cache.set(ck, out);
    return out;
  },
};

const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
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

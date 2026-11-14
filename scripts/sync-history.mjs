// Builds 24 months of weekly price history from tcgcsv.com's daily archives.
// Each weekly snapshot is cached in cache/weeks/, so re-runs only fetch new weeks.
// Writes data/history.json: { dates: [...], series: { key: [usd|null, ...] } }.
import { readFile, writeFile, mkdir, rm, readdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sevenBin from '7zip-bin';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'cache');
const WEEKS = path.join(CACHE, 'weeks');
const CATS = ['3', '68', '85'];
const CATS_ID = CATS.join(',');
const UA = { 'User-Agent': 'tcg-market-local/1.0' };
const MONTHS = Number(process.env.MONTHS || 24);

const exists = (p) => access(p).then(() => true, () => false);
const iso = (d) => d.toISOString().slice(0, 10);

async function latestArchiveDate() {
  // weeks are anchored on Fridays so daily runs reuse the same dates until a new Friday arrives
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);               // yesterday's archive is always there
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

async function snapshot(date) {
  const file = path.join(WEEKS, `${date}.c${CATS_ID.replace(/,/g, '-')}.json`);
  if (await exists(file)) return JSON.parse(await readFile(file, 'utf8'));
  const arc = path.join(CACHE, `${date}.7z`);
  let r;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((ok) => setTimeout(ok, 1500));
    r = await fetch(`https://tcgcsv.com/archive/tcgplayer/prices-${date}.ppmd.7z`, { headers: UA });
    if (r.status !== 429) break;
    const wait = Number(r.headers.get('retry-after')) || 20 * (attempt + 1);
    console.warn(`  ${date}: rate-limited, waiting ${wait}s`);
    await new Promise((ok) => setTimeout(ok, wait * 1000));
  }
  if (!r.ok) { console.warn(`  ${date}: no archive (${r.status})`); return null; }
  await writeFile(arc, Buffer.from(await r.arrayBuffer()));
  const out = path.join(CACHE, `x-${date}`);
  try {
    await run(sevenBin.path7za, ['x', arc, `-o${out}`, '-y', ...CATS.map((c) => `-ir!${date}/${c}/*`)], { maxBuffer: 1 << 26 });
  } catch (e) {
    console.warn(`  ${date}: extract failed (${e.signal || e.code}), will retry next run`);
    await rm(out, { recursive: true, force: true });
    await rm(arc, { force: true });
    return null;
  }
  const prices = {};
  for (const f of await walk(out)) {
    try {
      const j = JSON.parse(await readFile(f, 'utf8'));
      for (const p of j.results || []) {
        const v = p.marketPrice ?? p.midPrice;
        if (v != null) prices[`${p.productId}-${p.subTypeName.replace(/\s+/g, '')}`] = Math.round(v * 100) / 100;
      }
    } catch { /* skip unreadable file */ }
  }
  await writeFile(file, JSON.stringify(prices));
  await rm(out, { recursive: true, force: true });
  await rm(arc, { force: true });
  return prices;
}

async function main() {
  await mkdir(WEEKS, { recursive: true });
  const catalog = JSON.parse(await readFile(path.join(ROOT, 'data/catalog.json'), 'utf8'));
  const keep = new Set(catalog.cards.map((c) => c.key));

  const end = await latestArchiveDate();
  const dates = [];
  for (let d = new Date(end), n = 0; n <= Math.round(MONTHS * 52 / 12); n++) {
    dates.unshift(iso(d));
    d.setUTCDate(d.getUTCDate() - 7);
  }

  // start from the saved history, so only new or previously missing weeks are downloaded
  const hPath = path.join(ROOT, 'data/history.json');
  const old = (await exists(hPath)) ? JSON.parse(await readFile(hPath, 'utf8')) : { dates: [], series: {}, missing: [] };
  const oldIdx = new Map(old.dates.map((d, i) => [d, i]));
  const oldMissing = new Set(old.missing || []);
  const sameCats = (old.cats || '3,68') === CATS_ID; // a new game/language means every week is fetched again
  const have = (d) => sameCats && oldIdx.has(d) && !oldMissing.has(d);
  const todo = dates.filter((d) => !have(d));
  console.log(`${dates.length} weeks ${dates[0]} → ${dates.at(-1)}; ${todo.length} to download`);

  const series = {};
  const missing = [];
  for (const [idx, date] of dates.entries()) {
    if (have(date)) {
      const oi = oldIdx.get(date);
      for (const [k, a] of Object.entries(old.series)) if (a[oi] != null && keep.has(k)) (series[k] ||= [])[idx] = a[oi];
      continue;
    }
    const snap = await snapshot(date);
    if (!snap) { missing.push(date); continue; }
    for (const [k, v] of Object.entries(snap)) if (keep.has(k)) (series[k] ||= [])[idx] = v;
    console.log(`  ${date} ✓`);
  }
  for (const a of Object.values(series)) for (let i = 0; i < dates.length; i++) if (a[i] === undefined) a[i] = null;
  await writeFile(hPath, JSON.stringify({ dates, series, missing, cats: CATS_ID }));
  await writeBinary(dates, series);
  console.log(`saved history for ${Object.keys(series).length} items${missing.length ? `; still missing ${missing.join(', ')}` : ''}`);
}

// Compact copy for the website: history.bin holds every series as float32 (NaN = no price), one
// after another, and history-index.json lists the dates and which key each slot belongs to.
async function writeBinary(dates, series) {
  const keys = Object.keys(series);
  const buf = new Float32Array(keys.length * dates.length);
  keys.forEach((k, r) => series[k].forEach((v, i) => { buf[r * dates.length + i] = v == null ? NaN : v; }));
  await writeFile(path.join(ROOT, 'data/history.bin'), Buffer.from(buf.buffer));
  await writeFile(path.join(ROOT, 'data/history-index.json'), JSON.stringify({ dates, keys }));
}

if (process.argv[2] === '--binary-only') {
  const h = JSON.parse(await readFile(path.join(ROOT, 'data/history.json'), 'utf8'));
  await writeBinary(h.dates, h.series);
  console.log('wrote history.bin');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

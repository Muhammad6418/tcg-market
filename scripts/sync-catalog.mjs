// Downloads every English Pokémon and One Piece product (cards + sealed) with today's
// TCGplayer prices from tcgcsv.com, plus the USD→GBP rate. Writes data/catalog.json.
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAMES = { 3: ['pokemon', 'en'], 68: ['onepiece', 'en'], 85: ['pokemon', 'jp'] };
const BASE = 'https://tcgcsv.com/tcgplayer';
const UA = { 'User-Agent': 'tcg-market-local/1.0' };

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const ext = (p, key) => p.extendedData?.find((e) => e.name === key)?.value ?? null;
const SEALED = /booster box|booster case|elite trainer box|booster bundle|booster pack|collection|tin|blister|display|premium|starter deck|deck set|build & battle|double pack|sleeved/i;

async function main() {
  const fx = await getJSON('https://api.frankfurter.app/latest?from=USD&to=GBP')
    .then((d) => d.rates.GBP).catch(() => 0.78);
  const cards = [];
  const sets = [];
  for (const [cat, [game, lang]] of Object.entries(GAMES)) {
    const groups = (await getJSON(`${BASE}/${cat}/groups`)).results;
    console.log(`${game} (${lang}): ${groups.length} sets`);
    await pool(groups, 6, async (g) => {
      const [prods, prices] = await Promise.all([
        getJSON(`${BASE}/${cat}/${g.groupId}/products`),
        getJSON(`${BASE}/${cat}/${g.groupId}/prices`),
      ]);
      sets.push({ id: g.groupId, game, lang, name: g.name, abbr: g.abbreviation, date: g.publishedOn?.slice(0, 10) });
      const byId = new Map();
      for (const pr of prices.results) {
        if (!byId.has(pr.productId)) byId.set(pr.productId, []);
        byId.get(pr.productId).push(pr);
      }
      for (const p of prods.results) {
        const number = ext(p, 'Number');
        const rarity = ext(p, 'Rarity');
        if (/code card/i.test(p.name) || rarity === 'Code Card') continue;
        const sealed = !number && SEALED.test(p.name);
        if (!number && !sealed) continue;
        for (const pr of byId.get(p.productId) || []) {
          const market = pr.marketPrice ?? null;
          if (market == null && pr.lowPrice == null) continue;
          if ((market ?? pr.lowPrice) < 0.5 && !sealed) continue; // bulk under ~40p: not worth tracking
          // compact record: set details live in `sets`; image and page links are rebuilt from pid
          const card = {
            key: `${p.productId}-${pr.subTypeName.replace(/\s+/g, '')}`,
            pid: p.productId,
            name: p.name,
            variant: pr.subTypeName,
            setId: g.groupId,
            number,
            rarity,
            usd: market,
            low: pr.lowPrice ?? null,
          };
          if (sealed) card.sealed = true;
          if (p.presaleInfo?.isPresale) card.presale = true;
          cards.push(card);
        }
      }
    });
  }
  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  await writeFile(path.join(ROOT, 'data/catalog.json'),
    JSON.stringify({ updated: new Date().toISOString(), usdToGbp: fx, sets, cards }));
  console.log(`saved ${cards.length} priced items, USD→GBP ${fx}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

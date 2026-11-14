# TCG Market (Pokémon + One Piece)

A local web app for finding realistic cards to buy: today's top 50, a budget planner, market charts, and every version of each character.

## Run it

```bash
cd "tcg-market"
npm start
```

Then open http://localhost:4321.

## Refresh prices (once a day)

```bash
npm run refresh
```

This pulls today's prices (about 5 seconds), then adds any new weeks to the price history. Weeks already downloaded are cached in `cache/weeks/`. Restart `npm start` afterwards, or open http://localhost:4321/api/reload.

## Where the numbers come from

- **Prices, images, card numbers, exact card pages:** TCGplayer, via the free daily feed at tcgcsv.com. Prices are US market prices converted to pounds at the day's rate (frankfurter.app).
- **12 and 24-month charts:** weekly snapshots from tcgcsv.com's daily archives.
- **News and catalyst boosts:** `data/signals.json`. Edit it to change which characters get a lift or a penalty in the rankings.

## How the top 50 is ranked (`lib/engine.mjs`)

Each card scores on its 12-month trend, last-4-weeks momentum, dips below its 3-month high while the trend is up, news and catalysts for that character, and chase rarity. Points come off for price swings, for promos, and for the rise needed to cover eBay fees and postage when you sell.

Filtered out: anything over your max price, new sets under 8 weeks old (launch prices run hot), presales, plain commons and uncommons (too thinly traded), tournament and prize promos, tins and blisters, and moves too big to be real (data glitches).

Card links: TCGplayer opens the exact card page. eBay UK, Cardmarket and Vinted open a search for the card's name, number and version (alt art, SP, reverse holo and so on) in trading-card categories only. Those sites have no public exact-card links.

Not financial advice: these are signals from price data and news, not predictions.

## Hosting (website for friends)

- The code lives on GitHub. Each morning a GitHub job (`.github/workflows/refresh.yml`) pulls new prices and pushes the data files to the repo's `data` branch.
- Render runs the site (`render.yaml`). Set `DATA_URL` to `https://raw.githubusercontent.com/<you>/<repo>/data`. The site downloads the data when it starts and every 6 hours.
- To change the news boosts, edit `data/signals.json` on GitHub. Render redeploys automatically.

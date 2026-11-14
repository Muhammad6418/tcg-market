// Card scanner: take a photo, read the card number with on-device text recognition (Tesseract),
// then look the card up. The photo never leaves the phone.
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let ocrWorker;

function loadScript(src) {
  return new Promise((ok, fail) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Could not load the text reader'));
    document.head.appendChild(s);
  });
}

async function getWorker(onStatus) {
  if (ocrWorker) return ocrWorker;
  onStatus('Loading the card reader (first time only)…');
  await loadScript(TESSERACT_URL);
  ocrWorker = await Tesseract.createWorker('eng');
  return ocrWorker;
}

// crops of the photo: the card (trimmed to a 5:7 card shape) and enlarged strips along its bottom
// edge, where the number is printed (bottom-left on Pokémon, bottom-right on One Piece)
async function preparePhoto(file) {
  const img = await createImageBitmap(file);
  // assume the card fills most of the photo: take the largest centred 5:7 rectangle
  let cw = img.width, ch = cw * 7 / 5;
  if (ch > img.height) { ch = img.height; cw = ch * 5 / 7; }
  const cx = (img.width - cw) / 2, cy = (img.height - ch) / 2;
  const crop = (x0, y0, w, h, k, filter) => {
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(cw * w * k), height: Math.round(ch * h * k) });
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    if (filter) g.filter = filter;
    g.drawImage(img, cx + cw * x0, cy + ch * y0, cw * w, ch * h, 0, 0, c.width, c.height);
    return c;
  };
  const k = Math.max(1, Math.min(5, 2400 / cw)); // enlarge small photos so the tiny number is readable
  return {
    card: crop(0, 0, 1, 1, Math.min(1, 1200 / cw)),
    strips: [crop(0, 0.88, 0.55, 0.12, k, 'grayscale(1) contrast(2)'), crop(0.45, 0.88, 0.55, 0.12, k, 'grayscale(1) contrast(2)')],
    names: [crop(0, 0.02, 1, 0.09, 2, 'grayscale(1) contrast(1.8)'), crop(0, 0.84, 1, 0.1, 2, 'grayscale(1) contrast(1.8)')], // Pokémon name on top, One Piece name near the bottom
  };
}

// pull card numbers and likely name words out of the recognised text, forgiving O/0 and I/1 mix-ups
function findClues(text) {
  const up = text.toUpperCase().replace(/[|%]/g, '/');
  const digitsFix = (s) => s.replace(/[OQD]/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  const op = [...up.matchAll(/\b(OP|ST|EB|PRB)\s?([0-9OQDIL]{2})\s?[-–]?\s?([0-9OQDILSB]{3})\b/g)]
    .map((m) => `${m[1]}${digitsFix(m[2])}-${digitsFix(m[3])}`).filter((n) => /^\w+\d{2}-\d{3}$/.test(n));
  const promo = [...up.matchAll(/\bP\s?[-–]\s?([0-9OIL]{3})\b/g)].map((m) => `P-${digitsFix(m[1])}`);
  const pk = [...up.matchAll(/\b([0-9OIL]{1,3})\s?\/\s?([0-9OIL]{2,3})\b/g)]
    .map((m) => [digitsFix(m[1]), digitsFix(m[2])])
    .filter(([a, b]) => +a <= 450 && +b >= 20 && +b <= 300)
    .map(([a, b]) => `${a.padStart(3, '0')}/${b.padStart(3, '0')}`);
  // set size on its own ("…/191"): enough to narrow to a few sets when the card's own digits are blurred
  const totals = [...up.matchAll(/\/\s?([0-9OIL]{2,3})\b/g)].map((m) => digitsFix(m[1])).filter((b) => +b >= 20 && +b <= 300).map((b) => `/${b.padStart(3, '0')}`);
  const words = (text.match(/[A-Za-z][A-Za-z.'-]{3,}/g) || []).map((w) => w.toLowerCase().replace(/[.'-]/g, ''));
  return { numbers: [...new Set([...op, ...promo, ...pk])], totals: [...new Set(totals)], words: [...new Set(words)] };
}

// tiny colour fingerprint of a card picture (12x17 grid), for comparing a photo to candidates
function fingerprint(source) {
  const c = Object.assign(document.createElement('canvas'), { width: 12, height: 17 });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(source, 0, 0, 12, 17);
  const d = g.getImageData(0, 0, 12, 17).data;
  const v = [];
  let mean = 0;
  for (let i = 0; i < d.length; i += 4) { v.push(d[i], d[i + 1], d[i + 2]); mean += d[i] + d[i + 1] + d[i + 2]; }
  mean /= v.length;
  return v.map((x) => x - mean); // ignore overall brightness
}
const distance = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return s; };

async function cardImage(url) {
  const r = await fetch(url);
  const bmp = await createImageBitmap(await r.blob());
  // TCGplayer pictures sit on white: trim to the card's 5:7 shape, centred
  let w = bmp.width, h = w * 7 / 5;
  if (h > bmp.height) { h = bmp.height; w = h * 5 / 7; }
  const c = Object.assign(document.createElement('canvas'), { width: 60, height: 84 });
  c.getContext('2d').drawImage(bmp, (bmp.width - w) / 2, (bmp.height - h) / 2, w, h, 0, 0, 60, 84);
  return c;
}

async function rankByLook(photoCard, candidates, onStatus) {
  if (candidates.length < 2) return candidates;
  onStatus(`Comparing your photo with ${candidates.length} possible cards…`);
  const fp = fingerprint(photoCard);
  const scored = [];
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < candidates.length) {
      const c = candidates[i++];
      try { scored.push([distance(fp, fingerprint(await cardImage(`/thumb/${c.pid}.jpg`))), c]); }
      catch { scored.push([Infinity, c]); }
    }
  }));
  return scored.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

async function identify(file, onStatus) {
  const worker = await getWorker(onStatus);
  onStatus('Reading the card…');
  const { card, strips, names } = await preparePhoto(file);
  let text = '';
  await worker.setParameters({ tessedit_pageseg_mode: '11' });
  for (const s of [...strips, ...names]) text += '\n' + (await worker.recognize(s)).data.text;
  await worker.setParameters({ tessedit_pageseg_mode: '3' });
  text += '\n' + (await worker.recognize(card)).data.text;
  const clues = findClues(text);
  onStatus(clues.numbers.length ? `Found ${clues.numbers.join(', ')}. Looking it up…` : 'No clear card number. Matching by name and picture…');

  let candidates = [];
  for (const n of clues.numbers) {
    const found = await api('/api/search', { q: n, lang: 'all' });
    const named = found.filter((c) => c.base.toLowerCase().replace(/[.'-]/g, '').split(/\s+/).some((w) => w.length > 3 && clues.words.includes(w)));
    candidates.push(...(named.length ? named : found));
  }
  if (!candidates.length) {
    // a character name we know (e.g. "Monkey.D.Luffy", "Shanks"): every version of it
    const known = [...S.meta.popular.pokemon, ...S.meta.popular.onepiece].map((n) => n.toLowerCase());
    const nameHit = clues.words.find((w) => known.some((k) => w.includes(k)));
    if (nameHit) candidates.push(...await api('/api/search', { q: known.find((k) => nameHit.includes(k)), lang: 'all' }));
  }
  for (const t of clues.totals) {
    if (candidates.length) break;
    candidates.push(...await api('/api/search', { q: t, lang: 'all' })); // every card from sets of that size
  }
  if (!candidates.length) {
    // any other long word, longest first, all versions of that name
    for (const w of clues.words.filter((x) => x.length > 4).sort((a, b) => b.length - a.length).slice(0, 5)) {
      const found = await api('/api/search', { q: w, lang: 'all' });
      if (found.length) { candidates.push(...found); break; }
    }
  }
  const seen = new Set();
  candidates = candidates.filter((c) => !seen.has(c.pid) && seen.add(c.pid)).slice(0, 160);
  const ranked = await rankByLook(card, candidates, onStatus);
  return { clues, text, results: ranked.slice(0, 24) };
}

function renderScan() {
  const el = $('#scanBody');
  if (el.dataset.ready) return;
  el.dataset.ready = '1';
  el.innerHTML = `
    <p class="lede">Take a photo of a card, or pick one from your photos. The card number at the bottom (like <b>OP01-024</b> or <b>199/165</b>) is read on your phone and matched. Photos aren't uploaded anywhere.</p>
    <label class="scanbtn primary">📷 Scan a card<input type="file" id="scanFile" accept="image/*" capture="environment" hidden></label>
    <div id="scanStatus" class="note"></div>
    <div class="scanwrap"><img id="scanPreview" alt="" hidden></div>
    <div id="scanFix" hidden><p class="note">Not right? Type the number or name from the card:</p><input id="scanQ" class="bigsearch" placeholder="e.g. OP01-024 or Charizard 199/165"></div>
    <div class="grid" id="scanGrid"></div>`;
  const status = (t) => { $('#scanStatus').textContent = t; };
  $('#scanFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('#scanPreview').src = URL.createObjectURL(file); $('#scanPreview').hidden = false;
    $('#scanGrid').innerHTML = '';
    try {
      const r = await identify(file, status);
      status(r.results.length ? `Best matches${r.clues.numbers.length ? ` for ${r.clues.numbers.join(', ')}` : ''}: tap yours.` : "Couldn't read this card. Try a sharper, closer photo in good light, or type it below.");
      $('#scanGrid').innerHTML = r.results.map((c) => cardTile(c)).join('');
      $('#scanQ').value = r.clues.numbers[0] || '';
    } catch (err) {
      status(`Scanning failed: ${err.message}. You can type the card instead.`);
    }
    $('#scanFix').hidden = false;
    e.target.value = '';
  };
  let t;
  $('#scanQ').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = e.target.value.trim();
      if (q.length < 2) return;
      $('#scanGrid').innerHTML = (await api('/api/search', { q, lang: 'all' })).slice(0, 24).map((c) => cardTile(c)).join('');
    }, 300);
  };
}

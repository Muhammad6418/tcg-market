// Emails people whose price alerts have triggered. Runs once a day after the price refresh.
// Needs (as GitHub secrets): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY,
// ALERT_FROM_EMAIL (a sender address verified in Brevo) and SITE_URL. Missing any → skips.
// DRY_RUN=1 prints what would be sent instead of sending.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY, ALERT_FROM_EMAIL, SITE_URL = '', DRY_RUN } = process.env;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gbp = (v) => `£${v.toFixed(2)}`;

async function db(pathAndQuery, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}${pathAndQuery}`, {
    ...opts,
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', ...opts.headers },
  });
  if (!r.ok) throw new Error(`${pathAndQuery.split('?')[0]}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !BREVO_API_KEY || !ALERT_FROM_EMAIL) {
    console.log('Email alerts not set up (missing secrets): skipping.');
    return;
  }
  const catalog = JSON.parse(await readFile(path.join(ROOT, 'data/catalog.json'), 'utf8'));
  const fx = catalog.usdToGbp;
  const cards = new Map(catalog.cards.map((c) => [c.key, c]));

  const alerts = await db('/rest/v1/alerts?emailed_at=is.null&select=id,user_id,card_key,kind,price');
  const optedOut = new Set((await db('/rest/v1/settings?email_alerts=eq.false&select=user_id')).map((r) => r.user_id));
  const due = new Map(); // user → triggered alerts
  for (const a of alerts) {
    const c = cards.get(a.card_key);
    const usd = c && (c.usd ?? c.low);
    if (!usd || optedOut.has(a.user_id)) continue;
    const now = Math.round(usd * fx * 100) / 100;
    const hit = a.kind === 'below' ? now <= Number(a.price) : now >= Number(a.price);
    if (hit) (due.get(a.user_id) || due.set(a.user_id, []).get(a.user_id)).push({ ...a, now, name: c.name, pid: c.pid });
  }
  console.log(`${alerts.length} open alerts; ${[...due.values()].flat().length} triggered for ${due.size} people`);

  for (const [userId, list] of due) {
    const user = await db(`/auth/v1/admin/users/${userId}`);
    if (!user?.email) continue;
    const rows = list.map((a) => `<tr>
      <td style="padding:8px"><img src="https://tcgplayer-cdn.tcgplayer.com/product/${a.pid}_200w.jpg" width="60" alt=""></td>
      <td style="padding:8px"><b>${esc(a.name)}</b><br>Now <b>${gbp(a.now)}</b> (your alert: ${a.kind} ${gbp(Number(a.price))})<br>
      <a href="https://www.tcgplayer.com/product/${a.pid}">See this card</a></td></tr>`).join('');
    const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px">
      <h2>Your price alert${list.length > 1 ? 's' : ''} triggered</h2><table>${rows}</table>
      <p><a href="${esc(SITE_URL)}">Open TCG Market</a> to see the charts and buy links.</p>
      <p style="color:#888;font-size:12px">Prices are TCGplayer market prices in pounds, updated daily. Each alert is emailed once.
      To stop these emails, turn off email alerts in your account on the site.</p></div>`;
    const subject = list.length > 1 ? `${list.length} price alerts triggered` : `${list[0].name} is now ${gbp(list[0].now)}`;
    if (DRY_RUN) { console.log(`would email ${user.email}: ${subject}`); continue; }
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: { email: ALERT_FROM_EMAIL, name: 'TCG Market' }, to: [{ email: user.email }], subject, htmlContent: html }),
    });
    if (!r.ok) { console.error(`email to user ${userId.slice(0, 8)} failed: ${r.status} ${await r.text()}`); continue; }
    await db(`/rest/v1/alerts?id=in.(${list.map((a) => `"${a.id}"`).join(',')})`, { method: 'PATCH', body: JSON.stringify({ emailed_at: new Date().toISOString() }), headers: { Prefer: 'return=minimal' } });
    console.log(`emailed user ${userId.slice(0, 8)} about ${list.length} alert(s)`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });

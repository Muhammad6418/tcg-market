// Accounts (Supabase): sign in with email + password, and keep collection, watchlist and alerts
// in the person's account so they follow them across devices. The browser copy stays the working
// copy; every change is also sent to the account. Without Supabase settings the site works as
// before, saving on the device only.
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
const Cloud = { client: null, user: null, settings: { email_alerts: true } };

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------- mapping between the site's saved data and the database rows ----------
const toRow = {
  collection: (x) => ({ id: x.id, card_key: x.key, qty: x.qty, paid: x.paid, bought: x.date || null, source: x.where || null }),
  alerts: (a) => ({ id: a.id, card_key: a.key, kind: a.type, price: a.value }),
};
const fromRow = {
  collection: (r) => ({ id: r.id, key: r.card_key, qty: r.qty, paid: Number(r.paid), date: r.bought || '', where: r.source || '' }),
  alerts: (r) => ({ id: r.id, key: r.card_key, type: r.kind, value: Number(r.price), created: r.created_at?.slice(0, 10), emailed: !!r.emailed_at }),
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- send local changes to the account ----------
const rawWrite = Store.write;
Store.write = (d) => {
  const before = Store.read();
  const ok = rawWrite(d);
  if (ok && Cloud.user) push(before, d).catch((e) => toast(`Couldn't save to your account: ${e.message}`));
  return ok;
};

async function push(before, after) {
  const db = Cloud.client;
  for (const t of ['collection', 'alerts']) {
    const old = new Map(before[t].map((x) => [x.id, toRow[t](x)]));
    const now = new Map(after[t].map((x) => [x.id, toRow[t](x)]));
    const upserts = [...now.values()].filter((r) => !old.has(r.id) || !same(old.get(r.id), r));
    const deletes = [...old.keys()].filter((id) => !now.has(id));
    if (upserts.length) { const { error } = await db.from(t).upsert(upserts); if (error) throw error; }
    if (deletes.length) { const { error } = await db.from(t).delete().in('id', deletes); if (error) throw error; }
  }
  const wasW = new Set(before.watch), nowW = new Set(after.watch);
  const addW = [...nowW].filter((k) => !wasW.has(k)), delW = [...wasW].filter((k) => !nowW.has(k));
  if (addW.length) { const { error } = await db.from('watch').upsert(addW.map((card_key) => ({ card_key }))); if (error) throw error; }
  if (delW.length) { const { error } = await db.from('watch').delete().in('card_key', delW); if (error) throw error; }
}

// ---------- on sign-in: combine what's on this device with what's in the account ----------
async function pull() {
  const db = Cloud.client;
  const [c, w, a, s] = await Promise.all([
    db.from('collection').select('*'), db.from('watch').select('card_key'), db.from('alerts').select('*'), db.from('settings').select('*').maybeSingle(),
  ]);
  for (const r of [c, w, a]) if (r.error) throw r.error;
  Cloud.settings = s.data || { email_alerts: true };
  const local = Store.read();
  const cloud = { collection: c.data.map(fromRow.collection), watch: w.data.map((r) => r.card_key), alerts: a.data.map(fromRow.alerts) };
  // anything only on this device gets added to the account (nothing is ever dropped)
  const merged = {
    collection: [...cloud.collection, ...local.collection.filter((x) => !cloud.collection.some((y) => y.id === x.id))],
    watch: [...new Set([...cloud.watch, ...local.watch])],
    alerts: [...cloud.alerts.map((x) => ({ ...local.alerts.find((y) => y.id === x.id), ...x })), ...local.alerts.filter((x) => !cloud.alerts.some((y) => y.id === x.id))],
  };
  const added = merged.collection.length - cloud.collection.length + merged.alerts.length - cloud.alerts.length + merged.watch.length - cloud.watch.length;
  rawWrite(merged);
  if (added) await push(cloud, merged);
  updateBadge();
  return added;
}

// ---------- start-up ----------
async function initAccounts() {
  const cfg = await api('/api/config').catch(() => ({}));
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return; // accounts not switched on: device-only mode
  await loadScript(SUPABASE_JS);
  Cloud.client = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, detectSessionInUrl: true } });
  $('#acctBtn').hidden = false;
  Cloud.client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') openAuth('newpass');
    setUser(session?.user || null, event);
  });
  const { data } = await Cloud.client.auth.getSession();
  setUser(data.session?.user || null, 'INITIAL');
}

async function setUser(user, event) {
  const was = Cloud.user?.id;
  Cloud.user = user;
  $('#acctBtn').textContent = user ? `👤 ${user.email.split('@')[0]}` : 'Sign in';
  if (user && user.id !== was) {
    try {
      const added = await pull();
      if (event === 'SIGNED_IN') toast(added ? `Signed in. ${added} item${added > 1 ? 's' : ''} from this device added to your account.` : 'Signed in');
    } catch (e) { toast(`Couldn't load your account: ${e.message}`); }
    if (S.tab === 'mine') renderMine();
  }
}

// ---------- sign-in window ----------
function openAuth(mode = 'signin') {
  const dlg = $('#authDlg');
  const signedIn = !!Cloud.user;
  const html = {
    account: `<h2>Your account</h2><p>Signed in as <b>${esc(Cloud.user?.email || '')}</b>. Your collection, watchlist and alerts are saved to your account and show up on any device you sign in on.</p>
      <label class="note"><input type="checkbox" id="emailAlerts" ${Cloud.settings.email_alerts ? 'checked' : ''}> Email me when a price alert triggers (checked once a day)</label>
      <div class="row" style="margin-top:14px"><button class="ghost" id="signOut">Sign out</button></div>
      <p class="note">Signing out removes your cards from this device's screen; they stay safe in your account.</p>`,
    signin: `<h2>Sign in</h2><p class="note">Keep your collection, watchlist and price alerts on every device, and get alerts by email.</p>
      <form id="authForm" class="aform"><label>Email<input type="email" id="aEmail" required autocomplete="email"></label>
      <label>Password<input type="password" id="aPass" required minlength="8" autocomplete="current-password"></label>
      <button class="primary" type="submit">Sign in</button></form>
      <p class="note"><a href="#" data-mode="signup">Create an account</a> · <a href="#" data-mode="forgot">Forgot password?</a></p>`,
    signup: `<h2>Create an account</h2><p class="note">Free. Anything you've already saved on this device is added to your new account.</p>
      <form id="authForm" class="aform"><label>Email<input type="email" id="aEmail" required autocomplete="email"></label>
      <label>Password (8+ characters)<input type="password" id="aPass" required minlength="8" autocomplete="new-password"></label>
      <button class="primary" type="submit">Create account</button></form>
      <p class="note">Already have one? <a href="#" data-mode="signin">Sign in</a></p>`,
    forgot: `<h2>Reset your password</h2><form id="authForm" class="aform"><label>Email<input type="email" id="aEmail" required autocomplete="email"></label>
      <button class="primary" type="submit">Email me a reset link</button></form><p class="note"><a href="#" data-mode="signin">Back to sign in</a></p>`,
    newpass: `<h2>Choose a new password</h2><form id="authForm" class="aform"><label>New password (8+ characters)<input type="password" id="aPass" required minlength="8" autocomplete="new-password"></label>
      <button class="primary" type="submit">Save password</button></form>`,
  };
  if (signedIn && mode === 'signin') mode = 'account';
  $('#authBody').innerHTML = `<button class="close" onclick="authDlg.close()">×</button><div class="authin">${html[mode]}<p class="note" id="authMsg"></p></div>`;
  dlg.querySelectorAll('[data-mode]').forEach((a) => a.onclick = (e) => { e.preventDefault(); openAuth(a.dataset.mode); });
  const msg = (t) => { $('#authMsg').textContent = t; };
  const form = $('#authForm');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#aEmail')?.value.trim(), password = $('#aPass')?.value;
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      const auth = Cloud.client.auth;
      if (mode === 'signin') { const { error } = await auth.signInWithPassword({ email, password }); if (error) throw error; dlg.close(); }
      if (mode === 'signup') {
        const { data, error } = await auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
        if (error) throw error;
        if (!data.session) msg('Check your email to confirm your account, then sign in.'); else dlg.close();
      }
      if (mode === 'forgot') { const { error } = await auth.resetPasswordForEmail(email, { redirectTo: location.origin }); if (error) throw error; msg('If that email has an account, a reset link is on its way.'); }
      if (mode === 'newpass') { const { error } = await auth.updateUser({ password }); if (error) throw error; toast('Password updated'); dlg.close(); }
    } catch (err) { msg(err.message || 'Something went wrong. Try again.'); }
    btn.disabled = false;
  };
  if (mode === 'account') {
    $('#signOut').onclick = async () => {
      await Cloud.client.auth.signOut();
      rawWrite({ collection: [], watch: [], alerts: [] }); // don't leave someone's cards on a shared device
      updateBadge(); dlg.close(); toast('Signed out'); if (S.tab === 'mine') renderMine();
    };
    $('#emailAlerts').onchange = async (e) => {
      Cloud.settings.email_alerts = e.target.checked;
      const { error } = await Cloud.client.from('settings').upsert({ email_alerts: e.target.checked });
      toast(error ? `Couldn't save: ${error.message}` : e.target.checked ? 'Email alerts on' : 'Email alerts off');
    };
  }
  if (!dlg.open) dlg.showModal();
}

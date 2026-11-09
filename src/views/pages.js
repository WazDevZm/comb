import { html, raw, money, dateOnly, options } from './layout.js';
import { all, one, getSettings, CURRENCIES } from '../db.js';
import { today } from '../rules.js';
import { STAGES, TYPE_LABEL, eligible, retirementDue, requesterOf, voucherOf } from '../workflow.js';
import { flagsFor } from '../flags.js';
import { statePill } from './request.js';
import { aiEnabled } from '../ai.js';

const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);

function flagPill(r) {
  const flags = flagsFor(r);
  if (!flags.length) return null;
  const top = flags.find((f) => f.level === 'block') ?? flags[0];
  return html`<div class="small flagnote ${top.level}">${FLAG_LABEL[top.code] ?? 'Check'}${flags.length > 1 ? ` +${flags.length - 1}` : ''}</div>`;
}
const FLAG_LABEL = { tender: 'Needs tender', route: 'Over expense limit', split: 'Possible split', evidence: 'No document', justification: 'Weak reason', budget: 'Over budget', budget_available: 'Over budget', overdue: 'Overdue advance', reused: 'Reused file', dup_invoice: 'Duplicate invoice', receipt_mismatch: 'Receipt differs', overspend: 'Overspent' };

function requestRows(rows, { showWho = true, empty = 'Nothing here.' } = {}) {
  if (!rows.length) return html`<p class="muted">${empty}</p>`;
  return html`<div class="tablewrap"><table><thead><tr><th>Ref</th><th>What</th>${showWho && html`<th>Who</th>`}<th>Project</th><th class="num">Amount</th><th>Stage</th></tr></thead><tbody>
  ${rows.map((r) => html`<tr><td class="small nowrap"><a href="/r/${r.id}">${r.ref}</a></td><td>${r.title}</td>${showWho && html`<td class="small">${r.requester_name}</td>`}<td class="small">${r.project}</td><td class="num">${money(r.amount, r.currency)}</td><td>${statePill(r)}${flagPill(r)}</td></tr>`)}
  </tbody></table></div>`;
}
const WITH_NAME = `SELECT r.*, u.name AS requester_name FROM requests r JOIN users u ON u.id = r.requester_id`;

export function loginPage({ error, people, demo }) {
  return html`<div class="login"><img src="/lockup.svg" alt="Comb, BongoHive finance">
  <form method="post" action="/login" class="card">
    ${error && html`<div class="notice err" role="alert">${error}</div>`}
    <label>Username<span class="hint">firstname.lastname</span><input name="username" autocomplete="username" autofocus required></label>
    <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
    <button class="primary">Sign in</button>
  </form>
  ${demo && html`<form method="post" action="/demo-login" class="card"><h2>Demo</h2><p class="small muted">Local demo only. Try each role.</p>
    <label>Sign in as<select name="id">${options(people.map((p) => [p.id, `${p.name} (${p.label})`]))}</select></label><button>Enter</button></form>`}</div>`;
}

export function passwordPage(forced) {
  return html`<div class="login"><form method="post" action="/password" class="card"><h1>Set your password</h1>
  ${forced && html`<p class="muted">Choose your own password before you continue.</p>`}
  <label>New password<span class="hint">At least 10 characters.</span><input type="password" name="password" minlength="10" autocomplete="new-password" required></label>
  <button class="primary">Save</button></form></div>`;
}

export function homePage(user) {
  const openRows = all(`${WITH_NAME} WHERE r.state NOT IN ('sealed', 'rejected', 'legacy') ORDER BY r.id DESC`);
  const mine = openRows.filter((r) => eligible(r).some((u) => u.id === user.id));
  const myRecent = all(`${WITH_NAME} WHERE r.requester_id = ? AND r.state != 'legacy' ORDER BY r.id DESC LIMIT 8`, user.id);
  const senior = user.role !== 'staff';
  const t = today();
  const out = senior ? all(`SELECT * FROM requests WHERE type = 'advance' AND state IN ('acknowledge', 'retirement')`) : [];
  const overdue = out.filter((r) => { const d = retirementDue(r); return d && d < t; });
  const outZmw = out.reduce((s, r) => s + (voucherOf(r.id)?.amount ?? 0) * r.rate, 0);
  const legacy = senior ? one(`SELECT COUNT(*) AS n FROM requests WHERE legacy = 1`).n : 0;
  const unconfirmed = user.role === 'finance' ? one('SELECT COUNT(*) AS n FROM rates WHERE confirmed = 0').n : 0;
  return html`<h1>Hello, ${user.name.split(' ')[0]}</h1>
  ${unconfirmed > 0 && html`<div class="notice warn">Exchange rates are placeholders. <a href="/admin">Confirm them in Admin</a> before relying on the thresholds.</div>`}
  ${senior && html`<div class="stats">
    <a class="stat" href="#waiting"><b>${mine.length}</b><span>waiting on you</span></a>
    <a class="stat" href="/register?open=1"><b>${openRows.length}</b><span>open requests</span></a>
    <a class="stat" href="/advances"><b>${money(outZmw)}</b><span>advances out</span></a>
    <a class="stat ${overdue.length ? 'alert' : ''}" href="/advances"><b>${overdue.length}</b><span>overdue retirements</span></a>
    ${legacy > 0 && html`<a class="stat" href="/register?state=legacy"><b>${legacy}</b><span>imported old requests</span></a>`}
  </div>`}
  <section class="card action" id="waiting"><h2>Waiting on you</h2>${requestRows(mine, { empty: 'You are all caught up.' })}</section>
  <section class="card"><h2>Your requests</h2>${requestRows(myRecent, { showWho: false, empty: 'You have not made any requests yet.' })}<div class="actions"><a class="btn primary" href="/new">New request</a></div></section>`;
}

export function newPage() {
  return html`<h1>What do you need?</h1><div class="choices">
  <a class="choice" href="/new/expense"><h2>Pay for something small</h2><p class="muted">A cost up to the expense limit, with a quote or invoice.</p><span class="pill">Replaces Expense Submission</span></a>
  <a class="choice" href="/new/procurement"><h2>Buy from a vendor</h2><p class="muted">Goods or services that need quotes, a PO and delivery.</p><span class="pill">Replaces Procurement form</span></a>
  <a class="choice" href="/new/advance"><h2>Get money for an activity</h2><p class="muted">An advance you retire with receipts afterwards.</p><span class="pill">Replaces Staff Advance form</span></a>
  </div>`;
}

export function registerRows(user, q) {
  const where = [], params = [];
  if (user.role === 'staff') {
    where.push(`(r.requester_id = ? OR r.department IN (SELECT name FROM departments WHERE lead_id = ?))`);
    params.push(user.id, user.id);
  }
  if (q.type) { where.push('r.type = ?'); params.push(q.type); }
  if (q.state) { where.push('r.state = ?'); params.push(q.state); }
  if (q.project) { where.push('r.project = ?'); params.push(q.project); }
  if (q.open) where.push(`r.state NOT IN ('sealed', 'rejected', 'legacy')`);
  if (q.q) { where.push(`(r.title LIKE ? OR r.ref LIKE ?)`); params.push(`%${q.q}%`, `%${q.q}%`); }
  return all(`${WITH_NAME} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT 500`, ...params);
}

export function registerPage(user, q) {
  const rows = registerRows(user, q);
  const flagged = q.flagged ? rows.filter((r) => flagsFor(r).length) : rows;
  const projects = all('SELECT name FROM projects ORDER BY name').map((p) => p.name);
  const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  return html`<h1>Register</h1><form class="card" method="get"><div class="row">
    <label>Search<input name="q" value="${q.q ?? ''}"></label>
    <label>Type<select name="type"><option value="">All</option>${options(Object.entries(TYPE_LABEL), q.type)}</select></label>
    <label>Stage<select name="state"><option value="">All</option>${options(Object.entries(STAGES).map(([k, v]) => [k, v.label]), q.state)}</select></label>
    <label>Project<select name="project"><option value="">All</option>${options(projects, q.project)}</select></label></div>
    <label class="check"><input type="checkbox" name="flagged" value="1" ${raw(q.flagged ? 'checked' : '')}> Only show requests with flags</label>
    <div class="actions"><button>Filter</button><a class="btn" href="/register.csv?${params}">Download CSV</a></div></form>
  <section class="card">${requestRows(flagged)}<p class="small muted">${flagged.length} shown.</p></section>`;
}

export function advancesPage() {
  const t = today();
  const rows = all(`${WITH_NAME} WHERE r.type = 'advance' AND r.state IN ('payment', 'acknowledge', 'retirement', 'retirement_verify', 'retirement_approve', 'settlement') ORDER BY r.id`)
    .map((r) => ({ ...r, due: voucherOf(r.id)?.paid_on ? retirementDue(r) : null }));
  const late = (r) => r.due && r.due < t && ['acknowledge', 'retirement'].includes(r.state);
  rows.sort((a, b) => (late(b) - late(a)) || String(a.due).localeCompare(String(b.due)));
  return html`<h1>Advances</h1><p class="muted">Who holds organisation money, and when it should be retired.</p>
  <section class="card">${rows.length ? html`<div class="tablewrap"><table><thead><tr><th>Who</th><th>Advance</th><th class="num">Amount</th><th>Due</th><th>Stage</th></tr></thead><tbody>
  ${rows.map((r) => html`<tr><td>${r.requester_name}</td><td><a href="/r/${r.id}">${r.title}</a><div class="small muted">${r.ref}</div></td><td class="num">${money(r.amount, r.currency)}</td>
    <td>${r.due ? dateOnly(r.due) : 'Not paid yet'}${late(r) ? html`<div class="pill rejected">${daysBetween(r.due, t)} days late</div>` : ''}</td><td>${statePill(r)}</td></tr>`)}
  </tbody></table></div>` : html`<p class="muted">No advances are open.</p>`}</section>`;
}

export function vendorsPage(user) {
  const vendors = all(`SELECT v.*, (SELECT COUNT(*) FROM quotes q WHERE q.vendor_id = v.id AND q.selected = 1) AS wins FROM vendors v ORDER BY v.name`);
  const fin = user.role === 'finance';
  return html`<h1>Vendors</h1><p class="muted">The approved vendor list. New vendors need finance approval, with a company profile and SLA, before a purchase can be authorised.</p>
  <section class="card">${vendors.length ? html`<div class="tablewrap"><table><thead><tr><th>Vendor</th><th>Contact</th><th>TPIN</th><th>Status</th><th class="num">Orders</th>${fin && html`<th></th>`}</tr></thead><tbody>
  ${vendors.map((v) => html`<tr><td>${v.name}</td><td class="small">${v.contact}</td><td class="small">${v.tpin}</td><td><span class="pill ${v.status === 'approved' ? 'sealed' : v.status === 'blocked' ? 'rejected' : ''}">${v.status}</span></td><td class="num">${v.wins}</td>
   ${fin && html`<td><form method="post" action="/vendors/${v.id}/status"><select name="status" aria-label="Status for ${v.name}">${options(['pending', 'approved', 'blocked'], v.status)}</select><button class="link">Save</button></form></td>`}</tr>`)}
  </tbody></table></div>` : html`<p class="muted">No vendors yet. The old vendor list was broken, so this starts empty.</p>`}</section>
  <form method="post" action="/vendors" class="card"><h2>Add a vendor</h2><div class="row"><label>Name<input name="name" required></label><label>Contact<input name="contact"></label><label>TPIN<input name="tpin"></label></div>
  <label>Address<input name="address"></label><label>Bank or mobile money details<input name="bank_details"></label><button>Add vendor</button></form>`;
}

export function reportsPage() {
  const by = all(`SELECT project, currency, COUNT(*) AS n, SUM(amount) AS total, SUM(amount_zmw) AS zmw FROM requests WHERE state NOT IN ('draft', 'rejected') GROUP BY project, currency ORDER BY zmw DESC`);
  const projects = [...new Set(by.map((r) => r.project))];
  const cell = (p, c) => by.find((r) => r.project === p && r.currency === c)?.total;
  const stage = all(`SELECT type, state, COUNT(*) AS n, SUM(amount_zmw) AS zmw FROM requests GROUP BY type, state ORDER BY type, n DESC`);
  const unexported = one(`SELECT COUNT(*) AS n FROM requests r JOIN vouchers v ON v.request_id = r.id WHERE v.paid_on IS NOT NULL AND r.type != 'advance' AND r.xero_exported_at IS NULL`).n;
  return html`<h1>Reports</h1>
  <section class="card"><h2>Hand-off to Xero</h2><p class="muted">Comb keeps the paper trail. Xero keeps the books. ${unexported} paid item${unexported === 1 ? '' : 's'} not exported yet.</p><a class="btn" href="/export/xero.csv">Download bills CSV</a></section>
  <section class="card"><h2>By project</h2><div class="tablewrap"><table><thead><tr><th>Project</th>${CURRENCIES.map((c) => html`<th class="num">${c}</th>`)}<th class="num">≈ ZMW</th></tr></thead><tbody>
  ${projects.map((p) => html`<tr><td>${p}</td>${CURRENCIES.map((c) => html`<td class="num">${cell(p, c) != null ? Number(cell(p, c)).toLocaleString('en-ZM', { minimumFractionDigits: 2 }) : ''}</td>`)}<td class="num">${money(by.filter((r) => r.project === p).reduce((s, r) => s + r.zmw, 0))}</td></tr>`)}
  </tbody></table></div><p class="small muted">Includes imported requests. Kwacha equivalents use each request's stored rate.</p></section>
  <section class="card"><h2>By stage</h2><div class="tablewrap"><table><thead><tr><th>Type</th><th>Stage</th><th class="num">Count</th><th class="num">≈ ZMW</th></tr></thead><tbody>
  ${stage.map((s) => html`<tr><td>${TYPE_LABEL[s.type]}</td><td>${STAGES[s.state]?.label}</td><td class="num">${s.n}</td><td class="num">${money(s.zmw)}</td></tr>`)}</tbody></table></div></section>`;
}

export function adminPage(tempInfo) {
  const s = getSettings();
  const rates = all('SELECT * FROM rates ORDER BY currency');
  const users = all('SELECT * FROM users ORDER BY name');
  const depts = all('SELECT * FROM departments ORDER BY name');
  const lines = all('SELECT * FROM budget_lines ORDER BY project, name');
  const projects = all('SELECT name FROM projects ORDER BY name').map((p) => p.name);
  const num = (k, label, hint) => html`<label>${label}${hint && html`<span class="hint">${hint}</span>`}<input name="${k}" value="${s[k]}" inputmode="decimal" required></label>`;
  return html`<h1>Admin</h1>
  ${tempInfo && html`<div class="notice ok">Temporary password for ${tempInfo.name}: <b class="mono">${tempInfo.password}</b>. Share it privately. It will not be shown again.</div>`}
  <p class="small muted">AI document reading: <b>${aiEnabled() ? 'on' : 'off (no ANTHROPIC_API_KEY set)'}</b>.</p>
  <form method="post" action="/admin/settings" class="card"><h2>Rules</h2><p class="small muted">Taken from the forms. Where the forms disagreed these are the working defaults, so finance should confirm them.</p><div class="row">
  ${num('single_quote_max', 'One quote up to (K)')}${num('two_quote_max', 'Two quotes up to (K)')}${num('tender_above', 'Open tender above (K)')}${num('expense_limit', 'Expense limit (K)', 'Above this, use procurement.')}
  ${num('retirement_days', 'Retire within (working days)', 'Forms said both 5 and 7.')}${num('split_window_days', 'Split-purchase window (days)')}</div>
  <label class="check"><input type="checkbox" name="block_advance_if_overdue" value="1" ${raw(s.block_advance_if_overdue ? 'checked' : '')}> Block new advances while one is overdue</label><button>Save rules</button></form>
  <form method="post" action="/admin/rates" class="card"><h2>Exchange rates</h2><p class="small muted">Kwacha per unit. Saving marks them as confirmed.</p><div class="row">
  ${rates.map((r) => html`<label>${r.currency}${r.confirmed ? '' : html`<span class="hint">Placeholder</span>`}<input name="rate[${r.currency}]" value="${r.to_zmw}" inputmode="decimal" required></label>`)}</div><button>Confirm rates</button></form>
  <form method="post" action="/admin/departments" class="card"><h2>Department leads</h2><p class="small muted">Leads review their team's requests. Without a lead, a director reviews.</p><div class="row">
  ${depts.map((d) => html`<label>${d.name}<select name="lead[${d.name}]"><option value="">Directors</option>${options(users.filter((u) => u.active).map((u) => [u.id, u.name]), d.lead_id)}</select></label>`)}</div><button>Save leads</button></form>
  <section class="card"><h2>Budget lines</h2>${lines.length ? html`<div class="tablewrap"><table><thead><tr><th>Project</th><th>Line</th><th>Xero account</th><th class="num">Budget (K)</th></tr></thead><tbody>${lines.map((l) => html`<tr><td>${l.project}</td><td>${l.name}</td><td>${l.account_code}</td><td class="num">${l.budget_zmw != null ? money(l.budget_zmw) : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">None yet. The old forms had no budget line list.</p>`}
  <form method="post" action="/admin/budget-lines"><div class="row"><label>Project<select name="project" required>${options(projects)}</select></label><label>Line<input name="name" required></label><label>Xero account code<input name="account_code"></label><label>Budget (K)<input name="budget_zmw" inputmode="decimal"></label></div><button>Add line</button></form></section>
  <form method="post" action="/admin/projects" class="card"><h2>Add a project</h2><label>Name<input name="name" required></label><button>Add project</button></form>
  <section class="card"><h2>People</h2><div class="tablewrap"><table><thead><tr><th>Name</th><th>Username</th><th>Department</th><th>Role</th><th></th></tr></thead><tbody>
  ${users.map((u) => html`<tr><td>${u.name}${u.active ? '' : ' (inactive)'}</td><td class="small">${u.username}</td><td class="small">${u.department}</td>
   <td><form method="post" action="/admin/users/${u.id}"><select name="role" aria-label="Role for ${u.name}">${options(['staff', 'finance', 'director'], u.role)}</select><button class="link">Save</button></form></td>
   <td><form method="post" action="/admin/users/${u.id}/reset"><button class="link">New password</button></form></td></tr>`)}</tbody></table></div>
  <form method="post" action="/admin/users"><h3>Add a person</h3><div class="row"><label>Full name<input name="name" required></label><label>Department<select name="department">${options(depts.map((d) => d.name))}</select></label></div><button>Add person</button></form></section>`;
}

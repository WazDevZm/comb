import { readFileSync } from 'node:fs';
import { one, all, run, tx, nextNumber, rateFor } from './db.js';
import { round2, nowIso, today, advanceLineTotal } from './rules.js';
import { hashPassword, tempPassword } from './auth.js';
import { logEvent, perform, saveQuote, getRequest, linesOf } from './workflow.js';

const ref = JSON.parse(readFileSync(new URL('../seed/reference.json', import.meta.url), 'utf8'));
export const username = (name) => name.toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/).join('.');

// Placeholder rates so the app runs. Finance must replace them: an unconfirmed rate shows a warning.
const PLACEHOLDER_RATES = { USD: 22, EUR: 25, GBP: 29, ZAR: 1.25 };

export function seedReference() {
  if (one('SELECT 1 AS x FROM users LIMIT 1')) return null;
  return tx(() => {
    for (const d of ref.departments) run('INSERT INTO departments (name) VALUES (?)', d);
    for (const p of ref.projects) run('INSERT INTO projects (name) VALUES (?)', p);
    for (const [c, v] of Object.entries(PLACEHOLDER_RATES)) run('INSERT INTO rates (currency, to_zmw, confirmed, updated_at) VALUES (?, ?, 0, ?)', c, v, nowIso());
    for (const s of ref.staff) run('INSERT INTO users (name, username, department, role) VALUES (?, ?, ?, ?)', s.name, username(s.name), s.department, s.role ?? 'staff');
    const lead = one(`SELECT * FROM users WHERE role = 'finance' LIMIT 1`);
    const pw = tempPassword();
    run('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?', hashPassword(pw), lead.id);
    importLegacy();
    return { username: lead.username, password: pw };
  });
}

// The 22 requests from the hidden "2. Output Sheet", kept read-only and with the original text preserved.
function importLegacy() {
  for (const l of ref.legacy) {
    const u = one('SELECT * FROM users WHERE name = ?', l.requester);
    const rate = rateFor(l.currency);
    const res = run(`INSERT INTO requests (ref, type, title, requester_id, department, project, currency, amount, rate, amount_zmw, justification, date_needed, state, data, legacy, created_at, submitted_at)
      VALUES (?, 'expense', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy', ?, 1, ?, ?)`, nextNumber('OLD', '2026'), l.title, u.id, l.department, l.project, l.currency, l.amount, rate, round2(l.amount * rate),
    '', l.date_needed, JSON.stringify({ evidence_note: l.evidence_note, amount_as_typed: l.amount_as_typed, project_as_typed: l.project_as_typed }), nowIso(), nowIso());
    run(`INSERT INTO lines (request_id, kind, pos, description, qty, total) VALUES (?, 'item', 0, ?, 1, ?)`, res.lastInsertRowid, l.title, l.amount);
    logEvent(res.lastInsertRowid, null, 'imported', null, `From Expense Submission_2026.xlsx. Amount typed as "${l.amount_as_typed}", project as "${l.project_as_typed}".`);
  }
}

export function createDraft({ type, title, user, project, budget_line, currency = 'ZMW', amount, justification, priority = 'Medium', date_needed, data = {}, demo = 0 }) {
  const prefix = { expense: 'EXP', procurement: 'PR', advance: 'ADV' }[type];
  const rate = rateFor(currency);
  const res = run(`INSERT INTO requests (ref, type, title, requester_id, department, project, budget_line, currency, amount, rate, amount_zmw, justification, priority, date_needed, data, demo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, nextNumber(prefix, today().slice(0, 4)), type, title, user.id, user.department, project, budget_line ?? null, currency, amount, rate, round2(amount * rate),
  justification, priority, date_needed ?? null, JSON.stringify(data), demo, nowIso());
  logEvent(res.lastInsertRowid, user, 'created', 'draft');
  return res.lastInsertRowid;
}

function addDoc(requestId, user, kind, filename, sha) {
  return run(`INSERT INTO documents (request_id, kind, filename, stored_as, mime, size, sha256, uploaded_by, uploaded_at) VALUES (?, ?, ?, '', 'application/pdf', 0, ?, ?, ?)`,
    requestId, kind, filename, sha, user.id, nowIso()).lastInsertRowid;
}

// Sample records for the local demo only (npm run demo). Never loaded into the real database.
export function seedDemo() {
  if (one('SELECT 1 AS x FROM requests WHERE demo = 1 LIMIT 1')) return;
  const by = (n) => one('SELECT * FROM users WHERE name = ?', n);
  const staff = by('Maumo Mubila'), staff2 = by('Mapalo Lukashi'), dirA = by('Lukonga Lindunda'), dirB = by('Simunza Muyangana'), fin = by('Seiko Mwenya');
  for (const v of ['Sample Print Works', 'Sample Office Supplies', 'Sample Tech Traders']) {
    run(`INSERT INTO vendors (name, status, added_by, added_at) VALUES (?, 'approved', ?, ?)`, v, fin.id, nowIso());
  }
  run(`INSERT INTO budget_lines (project, name, account_code, budget_zmw) VALUES ('HIVOS', 'Travel', '420', 60000), ('HIVOS', 'Programme costs', '430', 150000), ('SC WiT', 'Equipment', '440', 40000)`);
  run(`UPDATE rates SET confirmed = 0`);

  // 1. The advance on the original form: Chongwe travel, K8,829, waiting on the manager.
  const form = [['Accommodation', 4, 1, 1, 800], ['Fuel', 1, 1, 1, 2989], ['Lunch allowance', 1, 1, 2, 600], ['Taxi & Comms', 1, 1, 1, 350], ['Car Wash', 1, 2, 1, 100], ['Toll gate', 1, 2, 1, 20], ['Per diem', 1, 1, 1, 850]];
  const advance = (user, title, days) => {
    const total = form.reduce((t, [, d, u, p, c]) => t + d * u * p * c, 0);
    const id = createDraft({ type: 'advance', title, user, project: 'HIVOS', budget_line: 'Travel', amount: total, demo: 1, justification: 'Field assessment visit agreed in the project workplan for this quarter.',
      data: { activity_location: 'Chongwe', activity_start: days.start, activity_end: days.end, payment_method: 'Mobile Money', mobile_number: '09XX XXX XXX', declared: true } });
    form.forEach(([description, d, u, p, c], i) => run(`INSERT INTO lines (request_id, kind, pos, description, days, units, people, unit_cost, total) VALUES (?, 'advance', ?, ?, ?, ?, ?, ?, ?)`, id, i, description, d, u, p, c, advanceLineTotal({ days: d, units: u, people: p, unit_cost: c })));
    return id;
  };
  const shift = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const a1 = advance(staff, 'Travel to Chongwe for Hivos assessment', { start: shift(5), end: shift(8) });
  perform(staff, a1, 'approve');

  // 2. An advance that was paid and is now overdue for retirement.
  const a2 = advance(staff2, 'Community workshop travel, Chongwe', { start: shift(-30), end: shift(-26) });
  perform(staff2, a2, 'approve');
  perform(dirA, a2, 'approve');
  perform(fin, a2, 'approve', { available_budget: 60000, budget_line: 'Travel' });
  perform(dirB, a2, 'approve');
  perform(fin, a2, 'approve', { paid_on: shift(-31), method: 'Mobile Money', mobile_network: 'Airtel Money', reference: 'DEMO-MM-1042' });
  perform(staff2, a2, 'approve', { ack: true });

  // 3. An expense that is sealed end to end.
  const e1 = createDraft({ type: 'expense', title: 'Printer toner for the Co-Working front desk', user: staff, project: 'HIVOS', budget_line: 'Programme costs', amount: 2400, demo: 1, justification: 'The front desk printer is out of toner and members need it for daily printing.', date_needed: shift(-12), data: { payee: 'Sample Office Supplies' } });
  run(`INSERT INTO lines (request_id, kind, pos, description, qty, total) VALUES (?, 'item', 0, 'Toner cartridge', 1, 2400)`, e1);
  addDoc(e1, staff, 'quote', 'sample-quote-toner.pdf', 'demo-sha-1');
  perform(staff, e1, 'approve');
  perform(dirA, e1, 'approve');
  perform(fin, e1, 'approve', { available_budget: 150000, budget_line: 'Programme costs' });
  perform(dirB, e1, 'approve');
  perform(fin, e1, 'approve', { paid_on: shift(-10), method: 'Bank Transfer', reference: 'DEMO-BT-7781' });
  addDoc(e1, fin, 'invoice', 'sample-invoice-toner.pdf', 'demo-sha-2');
  perform(fin, e1, 'approve');

  // 4. A procurement sitting at the quotes step, with one quote where the rule needs two.
  const p1 = createDraft({ type: 'procurement', title: 'Laptops for the SC WiT cohort', user: staff, project: 'SC WiT', budget_line: 'Equipment', amount: 18000, demo: 1, justification: 'Two new programme officers start next month and need laptops for delivery work.', date_needed: shift(21), data: { donor_requirements: 'None stated.' } });
  run(`INSERT INTO lines (request_id, kind, pos, description, qty, uom, total) VALUES (?, 'item', 0, 'Laptop, 16GB RAM', 2, 'each', 0), (?, 'item', 1, 'Laptop bag', 2, 'each', 0)`, p1, p1);
  perform(staff, p1, 'approve');
  perform(dirA, p1, 'approve');
  perform(fin, p1, 'approve', { available_budget: 40000, budget_line: 'Equipment' });
  const lines = linesOf(p1, 'item');
  const doc = addDoc(p1, staff, 'quote', 'sample-quote-laptops.pdf', 'demo-sha-3');
  saveQuote(getRequest(p1), { vendor_id: one(`SELECT id FROM vendors WHERE name = 'Sample Tech Traders'`).id, currency: 'ZMW', price: { [`L${lines[0].id}`]: 8500, [`L${lines[1].id}`]: 450 }, vat: 0, extra: 0, document_id: doc, quote_date: shift(-1), reference: 'Q-1182' });
}

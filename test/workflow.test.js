import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addVendor, addDoc } from './helpers.js';
import { one, all, run, getSettings } from '../src/db.js';
import { createDraft } from '../src/seed.js';
import { perform, eligible, getRequest, saveQuote, linesOf, selectedQuote, voucherOf, sealIntact, UserError, retirementSummary, signoff, dataOf } from '../src/workflow.js';
import { flagsFor } from '../src/flags.js';

const J = 'A proper reason for this spend, written in a full sentence.';
const expense = (u, amount = 2000, extra = {}) => {
  const id = createDraft({ type: 'expense', title: 'Printer toner', user: u, project: 'HIVOS', amount, justification: J, ...extra });
  run(`INSERT INTO lines (request_id, kind, pos, description, qty, total) VALUES (?, 'item', 0, 'Toner', 1, ?)`, id, amount);
  return id;
};
const advance = (u, amount = 8829, data = {}) => {
  const id = createDraft({ type: 'advance', title: 'Field trip', user: u, project: 'HIVOS', amount, justification: J, data: { activity_location: 'Chongwe', activity_start: '2026-11-10', activity_end: '2026-11-12', ...data } });
  run(`INSERT INTO lines (request_id, kind, pos, description, days, units, people, unit_cost, total) VALUES (?, 'advance', 0, 'Costs', 1, 1, 1, ?, ?)`, id, amount, amount);
  return id;
};
function procurement(u, items, amount) {
  const id = createDraft({ type: 'procurement', title: 'Equipment', user: u, project: 'SC WiT', amount, justification: J });
  items.forEach(([d, q], i) => run(`INSERT INTO lines (request_id, kind, pos, description, qty, uom) VALUES (?, 'item', ?, ?, ?, 'each')`, id, i, d, q));
  return id;
}
const prices = (id, each) => Object.fromEntries(linesOf(id, 'item').map((l) => [`L${l.id}`, each]));
const blocked = (fn, re) => assert.throws(fn, (e) => e instanceof UserError && re.test(e.message));
const payment = { paid_on: '2026-11-05', method: 'Bank Transfer', reference: 'FT123' };
const budget = { available_budget: 500000, budget_line: 'Equipment' };

test('expense runs end to end and seals with distinct approvers', () => {
  const p = freshDb();
  const id = expense(p.staff);
  perform(p.staff, id, 'approve');
  perform(p.dirA, id, 'approve');
  perform(p.fin, id, 'approve', budget);
  blocked(() => perform(p.dirA, id, 'approve'), /not yours/);
  perform(p.dirB, id, 'approve');
  assert.match(voucherOf(id).voucher_no, /^PV-\d{4}-0001$/);
  perform(p.fin, id, 'approve', payment);
  blocked(() => perform(p.fin, id, 'approve'), /invoice or receipt/);
  addDoc(id, p.fin, 'invoice');
  const r = perform(p.fin, id, 'approve');
  assert.equal(r.state, 'sealed');
  assert.ok(sealIntact(r));
});

test('nobody can approve their own request, even a director or the finance lead', () => {
  const p = freshDb();
  const a = expense(p.dirA);
  perform(p.dirA, a, 'approve');
  assert.equal(getRequest(a).state, 'finance_review');
  perform(p.fin, a, 'approve', budget);
  assert.deepEqual(eligible(getRequest(a)).map((u) => u.id), [p.dirB.id]);
  const b = expense(p.fin);
  perform(p.fin, b, 'approve');
  assert.ok(!eligible(getRequest(b)).some((u) => u.id === p.fin.id));
  assert.ok(eligible(getRequest(b)).length > 0, 'finance lead requests still have a reviewer');
  const reviewer = eligible(getRequest(b))[0];
  perform(reviewer, b, 'approve', budget);
  assert.ok(!eligible(getRequest(b)).some((u) => u.id === reviewer.id || u.id === p.fin.id));
  assert.equal(eligible(getRequest(b)).length, 1);
});

test('one person cannot prepare and check: manager and final approver must differ', () => {
  const p = freshDb();
  const id = expense(p.staff);
  perform(p.staff, id, 'approve');
  perform(p.dirA, id, 'approve');
  perform(p.fin, id, 'approve', budget);
  assert.deepEqual(eligible(getRequest(id)).map((u) => u.name), ['Simunza Muyangana']);
});

test('a department lead reviews their team', () => {
  const p = freshDb();
  run('UPDATE departments SET lead_id = ? WHERE name = ?', p.staff2.id, p.staff.department);
  const id = expense(p.staff);
  perform(p.staff, id, 'approve');
  assert.deepEqual(eligible(getRequest(id)).map((u) => u.id), [p.staff2.id]);
});

test('an expense over the limit is routed to procurement', () => {
  const p = freshDb();
  blocked(() => perform(p.staff, expense(p.staff, 10000.01), 'approve'), /procurement/);
});

test('one-word justification is refused', () => {
  const p = freshDb();
  blocked(() => perform(p.staff, expense(p.staff, 500, { justification: 'Grocaries' }), 'approve'), /full sentence/);
});

test('sending back needs a reason and rejected requests stay closed', () => {
  const p = freshDb();
  const id = expense(p.staff);
  perform(p.staff, id, 'approve');
  blocked(() => perform(p.dirA, id, 'return', { comment: ' ' }), /comment/);
  assert.equal(perform(p.dirA, id, 'return', { comment: 'Attach a quote' }).state, 'draft');
  perform(p.staff, id, 'approve');
  assert.equal(perform(p.dirA, id, 'reject', { comment: 'Not budgeted' }).state, 'rejected');
  blocked(() => perform(p.staff, id, 'approve'), /not yours/);
});

function toRetirement(p, id) {
  perform(p.staff, id, 'approve');
  perform(p.dirA, id, 'approve');
  perform(p.fin, id, 'approve', budget);
  perform(p.dirB, id, 'approve');
  perform(p.fin, id, 'approve', payment);
  perform(p.staff, id, 'approve', { ack: true });
}
const spend = (id, amount, doc = null, comment = null) => run(`INSERT INTO lines (request_id, kind, pos, description, total, category, document_id, comment) VALUES (?, 'retirement', 0, 'Fuel', ?, 'Fuel', ?, ?)`, id, amount, doc, comment);

test('advance: under-spend must be returned before it can seal', () => {
  const p = freshDb();
  const id = advance(p.staff);
  toRetirement(p, id);
  assert.equal(getRequest(id).state, 'retirement');
  blocked(() => perform(p.staff, id, 'approve', { certify: 1 }), /Add what you spent/);
  spend(id, 5432);
  blocked(() => perform(p.staff, id, 'approve', { certify: 1 }), /receipt/);
  run(`UPDATE lines SET document_id = ? WHERE request_id = ? AND kind = 'retirement'`, addDoc(id, p.staff, 'receipt'), id);
  blocked(() => perform(p.staff, id, 'approve'), /Certify/);
  perform(p.staff, id, 'approve', { certify: 1 });
  perform(p.fin, id, 'approve');
  blocked(() => perform(p.fin, id, 'approve'), /not yours/);
  perform(p.dirA, id, 'approve');
  assert.equal(getRequest(id).state, 'settlement');
  assert.equal(retirementSummary(getRequest(id)).variance, 3397);
  blocked(() => perform(p.fin, id, 'approve', { mode: 'Bank Deposit' }), /reference/);
  assert.equal(perform(p.fin, id, 'approve', { mode: 'Bank Deposit', reference: 'SLIP9' }).state, 'sealed');
});

test('advance: exact spend skips settlement and seals', () => {
  const p = freshDb();
  const id = advance(p.staff, 1000);
  toRetirement(p, id);
  spend(id, 1000, null, 'Toll booth gave no receipt');
  perform(p.staff, id, 'approve', { certify: 1 });
  perform(p.fin, id, 'approve');
  assert.equal(perform(p.dirA, id, 'approve').state, 'sealed');
});

test('a new advance is blocked while one is overdue', () => {
  const p = freshDb();
  const late = advance(p.staff, 1000, { activity_start: '2026-01-01', activity_end: '2026-01-02' });
  toRetirement(p, late);
  blocked(() => perform(p.staff, advance(p.staff, 500), 'approve'), /overdue/);
  run(`INSERT INTO settings (k, v) VALUES ('block_advance_if_overdue', '0')`);
  const next = advance(p.staff, 500);
  perform(p.staff, next, 'approve');
  assert.ok(flagsFor(getRequest(next)).some((f) => f.code === 'overdue'));
});

function toSourcing(p, items, amount) {
  const id = procurement(p.staff, items, amount);
  perform(p.staff, id, 'approve');
  perform(p.dirA, id, 'approve');
  perform(p.fin, id, 'approve', budget);
  return id;
}
const quote = (p, id, vendor, price, extra = {}) => saveQuote(getRequest(id), { vendor_id: vendor, currency: 'ZMW', price: prices(id, price), document_id: addDoc(id, p.staff, 'quote'), ...extra });
const choose = { selection_reason: 'Lowest total price and available on the date we need.', coi: 1 };

test('procurement: full path, with VAT and extras flowing all the way to the voucher', () => {
  const p = freshDb();
  const v1 = addVendor('Vendor One'), v2 = addVendor('Vendor Two');
  const id = toSourcing(p, [['Laptop', 2]], 15000);
  const q1 = quote(p, id, v1, 7000, { vat: 2240, extra: 300 });
  blocked(() => perform(p.staff, id, 'approve', { ...choose, selected_quote: q1 }), /Minimum of 2/);
  quote(p, id, v2, 7500);
  blocked(() => perform(p.staff, id, 'approve', { ...choose, selected_quote: q1, coi: undefined }), /conflict/);
  perform(p.staff, id, 'approve', { ...choose, selected_quote: q1 });
  assert.equal(getRequest(id).amount, 16540);
  blocked(() => perform(p.dirA, id, 'approve'), /conflict/);
  perform(p.dirA, id, 'approve', { coi: 1 });
  perform(p.dirB, id, 'approve', { coi: 1 });
  perform(p.fin, id, 'approve', { payment_terms: '30 days' });
  assert.match(dataOf(getRequest(id)).po_no, /^PO-/);
  const [l] = linesOf(id, 'item');
  blocked(() => perform(p.staff, id, 'approve', { received: { [`L${l.id}`]: 2 }, condition: { [`L${l.id}`]: 'Good' }, invoice_no: 'INV1', invoice_amount: 16540 }), /invoice/i);
  addDoc(id, p.staff, 'invoice');
  perform(p.staff, id, 'approve', { received: { [`L${l.id}`]: 2 }, condition: { [`L${l.id}`]: 'Good' }, invoice_no: 'INV1', invoice_amount: 16540 });
  perform(p.fin, id, 'approve');
  perform(p.dirA, id, 'approve');
  assert.equal(voucherOf(id).amount, 16540, 'voucher equals the chosen quote including VAT');
  assert.equal(voucherOf(id).payee, 'Vendor One');
  perform(p.fin, id, 'approve', payment);
  assert.equal(perform(p.fin, id, 'approve').state, 'sealed');
});

test('procurement: partial delivery cuts the voucher, and finance cannot overpay', () => {
  const p = freshDb();
  const id = toSourcing(p, [['Chair', 10]], 5000);
  const q = quote(p, id, addVendor('V'), 500);
  perform(p.staff, id, 'approve', { ...choose, selected_quote: q });
  perform(p.dirA, id, 'approve', { coi: 1 });
  perform(p.dirB, id, 'approve', { coi: 1 });
  perform(p.fin, id, 'approve');
  addDoc(id, p.staff, 'invoice');
  const [l] = linesOf(id, 'item');
  perform(p.staff, id, 'approve', { received: { [`L${l.id}`]: 6 }, condition: { [`L${l.id}`]: 'Partial' }, invoice_no: 'A', invoice_amount: 5000 });
  blocked(() => perform(p.fin, id, 'approve', { payable: 3000 }), /comment/);
  blocked(() => perform(p.fin, id, 'approve', { payable: 5000, comment: 'x' }), /more than the value/);
  perform(p.fin, id, 'approve', { payable: 3000, comment: 'Six of ten chairs delivered' });
  perform(p.dirA, id, 'approve');
  assert.equal(voucherOf(id).amount, 3000);
});

test('REGRESSION: all items reach the PO (the old form dropped lines 14 to 18)', () => {
  const p = freshDb();
  const id = toSourcing(p, Array.from({ length: 18 }, (_, i) => [`Item ${i + 1}`, 1]), 1000);
  saveQuote(getRequest(id), { vendor_id: addVendor('V'), currency: 'ZMW', price: prices(id, 10), document_id: addDoc(id, p.staff, 'quote') });
  const q = all('SELECT * FROM quotes')[0];
  assert.equal(q.total, 180);
  assert.equal(all('SELECT * FROM quote_prices WHERE quote_id = ?', q.id).length, 18);
});

test('quotes follow the higher of the estimate and the real price', () => {
  const p = freshDb();
  const id = toSourcing(p, [['Thing', 1]], 5000); // Estimated low enough for one quote.
  const q = quote(p, id, addVendor('V'), 25000); // Real price needs three.
  blocked(() => perform(p.staff, id, 'approve', { ...choose, selected_quote: q }), /Minimum of 3/);
});

test('above the tender limit a tender document is required', () => {
  const p = freshDb();
  const id = toSourcing(p, [['Fit-out', 1]], 150000);
  const ids = ['A', 'B', 'C'].map((n) => quote(p, id, addVendor(n), 150000));
  blocked(() => perform(p.staff, id, 'approve', { ...choose, selected_quote: ids[0] }), /tender/);
  addDoc(id, p.staff, 'tender');
  perform(p.staff, id, 'approve', { ...choose, selected_quote: ids[0] });
  assert.equal(getRequest(id).state, 'selection_check');
});

test('a vendor must be approved before authorisation', () => {
  const p = freshDb();
  const v = addVendor('New Co', 'pending');
  const id = toSourcing(p, [['Thing', 1]], 500);
  const q = quote(p, id, v, 500);
  perform(p.staff, id, 'approve', { ...choose, selected_quote: q });
  perform(p.dirA, id, 'approve', { coi: 1 });
  blocked(() => perform(p.dirB, id, 'approve', { coi: 1 }), /not an approved vendor/);
  run(`UPDATE vendors SET status = 'approved' WHERE id = ?`, v);
  perform(p.dirB, id, 'approve', { coi: 1 });
});

test('foreign currency uses the stored rate for thresholds', () => {
  const p = freshDb();
  const id = expense(p.staff, 600, { currency: 'USD' }); // 600 x 22 = K13,200, over the limit.
  blocked(() => perform(p.staff, id, 'approve'), /procurement/);
});

test('sealed records cannot be changed, and the audit trail cannot be edited, even directly in the database', () => {
  const p = freshDb();
  const id = expense(p.staff);
  perform(p.staff, id, 'approve');
  perform(p.dirA, id, 'approve');
  perform(p.fin, id, 'approve', budget);
  perform(p.dirB, id, 'approve');
  perform(p.fin, id, 'approve', payment);
  addDoc(id, p.fin, 'invoice');
  perform(p.fin, id, 'approve');
  assert.throws(() => run('UPDATE requests SET amount = 1 WHERE id = ?', id), /sealed/);
  assert.throws(() => run('UPDATE lines SET total = 1 WHERE request_id = ?', id), /sealed/);
  assert.throws(() => run('UPDATE vouchers SET amount = 1 WHERE request_id = ?', id), /sealed/);
  assert.throws(() => run('DELETE FROM requests WHERE id = ?', id), /sealed/);
  assert.throws(() => addDoc(id, p.fin, 'other'), /sealed/);
  assert.throws(() => run('UPDATE events SET actor_name = ?', 'Someone else'), /append-only/);
  assert.throws(() => run('DELETE FROM events'), /append-only/);
});

test('REGRESSION: sign-off dates are fixed when signed, unlike =TODAY()', async () => {
  const p = freshDb();
  const id = expense(p.staff);
  perform(p.staff, id, 'approve');
  perform(p.dirA, id, 'approve');
  const first = signoff(id, 'manager_review').at;
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(signoff(id, 'manager_review').at, first);
  assert.equal(signoff(id, 'manager_review').actor_name, 'Lukonga Lindunda');
});

test('REGRESSION: nothing arrives pre-signed', () => {
  const p = freshDb();
  const id = expense(p.staff);
  assert.equal(signoff(id, 'manager_review'), undefined);
  assert.equal(signoff(id, 'finance_review'), undefined);
  assert.equal(signoff(id, 'final_approval'), undefined);
});

test('the old log: real findings fire on the imported 22 requests', () => {
  freshDb();
  const rows = all(`SELECT * FROM requests WHERE legacy = 1`);
  assert.equal(rows.length, 22);
  assert.equal(one(`SELECT SUM(amount) AS t FROM requests WHERE legacy = 1 AND currency = 'EUR'`).t, 20819);
  assert.equal(one(`SELECT SUM(amount) AS t FROM requests WHERE legacy = 1 AND currency = 'USD'`).t, 10375);
  assert.equal(one(`SELECT SUM(amount) AS t FROM requests WHERE legacy = 1 AND currency = 'ZMW'`).t, 17300);
  assert.equal(all(`SELECT DISTINCT project FROM requests WHERE legacy = 1`).length, 4, 'SC WIT and SC- WIT merge into one project');
  const venue = rows.find((r) => r.title.startsWith('Venue Hire'));
  assert.ok(flagsFor(venue).some((f) => f.code === 'tender'));
  const print = rows.filter((r) => r.title.startsWith('Print'));
  assert.equal(print.length, 5);
  for (const r of print.filter((x) => x.amount_zmw <= 10000)) assert.ok(flagsFor(r).some((f) => f.code === 'split'), r.title);
  assert.ok(flagsFor(rows[0]).some((f) => f.code === 'evidence'));
});

test('the same receipt cannot support two requests', () => {
  const p = freshDb();
  const a = expense(p.staff), b = expense(p.staff2);
  addDoc(a, p.staff, 'receipt', 'same-hash');
  addDoc(b, p.staff2, 'receipt', 'same-hash');
  assert.ok(flagsFor(getRequest(b)).some((f) => f.code === 'reused'));
});

test('settings override the defaults', () => {
  freshDb();
  run(`INSERT INTO settings (k, v) VALUES ('retirement_days', '7')`);
  assert.equal(getSettings().retirement_days, 7);
});

test('a blank price or quantity is refused, never treated as zero', () => {
  const p = freshDb();
  const id = toSourcing(p, [['Thing', 1]], 500);
  blocked(() => saveQuote(getRequest(id), { vendor_id: addVendor('V'), currency: 'ZMW', price: {}, vat: 200 }), /unit price/);
});

test('selected quote is unique after resubmission', () => {
  const p = freshDb();
  const id = toSourcing(p, [['Thing', 1]], 500);
  const q1 = quote(p, id, addVendor('A'), 500), q2 = quote(p, id, addVendor('B'), 400);
  perform(p.staff, id, 'approve', { ...choose, selected_quote: q1 });
  perform(p.dirA, id, 'return', { comment: 'Choose the cheaper one' });
  perform(p.staff, id, 'approve', { ...choose, selected_quote: q2 });
  assert.equal(selectedQuote(id).id, q2);
  assert.equal(getRequest(id).amount, 400);
});

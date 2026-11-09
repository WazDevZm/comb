import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, serve, browser, idFrom, addVendor } from './helpers.js';
import { one, all } from '../src/db.js';
import { setClient } from '../src/ai.js';

let s, p, staff, staff2, dirA, dirB, fin;
before(async () => {
  p = freshDb();
  s = await serve();
  [staff, staff2, dirA, dirB, fin] = await Promise.all([p.staff, p.staff2, p.dirA, p.dirB, p.fin].map((u) => browser(s.base, u.id)));
});
after(() => s.close());

const expenseForm = (over = {}) => ({ title: 'Printer toner', project: 'HIVOS', currency: 'ZMW', priority: 'Medium', justification: 'The printer is out of toner and we print daily.', 'lines[0][description]': 'Toner', 'lines[0][total]': '1,500.50', ...over });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('signed-out visitors are sent to login', async () => {
  const res = await fetch(`${s.base}/register`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/login');
});

test('REGRESSION: amounts must be real numbers. "k11,OOO" is refused with a clear message', async () => {
  const res = await staff.post('/new/expense', expenseForm({ 'lines[0][total]': 'k11,OOO' }));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /must be numbers/);
  assert.equal(all(`SELECT 1 FROM requests WHERE legacy = 0`).length, 0);
});

test('a staff member creates and submits an expense over HTTP; amounts with commas are parsed', async () => {
  const res = await staff.post('/new/expense', expenseForm());
  const id = idFrom(res);
  assert.equal(one('SELECT amount FROM requests WHERE id = ?', id).amount, 1500.5);
  await staff.post(`/r/${id}/act`, { action: 'approve' });
  assert.equal(one('SELECT state FROM requests WHERE id = ?', id).state, 'manager_review');
});

test('staff cannot see each other\'s requests, documents or finance pages', async () => {
  const id = idFrom(await staff.post('/new/expense', expenseForm({ title: 'Private item' })));
  assert.equal((await staff2.get(`/r/${id}`)).status, 404);
  assert.equal((await staff2.get(`/r/${id}/print/pack`)).status, 404);
  assert.equal((await staff2.get('/admin')).status, 403);
  assert.equal((await staff2.get('/reports')).status, 403);
  assert.equal((await staff2.get('/export/xero.csv')).status, 403);
  assert.ok(!(await (await staff2.get('/register')).text()).includes('Private item'));
  assert.equal((await dirA.get(`/r/${id}`)).status, 200);
});

test('a person who is not the current approver cannot act by posting directly', async () => {
  const id = idFrom(await staff.post('/new/expense', expenseForm()));
  await staff.post(`/r/${id}/act`, { action: 'approve' });
  const res = await staff.post(`/r/${id}/act`, { action: 'approve' });
  assert.match(res.headers.get('location'), /err=/);
  assert.equal(one('SELECT state FROM requests WHERE id = ?', id).state, 'manager_review');
});

test('user text is escaped in pages', async () => {
  const id = idFrom(await staff.post('/new/expense', expenseForm({ title: '<script>alert(1)</script>' })));
  const page = await (await staff.get(`/r/${id}`)).text();
  assert.ok(!page.includes('<script>alert(1)'));
  assert.ok(page.includes('&lt;script&gt;'));
});

test('cross-site posts are refused', async () => {
  const res = await staff.get('/new/expense', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'title=x' });
  assert.equal(res.status, 403);
});

test('uploads: images are stored and served, other file types are refused', async () => {
  const id = idFrom(await staff.post('/new/expense', expenseForm()));
  const bad = await staff.upload(`/r/${id}/docs`, { kind: 'invoice' }, 'run.html', '<script>', 'text/html');
  assert.match(bad.headers.get('location'), /err=/);
  const good = await staff.upload(`/r/${id}/docs`, { kind: 'invoice' }, 'receipt.png', PNG, 'image/png');
  assert.match(good.headers.get('location'), /ok=/);
  const doc = one('SELECT * FROM documents WHERE request_id = ?', id);
  assert.ok(doc.sha256.length === 64);
  const file = await staff.get(`/docs/${doc.id}`);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal((await staff2.get(`/docs/${doc.id}`)).status, 404);
});

test('scan works without AI, and with AI it returns the reading for a person to confirm', async () => {
  const id = idFrom(await staff.post('/new/expense', expenseForm()));
  const off = await (await staff.upload(`/r/${id}/scan`, { kind: 'receipt' }, 'a.png', PNG, 'image/png')).json();
  assert.equal(off.read, null);
  assert.ok(off.document_id);
  const reading = { vendor: 'Puma', date: '2026-11-01', document_number: 'R1', currency: 'ZMW', subtotal: null, vat: null, total: 450, category: 'Fuel', line_items: [], confidence: 'high' };
  const calls = [];
  setClient({ beta: { messages: { parse: async (args) => { calls.push(args); return { stop_reason: 'end_turn', parsed_output: reading }; } } } });
  const on = await (await staff.upload(`/r/${id}/scan`, { kind: 'receipt' }, 'b.png', Buffer.concat([PNG, Buffer.from('x')]), 'image/png')).json();
  setClient(null);
  assert.equal(on.read.total, 450);
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.equal(calls[0].messages[0].content[0].type, 'image');
  assert.equal(one('SELECT state FROM requests WHERE id = ?', id).state, 'draft', 'AI never moves a request');
});

test('a failed AI call does not lose the upload', async () => {
  const id = idFrom(await staff.post('/new/expense', expenseForm()));
  setClient({ beta: { messages: { parse: async () => { throw new Error('API down'); } } } });
  const res = await staff.upload(`/r/${id}/scan`, { kind: 'receipt' }, 'c.png', Buffer.concat([PNG, Buffer.from('y')]), 'image/png');
  setClient(null);
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.ok(out.document_id);
  assert.equal(out.read, null);
});

test('REGRESSION: GBP is reported, and CSV cells cannot run as formulas', async () => {
  const id = idFrom(await staff.post('/new/expense', expenseForm({ currency: 'GBP', title: '=HYPERLINK("http://x")', 'lines[0][total]': '100' })));
  await staff.post(`/r/${id}/act`, { action: 'approve' });
  const report = await (await fin.get('/reports')).text();
  assert.match(report, /GBP/);
  assert.match(report, /100\.00/);
  const csv = await (await fin.get('/register.csv')).text();
  assert.ok(csv.includes(`"'=HYPERLINK`));
});

test('every print document renders for a finished procurement, through the web forms', async () => {
  const vendor = addVendor('Print Test Vendor');
  const form = { title: 'Desks', project: 'SC WiT', currency: 'ZMW', amount: '4000', justification: 'New desks for the programme team starting this month.', 'lines[0][description]': 'Desk', 'lines[0][qty]': '2', 'lines[0][uom]': 'each' };
  const id = idFrom(await staff.post('/new/procurement', form));
  await staff.post(`/r/${id}/act`, { action: 'approve' });
  await dirA.post(`/r/${id}/act`, { action: 'approve' });
  await fin.post(`/r/${id}/act`, { action: 'approve', available_budget: '9000', budget_line: 'Equipment' });
  const scan = await (await staff.upload(`/r/${id}/scan`, { kind: 'quote' }, 'q.png', Buffer.concat([PNG, Buffer.from('q')]), 'image/png')).json();
  const line = one(`SELECT id FROM lines WHERE request_id = ? AND kind = 'item'`, id);
  const saved = await staff.post(`/r/${id}/quotes`, { vendor_id: vendor, currency: 'ZMW', [`price[L${line.id}]`]: '1900', vat: '200', extra: '0', document_id: scan.document_id });
  assert.match(saved.headers.get('location'), /ok=/);
  const q = one('SELECT id FROM quotes WHERE request_id = ?', id);
  await staff.post(`/r/${id}/act`, { action: 'approve', selected_quote: q.id, selection_reason: 'Only vendor able to deliver this month.', coi: '1' });
  await dirA.post(`/r/${id}/act`, { action: 'approve', coi: '1' });
  await dirB.post(`/r/${id}/act`, { action: 'approve', coi: '1' });
  await fin.post(`/r/${id}/act`, { action: 'approve', payment_terms: '30 days' });
  await staff.upload(`/r/${id}/docs`, { kind: 'invoice' }, 'inv.png', Buffer.concat([PNG, Buffer.from('i')]), 'image/png');
  await staff.post(`/r/${id}/act`, { action: 'approve', [`received[L${line.id}]`]: '2', [`condition[L${line.id}]`]: 'Good', invoice_no: 'INV-9', invoice_amount: '4000', received_on: '2026-11-05' });
  await fin.post(`/r/${id}/act`, { action: 'approve' });
  await dirA.post(`/r/${id}/act`, { action: 'approve' });
  await fin.post(`/r/${id}/act`, { action: 'approve', paid_on: '2026-11-06', method: 'Bank Transfer', reference: 'FT9' });
  await fin.post(`/r/${id}/act`, { action: 'approve' });
  assert.equal(one('SELECT state FROM requests WHERE id = ?', id).state, 'sealed');
  for (const [doc, text] of [['pr', 'Procurement requisition'], ['analysis', 'Quote analysis'], ['po', '4,000.00'], ['grn', 'Goods received note'], ['pv', 'Four thousand Kwacha only'], ['pack', 'Evidence index']]) {
    const res = await fin.get(`/r/${id}/print/${doc}`);
    assert.equal(res.status, 200, doc);
    assert.ok((await res.text()).includes(text), doc);
  }
  const x = await (await fin.get('/export/xero.csv')).text();
  assert.match(x, /Print Test Vendor,INV-9/);
  const again = await (await fin.get('/export/xero.csv')).text();
  assert.ok(!again.includes('INV-9'), 'each bill exports once');
  assert.equal((await fin.get(`/r/${id}`)).status, 200);
});

test('every main page renders for every role', async () => {
  for (const b of [staff, dirA, fin]) {
    for (const path of ['/', '/new', '/new/expense', '/new/procurement', '/new/advance', '/register', '/vendors']) {
      assert.equal((await b.get(path)).status, 200, path);
    }
  }
  for (const path of ['/advances', '/reports', '/admin']) assert.equal((await fin.get(path)).status, 200, path);
});

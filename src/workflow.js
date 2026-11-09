import { one, all, run, tx, getSettings, nextNumber, rateFor } from './db.js';
import { createHash } from 'node:crypto';
import { round2, num, today, nowIso, quoteRule, addWorkingDays, retirementVariance, threeWayMatch, quoteTotals } from './rules.js';

export class UserError extends Error {}
const fail = (m) => { throw new UserError(m); };

// who: 'requester' or an approval role. gate: nobody may act twice inside one gate.
export const STAGES = {
  draft: { label: 'Draft', who: 'requester' },
  manager_review: { label: 'Manager review', who: 'manager', gate: 'request' },
  finance_review: { label: 'Finance review', who: 'finance', gate: 'request' },
  final_approval: { label: 'Final approval', who: 'director', gate: 'pay' },
  sourcing: { label: 'Quotes', who: 'requester' },
  selection_check: { label: 'Quote check', who: 'manager', gate: 'selection' },
  selection_authorise: { label: 'Vendor authorised', who: 'director', gate: 'selection' },
  po: { label: 'Purchase order', who: 'finance' },
  receiving: { label: 'Goods received', who: 'requester' },
  match: { label: 'Three-way match', who: 'finance', gate: 'pay' },
  payment: { label: 'Payment', who: 'finance' },
  acknowledge: { label: 'Receipt of funds', who: 'requester' },
  retirement: { label: 'Retirement', who: 'requester' },
  retirement_verify: { label: 'Retirement check', who: 'finance', gate: 'retire' },
  retirement_approve: { label: 'Retirement approval', who: 'director', gate: 'retire' },
  settlement: { label: 'Settle balance', who: 'finance' },
  closeout: { label: 'Evidence check', who: 'finance' },
  sealed: { label: 'Sealed' },
  rejected: { label: 'Rejected' },
  legacy: { label: 'Imported' },
};

export const FLOWS = {
  expense: ['draft', 'manager_review', 'finance_review', 'final_approval', 'payment', 'closeout', 'sealed'],
  advance: ['draft', 'manager_review', 'finance_review', 'final_approval', 'payment', 'acknowledge', 'retirement', 'retirement_verify', 'retirement_approve', 'settlement', 'sealed'],
  procurement: ['draft', 'manager_review', 'finance_review', 'sourcing', 'selection_check', 'selection_authorise', 'po', 'receiving', 'match', 'final_approval', 'payment', 'closeout', 'sealed'],
};
// In expense and advance flows the finance reviewer and final approver must also be different people.
const gateOf = (r, stage) => (r.type !== 'procurement' && stage === 'final_approval' ? 'request' : STAGES[stage].gate);

export const TYPE_LABEL = { expense: 'Expense', procurement: 'Procurement', advance: 'Staff advance' };
export const TYPE_PREFIX = { expense: 'EXP', procurement: 'PR', advance: 'ADV' };

export const dataOf = (r) => JSON.parse(r.data || '{}');
export const getRequest = (id) => one('SELECT * FROM requests WHERE id = ?', id);
export const linesOf = (id, kind) => all('SELECT * FROM lines WHERE request_id = ? AND kind = ? ORDER BY pos', id, kind);
export const voucherOf = (id) => one('SELECT * FROM vouchers WHERE request_id = ?', id);
export const docsOf = (id, kind) => (kind
  ? all('SELECT * FROM documents WHERE request_id = ? AND kind = ? ORDER BY id', id, kind)
  : all('SELECT * FROM documents WHERE request_id = ? ORDER BY id', id));

export function quotesOf(id) {
  return all(`SELECT q.*, v.name AS vendor_name, v.status AS vendor_status FROM quotes q JOIN vendors v ON v.id = q.vendor_id WHERE q.request_id = ? ORDER BY q.id`, id)
    .map((q) => ({ ...q, prices: all('SELECT * FROM quote_prices WHERE quote_id = ?', q.id) }));
}
export const selectedQuote = (id) => quotesOf(id).find((q) => q.selected);
export const eventsOf = (id) => all('SELECT * FROM events WHERE request_id = ? ORDER BY id', id);

export function logEvent(requestId, actor, action, stage, detail) {
  run('INSERT INTO events (request_id, actor_id, actor_name, action, stage, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    requestId, actor?.id ?? null, actor?.name ?? 'Comb', action, stage ?? null, detail ?? null, nowIso());
}
// The latest sign-off for a stage. Earlier rounds still count for separation of duties.
export function signoff(requestId, stage) {
  return one(`SELECT * FROM events WHERE request_id = ? AND stage = ? AND action = 'approved' ORDER BY id DESC LIMIT 1`, requestId, stage);
}

const isSenior = (u) => u.role === 'director' || u.role === 'finance';
export const requesterOf = (r) => one('SELECT * FROM users WHERE id = ?', r.requester_id);

function shouldSkip(r, stage) {
  if (stage === 'manager_review') return isSenior(requesterOf(r));
  if (stage === 'settlement') return retirementSummary(r).variance === 0;
  return false;
}
export function nextStage(r, from = r.state) {
  const flow = FLOWS[r.type];
  for (let i = flow.indexOf(from) + 1; i < flow.length; i++) if (!shouldSkip(r, flow[i])) return flow[i];
  return 'sealed';
}
export const visibleFlow = (r) => FLOWS[r.type].filter((s) => s === 'draft' || !shouldSkip(r, s) || s === 'settlement');

function gateActors(r, stage) {
  const gate = gateOf(r, stage);
  if (!gate) return new Set();
  const ids = new Set();
  for (const s of FLOWS[r.type]) {
    if (s !== stage && gateOf(r, s) === gate) {
      const e = signoff(r.id, s);
      if (e) ids.add(e.actor_id);
    }
  }
  return ids;
}

// Everyone who may act on this request at this stage. Separation of duties is enforced here.
export function eligible(r, stage = r.state) {
  const def = STAGES[stage];
  if (!def?.who) return [];
  const requester = requesterOf(r);
  if (def.who === 'requester') return [requester];
  const blocked = gateActors(r, stage);
  blocked.add(r.requester_id);
  const active = all('SELECT * FROM users WHERE active = 1');
  const free = (u) => !blocked.has(u.id);
  if (def.who === 'manager') {
    const lead = one('SELECT u.* FROM departments d JOIN users u ON u.id = d.lead_id WHERE d.name = ? AND u.active = 1', r.department);
    if (lead && free(lead)) return [lead];
    return active.filter((u) => u.role === 'director' && free(u));
  }
  const main = active.filter((u) => u.role === def.who && free(u));
  if (main.length) return main;
  // Fallback so the finance lead's own requests, or a director's, can still clear separation of duties.
  return active.filter((u) => isSenior(u) && free(u));
}
export const canAct = (user, r) => eligible(r).some((u) => u.id === user.id);

export function canView(user, r) {
  if (isSenior(user) || r.requester_id === user.id) return true;
  if (one('SELECT 1 AS x FROM departments WHERE name = ? AND lead_id = ?', r.department, user.id)) return true;
  return canAct(user, r);
}

export function retirementSummary(r) {
  const v = voucherOf(r.id);
  const spent = round2(linesOf(r.id, 'retirement').reduce((s, l) => s + l.total, 0));
  const received = v ? v.amount : r.amount;
  return { received, spent, variance: retirementVariance(received, spent) };
}

export function retirementDue(r) {
  const d = dataOf(r);
  const v = voucherOf(r.id);
  const base = d.activity_end || v?.paid_on;
  return base ? addWorkingDays(base, getSettings().retirement_days) : null;
}

export function unretiredAdvances(userId) {
  return all(`SELECT * FROM requests WHERE type = 'advance' AND requester_id = ? AND state IN ('acknowledge', 'retirement') `, userId);
}
export function overdueAdvances(userId) {
  const t = today();
  return unretiredAdvances(userId).filter((r) => { const due = retirementDue(r); return due && due < t; });
}

function matchFor(r) {
  const q = selectedQuote(r.id);
  if (!q) return null;
  const lines = linesOf(r.id, 'item').map((l) => ({
    ...l, unit_price: q.prices.find((p) => p.line_id === l.id)?.unit_price ?? 0,
  }));
  return threeWayMatch({ lines, extra: q.extra, vat: q.vat, invoiceAmount: dataOf(r).invoice_amount ?? null });
}
export { matchFor };

export function payeeOf(r) {
  if (r.type === 'advance') return requesterOf(r).name;
  if (r.type === 'procurement') return selectedQuote(r.id)?.vendor_name ?? '';
  return dataOf(r).payee || requesterOf(r).name;
}

function setData(r, patch) {
  const data = { ...dataOf(r), ...patch };
  run('UPDATE requests SET data = ? WHERE id = ?', JSON.stringify(data), r.id);
  r.data = JSON.stringify(data);
}

function moveTo(r, stage) {
  if (stage === 'sealed') {
    // State and seal land in one write, because the database refuses changes to a sealed record.
    const hash = hashOf(getRequest(r.id));
    run(`UPDATE requests SET state = 'sealed', seal_hash = ?, sealed_at = ? WHERE id = ?`, hash, nowIso(), r.id);
    r.state = 'sealed';
    return;
  }
  run('UPDATE requests SET state = ? WHERE id = ?', stage, r.id);
  r.state = stage;
  if (stage === 'payment') createVoucher(r);
}

function createVoucher(r) {
  if (voucherOf(r.id)) return;
  const d = dataOf(r);
  const amount = r.type === 'procurement' ? d.payable ?? r.amount : r.amount;
  const no = nextNumber('PV', today().slice(0, 4));
  run('INSERT INTO vouchers (request_id, voucher_no, amount, currency, payee, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    r.id, no, amount, r.currency, payeeOf(r), nowIso());
}

export function sealPayload(r) {
  const { state, sealed_at, seal_hash, xero_exported_at, ...core } = r;
  return JSON.stringify({
    core,
    lines: all('SELECT * FROM lines WHERE request_id = ? ORDER BY id', r.id),
    quotes: all('SELECT * FROM quotes WHERE request_id = ? ORDER BY id', r.id),
    voucher: voucherOf(r.id) ?? null,
    documents: all('SELECT filename, kind, sha256 FROM documents WHERE request_id = ? ORDER BY id', r.id),
  });
}
const hashOf = (r) => createHash('sha256').update(sealPayload(r)).digest('hex');
export const sealIntact = (r) => r.seal_hash === hashOf(r);

const requireComment = (i, what) => { if (!String(i.comment ?? '').trim()) fail(`Add a comment explaining why you ${what}.`); };
const requireTrue = (v, m) => { if (!v) fail(m); };

function approve(user, r, input, detail) {
  logEvent(r.id, user, 'approved', r.state, [detail, String(input.comment ?? '').trim()].filter(Boolean).join(' · ') || null);
  moveTo(r, nextStage(r));
}

function submitDraft(user, r) {
  const s = getSettings();
  if (r.type === 'expense' && r.amount_zmw > s.expense_limit) fail(`This is above the K${s.expense_limit.toLocaleString()} expense limit, so it needs to go through procurement. Use "Move to procurement" below.`);
  if (r.type === 'advance' && s.block_advance_if_overdue && overdueAdvances(r.requester_id).length) fail('You have an overdue advance to retire first.');
  if (!r.amount || r.amount <= 0) fail('Add at least one line with an amount.');
  if (!r.project) fail('Choose a project.');
  if (String(r.justification ?? '').trim().length < 15) fail('Explain why this is needed in a full sentence. One word is not enough for an audit.');
  const rate = rateFor(r.currency);
  run('UPDATE requests SET rate = ?, amount_zmw = ?, submitted_at = ? WHERE id = ?', rate, round2(r.amount * rate), nowIso(), r.id);
  r.rate = rate; r.amount_zmw = round2(r.amount * rate);
  logEvent(r.id, user, 'submitted', 'draft');
  moveTo(r, nextStage(r));
}

function submitSourcing(user, r, input) {
  const s = getSettings();
  const quotes = quotesOf(r.id);
  const chosen = quotes.find((q) => q.id === Number(input.selected_quote));
  if (!chosen) fail('Choose the vendor you recommend.');
  const rule = quoteRule(Math.max(r.amount_zmw, chosen.total_zmw), s);
  if (quotes.length < rule.min) fail(`${rule.process} is required at this value. You have ${quotes.length}.`);
  for (const q of quotes) if (!q.document_id) fail(`Attach the quote document for ${q.vendor_name}.`);
  if (rule.tender && !docsOf(r.id, 'tender').length) fail('Above the tender limit: attach the tender document before continuing.');
  if (chosen.vendor_status === 'blocked') fail(`${chosen.vendor_name} is blocked in the vendor list.`);
  if (String(input.selection_reason ?? '').trim().length < 15) fail('Explain why this vendor gives best value for money.');
  requireTrue(input.coi, 'Confirm that you have no conflict of interest with the chosen vendor.');
  run('UPDATE quotes SET selected = 0 WHERE request_id = ?', r.id);
  run('UPDATE quotes SET selected = 1 WHERE id = ?', chosen.id);
  // The selected quote becomes the single source of truth for every later document.
  run('UPDATE requests SET amount = ?, currency = ?, rate = ?, amount_zmw = ? WHERE id = ?', chosen.total, chosen.currency, chosen.rate, chosen.total_zmw, r.id);
  Object.assign(r, { amount: chosen.total, currency: chosen.currency, rate: chosen.rate, amount_zmw: chosen.total_zmw });
  setData(r, { selection_reason: String(input.selection_reason).trim() });
  logEvent(r.id, user, 'approved', 'sourcing', `Recommended ${chosen.vendor_name} · conflict of interest declared: none`);
  moveTo(r, nextStage(r));
}

const STAGE_ACTIONS = {
  draft: submitDraft,
  sourcing: submitSourcing,
  manager_review: (u, r, i) => approve(u, r, i),
  final_approval: (u, r, i) => approve(u, r, i),
  finance_review(u, r, i) {
    const available = num(i.available_budget);
    if (!Number.isFinite(available) || available < 0) fail('Enter the available budget.');
    if (!String(i.budget_line ?? r.budget_line ?? '').trim()) fail('Confirm the budget line.');
    run('UPDATE requests SET budget_line = ? WHERE id = ?', String(i.budget_line ?? r.budget_line).trim(), r.id);
    setData(r, { available_budget: round2(available) });
    approve(u, r, i, `Budget confirmed: K${available.toLocaleString()} available`);
  },
  selection_check(u, r, i) {
    requireTrue(i.coi, 'Confirm that you have no conflict of interest with the chosen vendor.');
    approve(u, r, i, 'Conflict of interest declared: none');
  },
  selection_authorise(u, r, i) {
    requireTrue(i.coi, 'Confirm that you have no conflict of interest with the chosen vendor.');
    const q = selectedQuote(r.id);
    if (q.vendor_status !== 'approved') fail(`${q.vendor_name} is not an approved vendor yet. Approve it in Vendors first, with its company profile and SLA.`);
    const d = dataOf(r);
    if (d.available_budget != null && q.total_zmw > d.available_budget) requireComment(i, 'are authorising above the available budget');
    approve(u, r, i, 'Conflict of interest declared: none');
  },
  po(u, r, i) {
    const po = nextNumber('PO', today().slice(0, 4));
    setData(r, { po_no: po, po_date: today(), payment_terms: String(i.payment_terms ?? '').trim(), vendor_reference: String(i.vendor_reference ?? '').trim() });
    approve(u, r, i, `Issued ${po}`);
  },
  receiving(u, r, i) {
    const lines = linesOf(r.id, 'item');
    for (const l of lines) {
      const q = num(i.received?.[`L${l.id}`]);
      if (!Number.isFinite(q) || q < 0) fail(`Enter the quantity received for ${l.description}.`);
      const cond = i.condition?.[`L${l.id}`];
      if (!['Good', 'Damaged', 'Partial', 'Rejected'].includes(cond)) fail(`Choose a condition for ${l.description}.`);
      run('UPDATE lines SET received_qty = ?, condition = ? WHERE id = ?', q, cond, l.id);
    }
    if (!docsOf(r.id, 'invoice').length) fail('Attach the vendor invoice before confirming.');
    const inv = num(i.invoice_amount);
    if (!Number.isFinite(inv) || inv <= 0) fail('Enter the invoice total.');
    if (!String(i.invoice_no ?? '').trim()) fail('Enter the invoice number.');
    setData(r, { invoice_amount: round2(inv), invoice_no: String(i.invoice_no).trim(), received_on: i.received_on || today(), grn_no: nextNumber('GRN', today().slice(0, 4)) });
    approve(u, r, i, 'Delivery confirmed');
  },
  match(u, r, i) {
    const m = matchFor(r);
    let payable = m.payable;
    if (!m.matched) {
      requireComment(i, 'are clearing a mismatch');
      const chosen = num(i.payable);
      if (!Number.isFinite(chosen) || chosen <= 0) fail('Enter the amount to pay.');
      if (chosen > m.grnValue + 0.01) fail('You cannot pay more than the value of what was received.');
      payable = chosen;
    }
    setData(r, { payable: round2(payable), match_issues: m.issues });
    approve(u, r, i, m.matched ? 'PO, GRN and invoice agree' : `Exception cleared: paying ${payable}`);
  },
  payment(u, r, i) {
    const v = voucherOf(r.id);
    if (!i.paid_on) fail('Enter the payment date.');
    if (!i.method) fail('Choose how it was paid.');
    if (!String(i.reference ?? '').trim()) fail('Enter the bank, mobile money or cash reference.');
    run('UPDATE vouchers SET paid_on = ?, method = ?, mobile_network = ?, account_details = ?, reference = ? WHERE id = ?',
      i.paid_on, i.method, i.mobile_network || null, i.account_details || null, String(i.reference).trim(), v.id);
    approve(u, r, i, `${v.voucher_no} paid by ${i.method}, ref ${String(i.reference).trim()}`);
  },
  acknowledge(u, r, i) {
    requireTrue(i.ack, 'Confirm that you received the money.');
    run('UPDATE vouchers SET ack_by = ?, ack_at = ? WHERE request_id = ?', u.id, nowIso(), r.id);
    approve(u, r, i, 'Payee confirmed receipt of funds');
  },
  retirement(u, r, i) {
    const lines = linesOf(r.id, 'retirement');
    if (!lines.length) fail('Add what you spent, or record a zero spend line.');
    const noReceipt = lines.filter((l) => !l.document_id && !String(l.comment ?? '').trim());
    if (noReceipt.length) fail(`Attach a receipt, or explain in the line comment why there is none: ${noReceipt.map((l) => l.description).join(', ')}.`);
    requireTrue(i.certify, 'Certify that this is a true account of what you spent.');
    setData(r, { retired_on: today() });
    approve(u, r, i, 'Retirement submitted');
  },
  retirement_verify: (u, r, i) => approve(u, r, i),
  retirement_approve: (u, r, i) => approve(u, r, i),
  settlement(u, r, i) {
    if (!i.mode) fail('Choose how the balance was settled.');
    if (!String(i.reference ?? '').trim()) fail('Enter the slip or transaction reference.');
    setData(r, { settlement: { mode: i.mode, reference: String(i.reference).trim(), date: i.date || today(), amount: retirementSummary(r).variance } });
    approve(u, r, i, `Balance settled by ${i.mode}`);
  },
  closeout(u, r, i) {
    const docs = docsOf(r.id);
    if (!docs.some((d) => ['invoice', 'receipt'].includes(d.kind))) fail('A record cannot be sealed without an invoice or receipt.');
    approve(u, r, i, 'Evidence complete');
  },
};

const ALWAYS_REVIEWABLE = ['manager_review', 'finance_review', 'final_approval', 'selection_check', 'selection_authorise', 'match', 'retirement_verify', 'retirement_approve'];
export const canSendBack = (r) => ALWAYS_REVIEWABLE.includes(r.state);

const sendBackTarget = (r) => {
  if (r.state === 'retirement_verify' || r.state === 'retirement_approve') return 'retirement';
  if (r.state === 'selection_check' || r.state === 'selection_authorise') return 'sourcing';
  if (r.state === 'match') return 'receiving';
  if (r.type === 'procurement' && r.state === 'final_approval') return 'match';
  return 'draft';
};

export function perform(user, requestId, action, input = {}) {
  return tx(() => {
    const r = getRequest(requestId);
    if (!r) fail('Request not found.');
    if (!canAct(user, r)) fail('This step is not yours to complete.');
    if (action === 'approve') {
      const fn = STAGE_ACTIONS[r.state];
      if (!fn) fail('Nothing to do at this stage.');
      fn(user, r, input);
    } else if (action === 'return') {
      if (!canSendBack(r)) fail('This step cannot be sent back.');
      requireComment(input, 'are sending this back');
      const target = sendBackTarget(r);
      logEvent(r.id, user, 'returned', r.state, `Sent back to ${STAGES[target].label}: ${input.comment.trim()}`);
      moveTo(r, target);
    } else if (action === 'reject') {
      if (!canSendBack(r) || voucherOf(r.id)?.paid_on) fail('This step cannot be rejected.');
      requireComment(input, 'are rejecting this');
      logEvent(r.id, user, 'rejected', r.state, input.comment.trim());
      moveTo(r, 'rejected');
    } else fail('Unknown action.');
    return getRequest(requestId);
  });
}

// Save a quote with server-side totals so the figures can never drift from the line prices.
export function saveQuote(r, input) {
  const lines = linesOf(r.id, 'item');
  const currency = input.currency || 'ZMW';
  const rate = rateFor(currency);
  const prices = lines.map((l) => ({ line_id: l.id, qty: l.qty, unit_price: num(input.price?.[`L${l.id}`]) }));
  if (prices.some((p) => !Number.isFinite(p.unit_price) || p.unit_price < 0)) fail('Enter a unit price for every item.');
  const extra = num(input.extra || 0), vat = num(input.vat || 0);
  if (!Number.isFinite(extra) || !Number.isFinite(vat)) fail('Extra costs and VAT must be numbers.');
  const t = quoteTotals(prices, extra, vat, rate);
  if (t.total <= 0) fail('This quote totals zero.');
  return tx(() => {
    const q = run(`INSERT INTO quotes (request_id, vendor_id, quote_date, reference, validity, currency, rate, extra, vat, subtotal, total, total_zmw, document_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, r.id, Number(input.vendor_id), input.quote_date || null, input.reference || null, input.validity || null,
      currency, rate, extra, vat, t.subtotal, t.total, t.total_zmw, input.document_id ? Number(input.document_id) : null);
    for (const p of prices) run('INSERT INTO quote_prices (quote_id, line_id, unit_price) VALUES (?, ?, ?)', q.lastInsertRowid, p.line_id, p.unit_price);
    return q.lastInsertRowid;
  });
}

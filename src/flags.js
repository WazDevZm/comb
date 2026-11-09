import { one, all, getSettings } from './db.js';
import { quoteRule, round2 } from './rules.js';
import { dataOf, docsOf, linesOf, overdueAdvances, retirementSummary, FLOWS } from './workflow.js';

const kwacha = (n) => `K${Math.round(n).toLocaleString('en-ZM')}`;
const STOP = new Set(['the', 'for', 'and', 'of', 'to', 'a', 'an', 'in', 'on', 'with', 'purchase', 'payment', 'monthly']);
const keyword = (title) => String(title).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).find((w) => w.length > 2 && !STOP.has(w));

function daysApart(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs(new Date(a) - new Date(b)) / 86400000;
}

// Similar purchases, same person and project, that only stay under a threshold when counted separately.
export function splitCheck(r, s) {
  const word = keyword(r.title);
  if (!word) return null;
  const peers = all(`SELECT * FROM requests WHERE id != ? AND requester_id = ? AND project = ? AND state NOT IN ('rejected', 'draft')`, r.id, r.requester_id, r.project)
    .filter((o) => keyword(o.title) === word && daysApart(o.date_needed, r.date_needed) <= s.split_window_days);
  if (!peers.length) return null;
  const combined = round2(peers.reduce((t, o) => t + o.amount_zmw, r.amount_zmw));
  const alone = quoteRule(r.amount_zmw, s), together = quoteRule(combined, s);
  if (together.band <= alone.band) return null;
  return {
    level: 'warn', code: 'split',
    message: `Possible split purchase: ${peers.length + 1} "${word}" requests total ${kwacha(combined)} together, which would need "${together.process}". Check whether this is one purchase.`,
    refs: peers.map((p) => ({ id: p.id, ref: p.ref })),
  };
}

export function flagsFor(r) {
  const s = getSettings();
  const out = [];
  const d = dataOf(r);
  const rule = quoteRule(r.amount_zmw, s);
  const docs = docsOf(r.id);
  const open = !['sealed', 'rejected'].includes(r.state);

  if (r.type !== 'procurement' && rule.tender) out.push({ level: 'block', code: 'tender', message: `${kwacha(r.amount_zmw)} is above the ${kwacha(s.tender_above)} limit, so this needs an open tender.` });
  else if (r.type === 'expense' && r.amount_zmw > s.expense_limit) out.push({ level: 'block', code: 'route', message: `${kwacha(r.amount_zmw)} is above the ${kwacha(s.expense_limit)} expense limit, so this belongs in procurement. It needs: ${rule.process.toLowerCase()}.` });

  const split = splitCheck(r, s);
  if (split) out.push(split);

  if (r.type === 'expense' && !docs.length) {
    out.push({ level: 'warn', code: 'evidence', message: d.evidence_note ? `No document on file. The old log says: "${d.evidence_note}".` : 'No quote or supporting document attached yet.' });
  }
  const j = String(r.justification ?? '').trim();
  if (r.state !== 'draft' && (j.length < 15 || j.toLowerCase() === r.title.toLowerCase())) out.push({ level: 'warn', code: 'justification', message: 'The justification is missing or just repeats the description.' });

  if (r.budget_line && r.state !== 'draft' && !r.legacy) {
    const line = one('SELECT * FROM budget_lines WHERE project = ? AND name = ?', r.project, r.budget_line);
    if (line?.budget_zmw != null) {
      const { used } = one(`SELECT COALESCE(SUM(amount_zmw), 0) AS used FROM requests WHERE project = ? AND budget_line = ? AND id != ? AND state NOT IN ('draft', 'rejected', 'legacy')`, r.project, r.budget_line, r.id);
      if (used + r.amount_zmw > line.budget_zmw) out.push({ level: 'warn', code: 'budget', message: `This takes ${r.budget_line} over budget: ${kwacha(used)} already committed of ${kwacha(line.budget_zmw)}.` });
    }
  }
  if (d.available_budget != null && r.amount_zmw > d.available_budget) out.push({ level: 'warn', code: 'budget_available', message: `${kwacha(r.amount_zmw)} is more than the ${kwacha(d.available_budget)} finance confirmed as available.` });

  if (r.type === 'advance' && open && FLOWS.advance.indexOf(r.state) <= FLOWS.advance.indexOf('final_approval')) {
    const overdue = overdueAdvances(r.requester_id).filter((o) => o.id !== r.id);
    if (overdue.length) out.push({ level: 'block', code: 'overdue', message: `This person has ${overdue.length} overdue advance${overdue.length > 1 ? 's' : ''} to retire: ${overdue.map((o) => o.ref).join(', ')}.` });
  }

  for (const doc of docs) {
    const twin = one('SELECT r.id, r.ref FROM documents x JOIN requests r ON r.id = x.request_id WHERE x.sha256 = ? AND x.request_id != ? LIMIT 1', doc.sha256, r.id);
    if (twin) out.push({ level: 'block', code: 'reused', message: `"${doc.filename}" was already used on ${twin.ref}. The same file cannot support two payments.`, refs: [twin] });
  }

  if (d.invoice_no) {
    const twins = all(`SELECT id, ref, data FROM requests WHERE id != ? AND type = 'procurement'`, r.id).filter((o) => dataOf(o).invoice_no === d.invoice_no && d.vendor_id === dataOf(o).vendor_id);
    if (twins.length) out.push({ level: 'block', code: 'dup_invoice', message: `Invoice ${d.invoice_no} also appears on ${twins[0].ref}.`, refs: twins });
  }

  for (const l of linesOf(r.id, 'retirement')) {
    if (!l.document_id) continue;
    const doc = docs.find((x) => x.id === l.document_id);
    const read = doc?.extracted ? JSON.parse(doc.extracted) : null;
    if (read?.total != null && Math.abs(read.total - l.total) > 0.01) out.push({ level: 'warn', code: 'receipt_mismatch', message: `${l.description}: the receipt reads ${read.total} but ${l.total} was entered.` });
  }

  if (r.type === 'advance' && ['retirement_verify', 'retirement_approve'].includes(r.state)) {
    const sum = retirementSummary(r);
    if (sum.spent > sum.received) out.push({ level: 'info', code: 'overspend', message: `Spent more than advanced. Comb will set up a reimbursement of ${(sum.spent - sum.received).toFixed(2)}.` });
  }
  return out;
}

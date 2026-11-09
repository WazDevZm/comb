import { html, raw, money, dateOnly, dateTime, options } from './layout.js';
import { CURRENCIES, all, getSettings } from '../db.js';
import { amountInWords, quoteRule, today } from '../rules.js';
import { STAGES, TYPE_LABEL, visibleFlow, dataOf, linesOf, docsOf, quotesOf, selectedQuote, voucherOf, eventsOf, eligible, canAct, canSendBack, retirementSummary, retirementDue, matchFor, sealIntact, requesterOf } from '../workflow.js';
import { flagsFor } from '../flags.js';
import { aiEnabled } from '../ai.js';

export const CATEGORIES = ['Accommodation', 'Transport', 'Fuel', 'Meals', 'Allowance', 'Charges', 'Subscriptions', 'Stationery', 'Communications', 'Other'];
const METHODS = ['Bank Transfer', 'Mobile Money', 'Cash', 'Cheque'];
const NETWORKS = ['Airtel Money', 'MTN MoMo', 'Zamtel Kwacha', 'Other'];

export function statePill(r) {
  const cls = r.state === 'sealed' ? 'sealed' : r.state === 'rejected' ? 'rejected' : ['draft', 'legacy'].includes(r.state) ? 'plain' : '';
  return html`<span class="pill ${cls}">${STAGES[r.state]?.label ?? r.state}</span>`;
}

function tracker(r) {
  if (r.state === 'legacy') return null;
  const flow = visibleFlow(r);
  const at = r.state === 'rejected' ? -1 : flow.indexOf(r.state);
  const stoppedAt = r.state === 'rejected' ? flow.indexOf(eventsOf(r.id).findLast((e) => e.action === 'rejected')?.stage) : -1;
  return html`<ol class="comb" aria-label="Progress">${flow.map((s, i) => {
    const sealedDone = s === 'sealed' && r.state === 'sealed';
    const cls = [i === stoppedAt ? 'stop' : '', i < at || sealedDone || (stoppedAt >= 0 && i < stoppedAt) ? 'done' : '', i === at && !sealedDone ? 'now' : '', s === 'sealed' ? 'final' : ''].join(' ');
    return html`<li class="${cls}"><div class="cell">${i < at || sealedDone ? raw('&#10003;') : i + 1}</div>${STAGES[s].label}</li>`;
  })}</ol>`;
}

const flagList = (flags) => flags.map((f) => html`<div class="flag ${f.level}">${f.message}${f.refs?.length ? html` <span class="small">${f.refs.map((x, i) => html`${i ? ', ' : ''}<a href="/r/${x.id}">${x.ref}</a>`)}</span>` : ''}</div>`);

const commentBox = (label = 'Comment (optional)') => html`<label>${label}<textarea name="comment" rows="2"></textarea></label>`;
const coi = html`<label class="check"><input type="checkbox" name="coi" value="1"> I confirm I have no conflict of interest with the chosen vendor.</label>`;

function reviewButtons(r) {
  return html`<div class="actions"><button class="primary" name="action" value="approve">Approve</button>
  ${canSendBack(r) && html`<button name="action" value="return">Send back</button><button class="danger" name="action" value="reject" data-confirm="Reject this request? It cannot be reopened.">Reject</button>`}</div>`;
}

function budgetFields(r) {
  const lines = all('SELECT name FROM budget_lines WHERE project = ? ORDER BY name', r.project);
  return html`<div class="row"><label>Available budget (ZMW)<span class="hint">From the project budget, checked by finance.</span><input name="available_budget" inputmode="decimal" required></label>
  <label>Budget line<input name="budget_line" list="bl" value="${r.budget_line ?? ''}" required><datalist id="bl">${lines.map((l) => html`<option value="${l.name}">`)}</datalist></label></div>`;
}

function quotesPanel(r) {
  const s = getSettings();
  const quotes = quotesOf(r.id);
  const lines = linesOf(r.id, 'item');
  const vendors = all(`SELECT id, name FROM vendors WHERE status != 'blocked' ORDER BY name`);
  const best = Math.max(r.amount_zmw, ...quotes.map((q) => q.total_zmw), 0);
  const rule = quoteRule(best, s);
  return html`<h2>Add quotes</h2>
  <p>This purchase needs: <b>${rule.process}</b>. You have ${quotes.length}.</p>
  <form method="post" action="/r/${r.id}/quotes" class="card">
    <h3>New quote</h3>
    <label>Quote document<span class="hint">Photo or PDF. ${aiEnabled() ? 'AI will prefill what it can read.' : ''}</span><input type="file" accept="image/*,application/pdf" data-scan="quote" data-url="/r/${r.id}/scan"></label>
    <div class="scanstatus" aria-live="polite"></div><input type="hidden" name="document_id">
    <div class="row">
      <label>Vendor<span class="hint">Not listed? <a href="/vendors">Add it first</a>.</span><select name="vendor_id" data-fill="vendor" required><option value="">Choose…</option>${options(vendors.map((v) => [v.id, v.name]))}</select></label>
      <label>Quote date<input type="date" name="quote_date" data-fill="date"></label>
      <label>Quote reference<input name="reference" data-fill="document_number"></label>
      <label>Valid for<input name="validity" placeholder="e.g. 30 days"></label>
      <label>Currency<select name="currency" data-fill="currency">${options(CURRENCIES, 'ZMW')}</select></label>
    </div>
    <div class="tablewrap"><table><thead><tr><th>Item</th><th>Qty</th><th>Unit price</th></tr></thead><tbody>
      ${lines.map((l) => html`<tr><td>${l.description}</td><td>${l.qty} ${l.uom ?? ''}</td><td><input name="price[L${l.id}]" inputmode="decimal" required></td></tr>`)}
    </tbody></table></div>
    <div class="row"><label>Extra costs<input name="extra" value="0" inputmode="decimal"></label><label>VAT<input name="vat" value="0" inputmode="decimal" data-fill="vat"></label></div>
    <button>Save quote</button>
  </form>
  ${quotes.length > 0 && html`<form method="post" action="/r/${r.id}/act">
    <h3>Choose a vendor</h3>${quoteComparison(r, quotes, true)}
    <label>Why this vendor gives best value for money<textarea name="selection_reason" required></textarea></label>
    ${aiEnabled() && html`<div class="actions"><button type="button" data-draft-reason="/r/${r.id}/draft-reason">Draft with AI</button></div>`}
    ${coi}<div class="actions"><button class="primary" name="action" value="approve">Submit for checking</button></div>
  </form>`}`;
}

function quoteComparison(r, quotes, pick) {
  const lowest = Math.min(...quotes.map((q) => q.total_zmw));
  return html`<div class="tablewrap"><table><thead><tr>${pick && html`<th></th>`}<th>Vendor</th><th>Status</th><th class="num">Subtotal</th><th class="num">Extras + VAT</th><th class="num">Total</th><th class="num">In ZMW</th><th>File</th></tr></thead><tbody>
  ${quotes.map((q) => html`<tr>${pick && html`<td><input type="radio" name="selected_quote" value="${q.id}" aria-label="Choose ${q.vendor_name}"></td>`}
    <td>${q.vendor_name}${q.selected ? html` <span class="pill sealed">Chosen</span>` : ''}</td><td class="small">${q.vendor_status}</td>
    <td class="num">${money(q.subtotal, q.currency)}</td><td class="num">${money(q.extra + q.vat, q.currency)}</td><td class="num">${money(q.total, q.currency)}</td>
    <td class="num ${q.total_zmw === lowest ? 'best' : ''}">${money(q.total_zmw)}</td>
    <td>${q.document_id ? html`<a href="/docs/${q.document_id}">View</a>` : 'Missing'}</td></tr>`)}
  </tbody></table></div>`;
}

function receivingPanel(r) {
  const lines = linesOf(r.id, 'item');
  return html`<h2>Confirm what arrived</h2>
  <form method="post" action="/r/${r.id}/docs" enctype="multipart/form-data" class="card">
    <label>Vendor invoice or delivery note<input type="file" name="file" accept="image/*,application/pdf" required></label>
    <div class="row"><label>Type<select name="kind">${options([['invoice', 'Invoice'], ['delivery_note', 'Delivery note']])}</select></label></div>
    <button>Upload</button>
  </form>
  <form method="post" action="/r/${r.id}/act">
    <div class="tablewrap"><table><thead><tr><th>Item</th><th>Ordered</th><th>Received</th><th>Condition</th></tr></thead><tbody>
    ${lines.map((l) => html`<tr><td>${l.description}</td><td>${l.qty}</td><td><input name="received[L${l.id}]" value="" inputmode="decimal" required></td>
      <td><select name="condition[L${l.id}]" required><option value="">Choose…</option>${options(['Good', 'Damaged', 'Partial', 'Rejected'])}</select></td></tr>`)}
    </tbody></table></div>
    <div class="row"><label>Date received<input type="date" name="received_on" value="${today()}" required></label>
    <label>Invoice number<input name="invoice_no" required></label><label>Invoice total<input name="invoice_amount" inputmode="decimal" required></label></div>
    <div class="actions"><button class="primary" name="action" value="approve">Confirm receipt</button></div>
  </form>`;
}

function matchPanel(r) {
  const m = matchFor(r);
  return html`<h2>Three-way match</h2>
  <dl class="facts"><dt>PO total</dt><dd>${money(m.poTotal, r.currency)}</dd><dt>Value received</dt><dd>${money(m.grnValue, r.currency)}</dd><dt>Invoice</dt><dd>${money(m.invoiceAmount, r.currency)}</dd></dl>
  ${m.matched ? html`<p class="flag info">All three agree. Payable: ${money(m.payable, r.currency)}.</p>` : html`
    ${m.issues.map((i) => html`<div class="flag block">${i}</div>`)}
    <label>Amount to pay<span class="hint">Cannot be more than the value received.</span><input name="payable" value="${m.payable}" inputmode="decimal" required></label>`}
  ${commentBox(m.matched ? 'Comment (optional)' : 'Why is this being cleared?')}${reviewButtons(r)}`;
}

function retirementPanel(r) {
  const lines = linesOf(r.id, 'retirement');
  const sum = retirementSummary(r);
  return html`<h2>Retire this advance</h2>
  <p class="muted">Add each thing you spent, with a photo of the receipt. Due ${dateOnly(retirementDue(r))}.</p>
  ${lines.length > 0 && html`<div class="tablewrap"><table><thead><tr><th>Spent on</th><th>Vendor</th><th>Date</th><th class="num">Amount</th><th>Receipt</th><th></th></tr></thead><tbody>
    ${lines.map((l) => html`<tr><td>${l.description}<div class="small muted">${l.category}${l.comment ? ` · ${l.comment}` : ''}</div></td><td>${l.vendor}</td><td class="small">${dateOnly(l.spent_on)}</td><td class="num">${money(l.total, r.currency)}</td>
      <td>${l.document_id ? html`<a href="/docs/${l.document_id}">View</a>` : 'None'}</td>
      <td><form method="post" action="/r/${r.id}/retirement-lines/${l.id}/delete"><button class="link">Remove</button></form></td></tr>`)}
    </tbody></table></div>`}
  <form method="post" action="/r/${r.id}/retirement-lines" class="card">
    <h3>Add a line</h3>
    <label>Receipt photo or PDF<input type="file" accept="image/*,application/pdf" data-scan="receipt" data-url="/r/${r.id}/scan"></label>
    <div class="scanstatus" aria-live="polite"></div><input type="hidden" name="document_id">
    <div class="row"><label>What was it for?<input name="description" required></label><label>Vendor<input name="vendor" data-fill="vendor"></label>
      <label>Date<input type="date" name="spent_on" data-fill="date"></label><label>Receipt number<input name="receipt_no" data-fill="document_number"></label>
      <label>Category<select name="category" data-fill="category" required><option value="">Choose…</option>${options(CATEGORIES)}</select></label><label>Amount<input name="total" inputmode="decimal" data-fill="total" required></label></div>
    <label>Comment<span class="hint">Required if there is no receipt.</span><input name="comment"></label>
    <button>Add line</button>
  </form>
  <dl class="facts"><dt>Received</dt><dd>${money(sum.received, r.currency)}</dd><dt>Spent</dt><dd>${money(sum.spent, r.currency)}</dd>
  <dt>${sum.variance >= 0 ? 'To return' : 'Owed to you'}</dt><dd><b>${money(Math.abs(sum.variance), r.currency)}</b></dd></dl>
  <form method="post" action="/r/${r.id}/act"><label class="check"><input type="checkbox" name="certify" value="1"> I certify this is a true account of what I spent and all receipts are attached.</label>
  <div class="actions"><button class="primary" name="action" value="approve">Submit retirement</button></div></form>`;
}

function actionPanel(r, user) {
  if (!canAct(user, r)) return null;
  const s = r.state;
  const wrap = (title, inner) => html`<form method="post" action="/r/${r.id}/act"><h2>${title}</h2>${inner}</form>`;
  const d = dataOf(r);
  const v = voucherOf(r.id);
  let inner;
  switch (s) {
    case 'draft':
      inner = html`<h2>Ready to submit?</h2><div class="actions"><a class="btn" href="/r/${r.id}/edit">Edit</a>
        <form method="post" action="/r/${r.id}/act"><button class="primary" name="action" value="approve">Submit</button></form>
        ${r.type === 'expense' && html`<form method="post" action="/r/${r.id}/convert"><button>Move to procurement</button></form>`}</div>`; break;
    case 'manager_review': case 'final_approval': case 'selection_check': case 'selection_authorise': case 'retirement_verify': case 'retirement_approve':
      inner = wrap(STAGES[s].label, html`${['selection_check', 'selection_authorise'].includes(s) && coi}${commentBox(canSendBack(r) ? 'Comment (needed to send back or reject)' : undefined)}${reviewButtons(r)}`); break;
    case 'finance_review':
      inner = wrap('Finance review', html`${budgetFields(r)}${commentBox('Comment (needed to send back or reject)')}${reviewButtons(r)}`); break;
    case 'sourcing': inner = quotesPanel(r); break;
    case 'po':
      inner = wrap('Issue the purchase order', html`<div class="row"><label>Payment terms<input name="payment_terms" placeholder="e.g. 30 days from invoice"></label><label>Vendor reference<input name="vendor_reference"></label></div>
        <div class="actions"><button class="primary" name="action" value="approve">Issue PO</button></div>`); break;
    case 'receiving': inner = receivingPanel(r); break;
    case 'match': inner = wrap('', matchPanel(r)); break;
    case 'payment':
      inner = wrap(`Record payment of ${money(v.amount, v.currency)}`, html`<p class="muted">Pay outside Comb, then record it here. ${v.voucher_no} to ${v.payee}.</p>
        <div class="row"><label>Paid on<input type="date" name="paid_on" value="${today()}" required></label>
        <label>Method<select name="method" required>${options(METHODS, d.payment_method)}</select></label>
        <label>Mobile network<select name="mobile_network"><option value=""></option>${options(NETWORKS)}</select></label>
        <label>Bank or mobile reference<input name="reference" required></label></div>
        <label>Account details used<input name="account_details" value="${d.mobile_number ?? d.bank_details ?? ''}"></label>
        <div class="actions"><button class="primary" name="action" value="approve">Record payment</button></div>`); break;
    case 'acknowledge':
      inner = wrap('Did you receive the money?', html`<p>${money(v.amount, v.currency)} by ${v.method}, reference ${v.reference}.</p>
        <label class="check"><input type="checkbox" name="ack" value="1"> I received this amount and will retire it with receipts by ${dateOnly(retirementDue(r))}.</label>
        <div class="actions"><button class="primary" name="action" value="approve">Confirm</button></div>`); break;
    case 'retirement': inner = retirementPanel(r); break;
    case 'settlement': {
      const sum = retirementSummary(r);
      inner = wrap(sum.variance > 0 ? `Collect ${money(sum.variance, r.currency)} from the payee` : `Reimburse ${money(-sum.variance, r.currency)} to the payee`, html`
        <div class="row"><label>How was it settled?<select name="mode" required><option value="">Choose…</option>${options(sum.variance > 0 ? ['Cash Returned', 'Bank Deposit', 'Off-Payroll Deduction'] : ['Reimbursement to Payee'])}</select></label>
        <label>Slip or reference<input name="reference" required></label><label>Date<input type="date" name="date" value="${today()}"></label></div>
        <div class="actions"><button class="primary" name="action" value="approve">Settle and seal</button></div>`); break;
    }
    case 'closeout':
      inner = wrap('Check the evidence and seal', html`<p class="muted">Sealing locks this record permanently.</p>${commentBox()}<div class="actions"><button class="primary" name="action" value="approve">Seal record</button></div>`); break;
    default: return null;
  }
  return html`<section class="card action">${inner}</section>`;
}

function waitingOn(r, user, baseUrl) {
  if (['sealed', 'rejected', 'legacy'].includes(r.state) || canAct(user, r)) return null;
  const who = eligible(r);
  const msg = `Comb: ${r.ref} is waiting on you (${STAGES[r.state].label}). ${baseUrl}/r/${r.id}`;
  return html`<section class="card"><p class="small"><b>Waiting on:</b> ${who.length ? who.map((u) => u.name).join(' or ') : 'nobody can act on this. Ask finance to check the roles in Admin.'}</p>
  ${who.length > 0 && html`<a class="small" href="https://wa.me/?text=${encodeURIComponent(msg)}" rel="noopener">Nudge on WhatsApp</a>`}</section>`;
}

function lineTable(r) {
  const cur = r.currency;
  if (r.type === 'advance') {
    const lines = linesOf(r.id, 'advance');
    return html`<div class="tablewrap"><table><thead><tr><th>Line</th><th class="num">Days</th><th class="num">Units</th><th class="num">People</th><th class="num">Unit cost</th><th class="num">Total</th></tr></thead><tbody>
    ${lines.map((l) => html`<tr><td>${l.description}</td><td class="num">${l.days}</td><td class="num">${l.units}</td><td class="num">${l.people}</td><td class="num">${money(l.unit_cost, cur)}</td><td class="num">${money(l.total, cur)}</td></tr>`)}
    </tbody><tfoot><tr><td colspan="5">Total</td><td class="num">${money(r.amount, cur)}</td></tr></tfoot></table></div>`;
  }
  const lines = linesOf(r.id, 'item');
  if (r.type === 'procurement') {
    const q = selectedQuote(r.id);
    return html`<div class="tablewrap"><table><thead><tr><th>Item</th><th class="num">Qty</th>${q && html`<th class="num">Unit</th><th class="num">Amount</th>`}${lines.some((l) => l.condition) && html`<th class="num">Received</th><th>Condition</th>`}</tr></thead><tbody>
    ${lines.map((l) => { const p = q?.prices.find((x) => x.line_id === l.id)?.unit_price ?? 0; return html`<tr><td>${l.description}</td><td class="num">${l.qty} ${l.uom ?? ''}</td>${q && html`<td class="num">${money(p, q.currency)}</td><td class="num">${money(p * l.qty, q.currency)}</td>`}${l.condition && html`<td class="num">${l.received_qty}</td><td>${l.condition}</td>`}</tr>`; })}
    </tbody></table></div>`;
  }
  return html`<div class="tablewrap"><table><thead><tr><th>Line</th><th class="num">Amount</th></tr></thead><tbody>
  ${lines.map((l) => html`<tr><td>${l.description}</td><td class="num">${money(l.total, cur)}</td></tr>`)}
  </tbody><tfoot><tr><td>Total</td><td class="num">${money(r.amount, cur)}</td></tr></tfoot></table></div>`;
}

function printLinks(r) {
  const d = dataOf(r), v = voucherOf(r.id);
  const links = [];
  if (r.type === 'procurement') {
    links.push(['pr', 'Requisition']);
    if (selectedQuote(r.id)) links.push(['analysis', 'Quote analysis']);
    if (d.po_no) links.push(['po', 'Purchase order']);
    if (d.grn_no) links.push(['grn', 'Goods received note']);
  }
  if (r.type === 'advance') links.push(['advance', 'Advance request']);
  if (v) links.push(['pv', 'Payment voucher']);
  if (r.type === 'advance' && linesOf(r.id, 'retirement').length) links.push(['retirement', 'Retirement']);
  links.push(['pack', 'Full audit pack']);
  return links;
}

function evidenceUpload(r, user) {
  if (['sealed', 'rejected', 'legacy'].includes(r.state)) return null;
  return html`<form method="post" action="/r/${r.id}/docs" enctype="multipart/form-data">
    <label>Add a document<input type="file" name="file" accept="image/*,application/pdf" required></label>
    <label>Type<select name="kind">${options([['quote', 'Quote'], ['invoice', 'Invoice'], ['receipt', 'Receipt'], ['delivery_note', 'Delivery note'], ['proof', 'Proof of payment'], ['deposit_slip', 'Deposit slip'], ['tender', 'Tender document'], ['report', 'Activity report'], ['other', 'Other']], r.state === 'closeout' ? 'invoice' : 'quote')}</select></label>
    <button>Upload</button></form>`;
}

export function requestPage(r, user, baseUrl) {
  const d = dataOf(r);
  const v = voucherOf(r.id);
  const docs = docsOf(r.id);
  const flags = flagsFor(r);
  const quotes = r.type === 'procurement' ? quotesOf(r.id) : [];
  return html`<p class="small muted"><a href="/register">Register</a> / ${r.ref}</p>
  <h1>${r.title}</h1>
  <p>${statePill(r)} <span class="muted small">${TYPE_LABEL[r.type]} · ${r.ref}</span> ${r.legacy ? html`<span class="pill plain">From the old spreadsheet</span>` : ''}</p>
  ${tracker(r)}
  ${r.state === 'sealed' && html`<div class="notice ok small"><b>Sealed ${dateTime(r.sealed_at)}.</b> ${sealIntact(r) ? 'The record matches its seal.' : html`<b>Warning: this record no longer matches its seal.</b>`}<div class="mono">${r.seal_hash}</div></div>`}
  ${flagList(flags)}
  <div class="detail"><div>
    ${actionPanel(r, user)}
    <section class="card"><h2>Details</h2>
      <dl class="facts"><dt>Requester</dt><dd>${requesterOf(r).name}</dd><dt>Department</dt><dd>${r.department}</dd><dt>Project</dt><dd>${r.project}</dd>
      ${r.budget_line && html`<dt>Budget line</dt><dd>${r.budget_line}</dd>`}
      <dt>${r.type === 'procurement' && !selectedQuote(r.id) ? 'Expected value' : 'Amount'}</dt><dd>${money(r.amount, r.currency)}${r.currency !== 'ZMW' ? html` <span class="muted small">≈ ${money(r.amount_zmw)} at ${r.rate}</span>` : ''}</dd>
      <dt>In words</dt><dd class="small">${amountInWords(r.amount, r.currency)}</dd>
      ${r.date_needed && html`<dt>Needed by</dt><dd>${dateOnly(r.date_needed)}</dd>`}
      ${d.payee && html`<dt>Pay to</dt><dd>${d.payee}</dd>`}
      ${d.activity_location && html`<dt>Activity</dt><dd>${d.activity_location}, ${dateOnly(d.activity_start)} to ${dateOnly(d.activity_end)}</dd>`}
      ${d.available_budget != null && html`<dt>Budget available</dt><dd>${money(d.available_budget)}</dd>`}
      ${d.donor_requirements && html`<dt>Donor rules</dt><dd>${d.donor_requirements}</dd>`}
      ${r.justification && html`<dt>Why needed</dt><dd>${r.justification}</dd>`}
      ${d.selection_reason && html`<dt>Why this vendor</dt><dd>${d.selection_reason}</dd>`}
      ${d.po_no && html`<dt>PO</dt><dd>${d.po_no}${d.payment_terms ? ` · ${d.payment_terms}` : ''}</dd>`}
      ${d.invoice_no && html`<dt>Invoice</dt><dd>${d.invoice_no}, ${money(d.invoice_amount, r.currency)}</dd>`}
      ${v && html`<dt>Voucher</dt><dd>${v.voucher_no}${v.paid_on ? ` · paid ${dateOnly(v.paid_on)}, ref ${v.reference}` : ' · not paid yet'}</dd>`}
      ${d.amount_as_typed && html`<dt>Typed as</dt><dd>${d.amount_as_typed} on ${d.project_as_typed}</dd>`}
      ${r.type === 'advance' && voucherOf(r.id)?.paid_on && html`<dt>Retirement due</dt><dd>${dateOnly(retirementDue(r))}</dd>`}
      </dl></section>
    <section class="card"><h2>Lines</h2>${lineTable(r)}</section>
    ${quotes.length > 0 && r.state !== 'sourcing' && html`<section class="card"><h2>Quotes</h2>${quoteComparison(r, quotes, false)}</section>`}
    ${r.type === 'advance' && linesOf(r.id, 'retirement').length > 0 && r.state !== 'retirement' && retirementSummaryCard(r)}
  </div>
  <aside>
    ${waitingOn(r, user, baseUrl)}
    <section class="card"><h2>Evidence</h2>
      ${docs.length ? html`<ul class="timeline">${docs.map((x) => html`<li>${x.stored_as ? html`<a href="/docs/${x.id}">${x.filename}</a>` : x.filename} <span class="when">${x.kind.replace('_', ' ')} · ${dateOnly(x.uploaded_at)}</span></li>`)}</ul>` : html`<p class="small muted">Nothing attached.</p>`}
      ${evidenceUpload(r, user)}
    </section>
    <section class="card"><h2>Documents</h2><ul class="timeline">${printLinks(r).map(([k, label]) => html`<li><a href="/r/${r.id}/print/${k}">${label}</a></li>`)}</ul></section>
    <section class="card"><h2>Audit trail</h2><ul class="timeline">${eventsOf(r.id).map((e) => html`<li><b>${e.actor_name}</b> ${e.action === 'approved' && !STAGES[e.stage]?.gate ? 'completed' : e.action}${e.stage ? ` · ${STAGES[e.stage]?.label ?? e.stage}` : ''}${e.detail ? html`<div>${e.detail}</div>` : ''}<span class="when">${dateTime(e.at)}</span></li>`)}</ul></section>
  </aside></div>`;
}

function retirementSummaryCard(r) {
  const sum = retirementSummary(r);
  const d = dataOf(r);
  return html`<section class="card"><h2>Retirement</h2><div class="tablewrap"><table><thead><tr><th>Spent on</th><th>Vendor</th><th>Category</th><th class="num">Amount</th><th>Receipt</th></tr></thead><tbody>
  ${linesOf(r.id, 'retirement').map((l) => html`<tr><td>${l.description}${l.comment ? html`<div class="small muted">${l.comment}</div>` : ''}</td><td>${l.vendor}</td><td>${l.category}</td><td class="num">${money(l.total, r.currency)}</td><td>${l.document_id ? html`<a href="/docs/${l.document_id}">View</a>` : 'None'}</td></tr>`)}
  </tbody></table></div><dl class="facts"><dt>Received</dt><dd>${money(sum.received, r.currency)}</dd><dt>Spent</dt><dd>${money(sum.spent, r.currency)}</dd><dt>Variance</dt><dd><b>${money(sum.variance, r.currency)}</b></dd>
  ${d.settlement && html`<dt>Settled</dt><dd>${d.settlement.mode}, ${d.settlement.reference}</dd>`}</dl></section>`;
}

const ROWS = { expense: 3, advance: 3, procurement: 3 };
export function requestForm(type, { r = null, projects, form = null }) {
  const d = r ? dataOf(r) : {};
  const v = form ?? { ...r, ...d };
  const lines = form?.lines ? Object.values(form.lines) : r ? linesOf(r.id, type === 'advance' ? 'advance' : 'item') : [];
  const blank = Array.from({ length: Math.max(ROWS[type] - lines.length, lines.length ? 0 : ROWS[type]) }, () => ({}));
  const rows = [...lines, ...blank];
  const titleLabel = { expense: 'What is this for?', procurement: 'What are you buying?', advance: 'Description / purpose of the activity' }[type];
  const lineHead = { expense: html`<th>Line</th><th class="num">Amount</th>`, procurement: html`<th>Item or service</th><th>Quantity</th><th>Unit</th>`, advance: html`<th>Line</th><th>Days</th><th>Units</th><th>People</th><th>Unit cost</th><th class="num">Total</th>` }[type];
  const row = (l, i) => ({
    expense: html`<td class="grow" data-label="Line"><input name="lines[${i}][description]" value="${l.description ?? ''}" aria-label="Line description"></td><td data-label="Amount"><input name="lines[${i}][total]" data-f="total" value="${l.total ?? ''}" inputmode="decimal" aria-label="Amount"></td>`,
    procurement: html`<td class="grow" data-label="Item or service"><input name="lines[${i}][description]" value="${l.description ?? ''}" aria-label="Item"></td><td data-label="Quantity"><input name="lines[${i}][qty]" value="${l.qty ?? 1}" data-default="1" inputmode="decimal" aria-label="Quantity"></td><td data-label="Unit"><input name="lines[${i}][uom]" value="${l.uom ?? 'each'}" data-default="each" aria-label="Unit"></td>`,
    advance: html`<td class="grow" data-label="Line"><input name="lines[${i}][description]" value="${l.description ?? ''}" aria-label="Line description"></td>${['days', 'units', 'people'].map((f) => html`<td data-label="${f[0].toUpperCase() + f.slice(1)}"><input name="lines[${i}][${f}]" data-f="${f}" value="${l[f] ?? 1}" data-default="1" inputmode="decimal" aria-label="${f}"></td>`)}<td data-label="Unit cost"><input name="lines[${i}][unit_cost]" data-f="unit_cost" value="${l.unit_cost ?? ''}" inputmode="decimal" aria-label="Unit cost"></td><td class="num" data-label="Total" data-line-total></td>`,
  }[type]);
  const foot = type === 'procurement' ? null : html`<tfoot><tr><td colspan="${type === 'advance' ? 5 : 1}">Total</td><td class="num" data-sum></td><td></td></tr></tfoot>`;
  return html`<h1>${r ? 'Edit' : 'New'} ${TYPE_LABEL[type].toLowerCase()}</h1>
  <form method="post" class="card">
    <label>${titleLabel}<input name="title" value="${v.title ?? ''}" required></label>
    <div class="row">
      <label>Project<select name="project" required><option value="">Choose…</option>${options(projects, v.project)}</select></label>
      <label>Budget line<span class="hint">Finance will confirm this.</span><input name="budget_line" value="${v.budget_line ?? ''}"></label>
      <label>Currency<select name="currency">${options(CURRENCIES, v.currency ?? 'ZMW')}</select></label>
      <label>Needed by<input type="date" name="date_needed" value="${v.date_needed ?? ''}"></label>
      <label>Priority<select name="priority">${options(['High', 'Medium', 'Low'], v.priority ?? 'Medium')}</select></label>
      ${type === 'expense' && html`<label>Pay to<input name="payee" value="${v.payee ?? ''}"></label>`}
      ${type === 'procurement' && html`<label>Expected total value<span class="hint">Sets how many quotes you need.</span><input name="amount" value="${v.amount ?? ''}" inputmode="decimal" required></label>`}
    </div>
    ${type === 'advance' && html`<div class="row"><label>Activity location<input name="activity_location" value="${v.activity_location ?? ''}" required></label>
      <label>Activity starts<input type="date" name="activity_start" value="${v.activity_start ?? ''}" required></label><label>Activity ends<input type="date" name="activity_end" value="${v.activity_end ?? ''}" required></label>
      <label>Pay me by<select name="payment_method">${options(METHODS, v.payment_method ?? 'Mobile Money')}</select></label><label>Mobile number or bank details<input name="mobile_number" value="${v.mobile_number ?? ''}"></label></div>`}
    <label>Why is this needed?<span class="hint">Say what it supports. Requests without a real justification are sent back.</span><textarea name="justification" required>${v.justification ?? ''}</textarea></label>
    ${type === 'procurement' && html`<label>Donor or client requirements<span class="hint">Any limits on this purchase. Leave blank if none.</span><textarea name="donor_requirements" rows="2">${v.donor_requirements ?? ''}</textarea></label>`}
    <h2>Lines</h2>
    <div class="tablewrap"><table id="lines" data-lines="${type}"><thead><tr>${lineHead}<th></th></tr></thead>
      <tbody>${rows.map((l, i) => html`<tr>${row(l, i)}<td class="rm"><button type="button" class="link" data-remove>Remove</button></td></tr>`)}</tbody>${foot}</table></div>
    <div class="actions"><button type="button" data-add-line="#lines">Add line</button></div>
    ${type === 'advance' && html`<label class="check"><input type="checkbox" name="declared" value="1" ${raw(v.declared ? 'checked' : '')} required> I certify these costs are for official business, within budget, and I will retire this advance with original receipts within ${getSettings().retirement_days} working days of the activity ending.</label>`}
    <div class="actions"><button class="primary">Save draft</button></div>
  </form>`;
}


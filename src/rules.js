// Pure money and policy rules. No database, no AI: these must give the same answer every time.

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// A blank is not zero. Anything that is not a clear number comes back as NaN so the caller must refuse it.
export const num = (v) => {
  const text = String(v ?? '').replace(/,/g, '').trim();
  return text === '' ? NaN : Number(text);
};

export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lusaka' }).format(new Date());
}
export const nowIso = () => new Date().toISOString();

export function quoteRule(zmw, s) {
  if (zmw > s.tender_above) return { band: 3, min: 3, tender: true, process: 'Open tender led by the Procurement Team' };
  if (zmw > s.two_quote_max) return { band: 2, min: 3, tender: false, process: 'Minimum of 3 quotations' };
  if (zmw > s.single_quote_max) return { band: 1, min: 2, tender: false, process: 'Minimum of 2 quotations' };
  return { band: 0, min: 1, tender: false, process: 'Single quotation' };
}

export function addWorkingDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

export const advanceLineTotal = (l) => round2(num(l.days) * num(l.units) * num(l.people) * num(l.unit_cost));

// Positive: the payee returns money to the organisation. Negative: the organisation reimburses the payee.
export const retirementVariance = (received, spent) => round2(received - spent);

export function quoteTotals(prices, extra, vat, rate) {
  const subtotal = round2(prices.reduce((s, p) => s + p.qty * p.unit_price, 0));
  const total = round2(subtotal + extra + vat);
  return { subtotal, total, total_zmw: round2(total * rate) };
}

// Three-way match: what we ordered, what arrived, and what the vendor billed.
export function threeWayMatch({ lines, extra, vat, invoiceAmount }) {
  const ordered = round2(lines.reduce((s, l) => s + l.qty * l.unit_price, 0));
  const received = round2(lines.reduce((s, l) => s + acceptedQty(l) * l.unit_price, 0));
  const share = ordered > 0 ? received / ordered : 0;
  const poTotal = round2(ordered + extra + vat);
  const grnValue = round2(received + (extra + vat) * share);
  const issues = [];
  for (const l of lines) {
    if (acceptedQty(l) < l.qty) issues.push(`${l.description}: ordered ${l.qty}, accepted ${acceptedQty(l)}${l.condition ? ` (${l.condition})` : ''}`);
    else if (l.condition && l.condition !== 'Good') issues.push(`${l.description}: received in ${l.condition.toLowerCase()} condition`);
    if ((l.received_qty ?? 0) > l.qty) issues.push(`${l.description}: received ${l.received_qty}, more than the ${l.qty} ordered`);
  }
  if (invoiceAmount == null) issues.push('No invoice amount recorded');
  else if (Math.abs(invoiceAmount - poTotal) > 0.01) issues.push(`Invoice ${fmt(invoiceAmount)} does not equal PO total ${fmt(poTotal)}`);
  return { poTotal, grnValue, invoiceAmount, payable: Math.min(grnValue, invoiceAmount ?? grnValue), matched: issues.length === 0, issues };
}
const acceptedQty = (l) => (l.condition === 'Rejected' ? 0 : Math.min(l.received_qty ?? 0, l.qty));
const fmt = (n) => Number(n).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function under1000(n) {
  const parts = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} hundred`); n %= 100; if (n) parts.push('and'); }
  if (n >= 20) parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(' ');
}
function wholeWords(n) {
  if (n === 0) return 'zero';
  const scales = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  const parts = [];
  for (const [v, name] of scales) {
    if (n >= v) { parts.push(`${under1000(Math.floor(n / v))} ${name}`); n %= v; }
  }
  if (n > 0) parts.push((parts.length && n < 100 ? 'and ' : '') + under1000(n));
  return parts.join(' ');
}
const NAMES = { ZMW: ['Kwacha', 'Ngwee'], USD: ['US Dollars', 'Cents'], EUR: ['Euros', 'Cents'], GBP: ['Pounds', 'Pence'], ZAR: ['Rand', 'Cents'] };
export function amountInWords(amount, currency = 'ZMW') {
  const [major, minor] = NAMES[currency] ?? [currency, 'cents'];
  const whole = Math.floor(round2(amount));
  const cents = Math.round((round2(amount) - whole) * 100);
  const w = wholeWords(whole);
  const text = `${w[0].toUpperCase()}${w.slice(1)} ${major}`;
  return cents ? `${text} and ${wholeWords(cents)} ${minor} only` : `${text} only`;
}

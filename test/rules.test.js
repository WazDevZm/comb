import test from 'node:test';
import assert from 'node:assert/strict';
import { num, quoteRule, amountInWords, addWorkingDays, threeWayMatch, retirementVariance, advanceLineTotal, quoteTotals, round2 } from '../src/rules.js';
import { DEFAULT_SETTINGS as S } from '../src/db.js';

test('quote thresholds have no gaps or overlaps at the band edges', () => {
  assert.equal(quoteRule(10000, S).min, 1);
  assert.equal(quoteRule(10000.01, S).min, 2);
  assert.equal(quoteRule(20000, S).min, 2);
  assert.equal(quoteRule(20000.01, S).min, 3);
  assert.equal(quoteRule(100000, S).tender, false);
  assert.equal(quoteRule(100000.01, S).tender, true);
});

test('amount in words is automatic', () => {
  assert.equal(amountInWords(8829), 'Eight thousand eight hundred and twenty-nine Kwacha only');
  assert.equal(amountInWords(1000.5, 'USD'), 'One thousand US Dollars and fifty Cents only');
  assert.equal(amountInWords(105), 'One hundred and five Kwacha only');
  assert.equal(amountInWords(2000003), 'Two million and three Kwacha only');
});

test('working days skip weekends', () => {
  assert.equal(addWorkingDays('2026-11-06', 1), '2026-11-09'); // Friday to Monday
  assert.equal(addWorkingDays('2026-11-06', 5), '2026-11-13');
});

test('the advance form sample still totals K8,829', () => {
  const lines = [[4, 1, 1, 800], [1, 1, 1, 2989], [1, 1, 2, 600], [1, 1, 1, 350], [1, 2, 1, 100], [1, 2, 1, 20], [1, 1, 1, 850]];
  assert.equal(lines.reduce((s, [days, units, people, unit_cost]) => s + advanceLineTotal({ days, units, people, unit_cost }), 0), 8829);
});

test('retirement variance matches the form: positive is returned', () => {
  assert.equal(retirementVariance(8829, 5432), 3397);
  assert.equal(retirementVariance(100, 150), -50);
});

test('quote totals include extras and VAT and convert currency', () => {
  assert.deepEqual(quoteTotals([{ qty: 2, unit_price: 100.1 }], 10, 5, 22), { subtotal: 200.2, total: 215.2, total_zmw: round2(215.2 * 22) });
});

const po = [{ description: 'Chairs', qty: 10, unit_price: 100, received_qty: 10, condition: 'Good' }];
test('three-way match passes when PO, delivery and invoice agree', () => {
  const m = threeWayMatch({ lines: po, extra: 50, vat: 50, invoiceAmount: 1100 });
  assert.equal(m.matched, true);
  assert.equal(m.payable, 1100);
});
test('partial delivery cannot be paid in full', () => {
  const m = threeWayMatch({ lines: [{ ...po[0], received_qty: 6, condition: 'Partial' }], extra: 0, vat: 0, invoiceAmount: 1000 });
  assert.equal(m.matched, false);
  assert.equal(m.payable, 600);
});
test('rejected goods have no payable value, and over-delivery is not paid extra', () => {
  assert.equal(threeWayMatch({ lines: [{ ...po[0], condition: 'Rejected' }], extra: 0, vat: 0, invoiceAmount: 1000 }).payable, 0);
  const over = threeWayMatch({ lines: [{ ...po[0], received_qty: 12 }], extra: 0, vat: 0, invoiceAmount: 1200 });
  assert.equal(over.matched, false);
  assert.equal(over.payable, 1000);
});
test('damaged goods are flagged even at full quantity', () => {
  assert.equal(threeWayMatch({ lines: [{ ...po[0], condition: 'Damaged' }], extra: 0, vat: 0, invoiceAmount: 1000 }).matched, false);
});
test('an invoice above the PO is flagged', () => {
  const m = threeWayMatch({ lines: po, extra: 0, vat: 0, invoiceAmount: 1500 });
  assert.equal(m.matched, false);
  assert.equal(m.payable, 1000);
});

test('num refuses blanks and text instead of guessing', () => {
  assert.equal(num('1,500.50'), 1500.5);
  assert.ok(Number.isNaN(num('')));
  assert.ok(Number.isNaN(num(undefined)));
  assert.ok(Number.isNaN(num('k11,OOO')));
});

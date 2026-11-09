// Drives the demo in real Chrome: npm run demo, then node scripts/browser-check.mjs [screenshot-dir]
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'data/screens';
mkdirSync(out, { recursive: true });
const base = process.env.BASE ?? 'http://localhost:4300';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const receipt = join(out, `receipt-${Date.now()}.png`);
writeFileSync(receipt, Buffer.concat([png, Buffer.from(String(Date.now()))]));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const problems = [];
async function session(name, viewport = { width: 1280, height: 900 }, opts = {}) {
  const ctx = await browser.newContext({ viewport, ...opts });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
  await page.goto(`${base}/login`);
  await page.selectOption('[name="id"] ', { label: name });
  await page.click('form[action="/demo-login"] button');
  return page;
}
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
const overflow = async (page, label) => {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (wide) problems.push(`horizontal scroll on ${label}`);
};

const fin = await session('Seiko Mwenya (finance)');
await shot(fin, 'home-finance');
await fin.goto(`${base}/advances`); await shot(fin, 'advances');
await fin.goto(`${base}/register?state=legacy&flagged=1`); await shot(fin, 'register-legacy');
await fin.click('text=Venue Hire'); await shot(fin, 'legacy-flag');
await fin.goto(`${base}/reports`); await shot(fin, 'reports');

// A staff member fills in the advance form on a phone.
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const staff = await session('Maumo Mubila (staff)', phone.viewport, phone);
await overflow(staff, 'home phone'); await shot(staff, 'phone-home');
await staff.goto(`${base}/new`); await shot(staff, 'phone-new');
await staff.goto(`${base}/new/advance`);
await staff.fill('[name="title"]', 'Browser test trip to Kafue');
await staff.selectOption('[name="project"]', 'HIVOS');
await staff.fill('[name="activity_location"]', 'Kafue');
await staff.fill('[name="activity_start"]', '2026-11-20');
await staff.fill('[name="activity_end"]', '2026-11-21');
await staff.fill('[name="justification"]', 'Visit to the Kafue partners agreed in the work plan.');
await staff.fill('[name="lines[0][description]"]', 'Fuel');
await staff.fill('[name="lines[0][unit_cost]"]', '1200');
await staff.click('[data-add-line]');
const sum = await staff.textContent('[data-sum]');
if (!sum.includes('1,200.00')) problems.push(`live total showed ${sum}`);
const hidden = await staff.evaluate(() => {
  const el = document.querySelector('[name="lines[0][unit_cost]"]').getBoundingClientRect();
  return el.right > window.innerWidth;
});
if (hidden) problems.push('unit cost is off-screen on a phone');
await staff.check('[name="declared"]');
await overflow(staff, 'advance form phone'); await shot(staff, 'phone-advance-form');
await staff.click('button.primary');
await staff.click('button[value="approve"]');
await staff.waitForURL(/ok=/);
const url = staff.url().split('?')[0];
await overflow(staff, 'request phone'); await shot(staff, 'phone-request');

// Approvals move through three different people.
const dirA = await session('Lukonga Lindunda (director)');
await dirA.goto(url); await shot(dirA, 'approve-manager');
await dirA.click('button[value="approve"]'); await dirA.waitForURL(/ok=/);
await fin.goto(url);
await fin.fill('[name="available_budget"]', '60000'); await fin.fill('[name="budget_line"]', 'Travel');
await fin.click('button[value="approve"]'); await fin.waitForURL(/ok=/);
const dirB = await session('Simunza Muyangana (director)');
await dirB.goto(url); await dirB.click('button[value="approve"]'); await dirB.waitForURL(/ok=/);
await fin.goto(url);
await fin.fill('[name="reference"]', 'BROWSER-1'); await fin.click('button[value="approve"]'); await fin.waitForURL(/ok=/);

await staff.goto(url); await staff.check('[name="ack"]'); await staff.click('button[value="approve"]'); await staff.waitForURL(/ok=/);
await staff.setInputFiles('input[data-scan]', receipt);
await staff.waitForFunction(() => document.querySelector('.scanstatus').textContent.includes('Saved'));
await staff.fill('[name="description"]', 'Fuel for Kafue'); await staff.selectOption('[name="category"]', 'Fuel'); await staff.fill('[name="total"]', '900');
await staff.click('form[action$="/retirement-lines"] button'); await staff.waitForURL(/ok=/);
await overflow(staff, 'retirement phone'); await shot(staff, 'phone-retirement');
await staff.check('[name="certify"]'); await staff.click('form[action$="/act"] button[value="approve"]'); await staff.waitForURL(/ok=/);

await fin.goto(url); await fin.click('button[value="approve"]'); await fin.waitForURL(/ok=/);
await dirA.goto(url); await dirA.click('button[value="approve"]'); await dirA.waitForURL(/ok=/);
await fin.goto(url);
await fin.selectOption('[name="mode"]', 'Bank Deposit'); await fin.fill('[name="reference"]', 'SLIP-1');
await fin.click('button[value="approve"]'); await fin.waitForURL(/ok=/);
await shot(fin, 'sealed');
if (!(await fin.textContent('main')).includes('The record matches its seal')) problems.push('seal message missing');

await fin.goto(`${url}/print/pv`); await shot(fin, 'print-pv');
await fin.goto(`${url}/print/retirement`); await shot(fin, 'print-retirement');
await fin.goto(`${base}/admin`); await shot(fin, 'admin');

await browser.close();
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'Browser check passed: no console errors, no phone overflow, full advance sealed.');

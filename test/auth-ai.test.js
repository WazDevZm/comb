import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { initDb, one } from '../src/db.js';
import { seedReference } from '../src/seed.js';
import { serve } from './helpers.js';
import { readDocument, draftJustification, setClient } from '../src/ai.js';

test('real sign-in: temp password, forced change, then the new password, and no demo door', async () => {
  initDb(':memory:');
  const first = seedReference();
  const s = await serve({ demo: false });
  const post = (path, body, cookie) => fetch(`${s.base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body).toString() });
  assert.notEqual((await post('/demo-login', { id: 1 })).headers.get('set-cookie')?.includes('comb='), true);
  assert.match((await post('/login', { username: first.username, password: 'wrong-password' })).headers.get('location'), /err=/);
  const ok = await post('/login', { username: first.username, password: first.password });
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const home = await fetch(`${s.base}/`, { redirect: 'manual', headers: { cookie } });
  assert.equal(home.headers.get('location'), '/password');
  assert.match((await post('/password', { password: 'short' }, cookie)).headers.get('location'), /err=/);
  await post('/password', { password: 'a-much-longer-password' }, cookie);
  assert.equal((await fetch(`${s.base}/`, { redirect: 'manual', headers: { cookie } })).status, 200);
  assert.match((await post('/login', { username: first.username, password: first.password })).headers.get('location'), /err=/);
  assert.equal((await post('/login', { username: first.username, password: 'a-much-longer-password' })).status, 302);
  for (let i = 0; i < 9; i++) await post('/login', { username: 'lukonga.lindunda', password: 'guess' });
  assert.match(decodeURIComponent((await post('/login', { username: 'lukonga.lindunda', password: 'guess' })).headers.get('location')), /Too many/);
  assert.equal(one(`SELECT COUNT(*) AS n FROM users WHERE pass_hash IS NOT NULL`).n, 1, 'only the finance lead has a password at first');
  s.close();
});

// Runs the real SDK against a fake network, proving the request and parsing without spending anything.
function fakeApi(replyText, stop = 'end_turn') {
  const sent = [];
  const fetchStub = async (_url, init) => {
    sent.push({ headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: replyText }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  setClient(new Anthropic({ apiKey: 'test', fetch: fetchStub, maxRetries: 0 }));
  return sent;
}

test('the real SDK sends a schema-constrained request and parses the reading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comb-ai-'));
  const file = join(dir, 'r.pdf');
  writeFileSync(file, '%PDF-1.4 test');
  const reading = { vendor: 'Puma Lusaka', date: '2026-11-01', document_number: 'R-88', currency: 'ZMW', subtotal: null, vat: 62.07, total: 450, category: 'Fuel', line_items: [{ description: 'Diesel', quantity: 15, unit_price: 30 }], confidence: 'high' };
  const sent = fakeApi(JSON.stringify(reading));
  const out = await readDocument(file, 'application/pdf');
  assert.deepEqual(out, reading);
  const { body, headers } = sent[0];
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.messages[0].content[0].type, 'document');
  assert.match(headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  assert.equal(body.temperature, undefined);
  assert.equal(body.thinking, undefined);
  setClient(null);
});

test('a refusal or unreadable file type is handled without inventing data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comb-ai-'));
  const file = join(dir, 'r.png');
  writeFileSync(file, 'x');
  fakeApi('{}', 'refusal');
  await assert.rejects(readDocument(file, 'image/png')); // The scan route catches this and keeps the upload.
  assert.equal(await readDocument(file, 'image/heic'), null);
  setClient(null);
});

test('the drafted justification is plain text from the supplied quotes', async () => {
  const sent = fakeApi('Vendor A offered the lowest total of the two quotes.');
  const text = await draftJustification({ title: 'Desks', chosen: 'Vendor A', quotes: [{ vendor_name: 'Vendor A', currency: 'ZMW', total: 100, total_zmw: 100 }] });
  assert.match(text, /lowest total/);
  assert.match(sent[0].body.messages[0].content[0].text, /Vendor A: ZMW 100/);
  setClient(null);
});

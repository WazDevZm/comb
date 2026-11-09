import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, one, run } from '../src/db.js';
import { seedReference } from '../src/seed.js';
import { createApp } from '../src/app.js';

export function freshDb() {
  initDb(':memory:');
  seedReference();
  return {
    staff: one(`SELECT * FROM users WHERE name = 'Maumo Mubila'`),
    staff2: one(`SELECT * FROM users WHERE name = 'Mapalo Lukashi'`),
    dirA: one(`SELECT * FROM users WHERE name = 'Lukonga Lindunda'`),
    dirB: one(`SELECT * FROM users WHERE name = 'Simunza Muyangana'`),
    fin: one(`SELECT * FROM users WHERE name = 'Seiko Mwenya'`),
  };
}
export const addVendor = (name, status = 'approved') => run(`INSERT INTO vendors (name, status, added_at) VALUES (?, ?, '2026-01-01')`, name, status).lastInsertRowid;
export const addDoc = (rid, u, kind, sha) => run(`INSERT INTO documents (request_id, kind, filename, stored_as, mime, size, sha256, uploaded_by, uploaded_at) VALUES (?, ?, ?, '', 'application/pdf', 1, ?, ?, '2026-01-01')`, rid, kind, `${kind}.pdf`, sha ?? `${kind}-${rid}-${Math.random()}`, u.id).lastInsertRowid;

export async function serve({ demo = true } = {}) {
  const app = createApp({ uploadDir: mkdtempSync(join(tmpdir(), 'comb-')), demo });
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => server.close() };
}
// A tiny signed-in browser for the HTTP tests.
export async function browser(base, userId) {
  const res = await fetch(`${base}/demo-login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `id=${userId}` });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const go = (path, opts = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...opts, headers: { cookie, ...opts.headers } });
  return {
    get: go,
    post: (path, fields) => go(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }),
    upload: (path, fields, name, bytes, type) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(fields)) f.append(k, v);
      f.append('file', new Blob([bytes], { type }), name);
      return go(path, { method: 'POST', body: f });
    },
  };
}
export const idFrom = (res) => Number(/\/r\/(\d+)/.exec(res.headers.get('location'))[1]);

import express from 'express';
import multer from 'multer';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { one, all, run, tx, getSettings, nextNumber, rateFor, DEFAULT_SETTINGS } from './db.js';
import { round2, num, nowIso, today, advanceLineTotal } from './rules.js';
import { UserError, TYPE_PREFIX, TYPE_LABEL, getRequest, canView, canAct, perform, linesOf, dataOf, logEvent, saveQuote, quotesOf, voucherOf, payeeOf, STAGES } from './workflow.js';
import { checkPassword, hashPassword, createSession, userFromToken, destroySession, tempPassword, tooManyAttempts, noteFailure, clearFailures } from './auth.js';
import { readDocument, draftJustification, aiEnabled } from './ai.js';
import { username } from './seed.js';
import { html, page } from './views/layout.js';
import { requestPage, requestForm } from './views/request.js';
import { loginPage, passwordPage, homePage, newPage, registerPage, registerRows, advancesPage, vendorsPage, reportsPage, adminPage } from './views/pages.js';
import { PRINTS, printPage } from './views/print.js';

const MIME_OK = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'application/pdf']);
const MAX_MB = 15;

export function createApp({ uploadDir, demo = false }) {
  const app = express();
  mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_MB * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, MIME_OK.has(file.mimetype)),
  });

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    });
    next();
  });
  app.use(express.static(resolve(import.meta.dirname, '../public'), { maxAge: 0 }));
  app.use(express.urlencoded({ extended: true, limit: '1mb', parameterLimit: 5000 }));
  app.use(express.json({ limit: '100kb' }));

  const cookieOf = (req) => /(?:^|;\s*)comb=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const setCookie = (req, res, token) => res.append('Set-Cookie', `comb=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${req.secure ? '; Secure' : ''}`);

  // Cross-site form posts are refused. SameSite cookies back this up.
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return res.status(403).send('Cross-site request refused.');
    next();
  });
  app.use((req, res, next) => { req.user = userFromToken(cookieOf(req)); next(); });

  const show = (req, res, title, active, body, status = 200) => res.status(status).send(page({
    user: req.user, title, active, body, demo,
    flash: { ok: req.query.ok, err: res.locals.err ?? req.query.err },
  }));
  const back = (res, url, kind, msg) => res.redirect(`${url}${url.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(msg)}`);
  const need = (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.must_change && !demo && req.path !== '/password') return res.redirect('/password');
    next();
  };
  const senior = (req, res, next) => (req.user.role === 'staff' ? show(req, res, 'Not allowed', '', html`<h1>Finance and directors only</h1>`, 403) : next());
  const finance = (req, res, next) => (req.user.role === 'finance' ? next() : show(req, res, 'Not allowed', '', html`<h1>Finance only</h1>`, 403));
  const loadRequest = (req, res, next) => {
    const r = getRequest(Number(req.params.id));
    if (!r || !canView(req.user, r)) return show(req, res, 'Not found', '', html`<h1>Request not found</h1>`, 404);
    req.r = r;
    next();
  };
  const editable = (r) => !['sealed', 'rejected', 'legacy'].includes(r.state);

  app.get('/login', (req, res) => {
    const people = demo ? all(`SELECT id, name, role FROM users WHERE name IN ('Seiko Mwenya', 'Lukonga Lindunda', 'Simunza Muyangana', 'Maumo Mubila', 'Mapalo Lukashi')`).map((p) => ({ ...p, label: p.role })) : [];
    res.send(page({ title: 'Sign in', body: loginPage({ error: req.query.err, people, demo }) }));
  });
  app.post('/login', (req, res) => {
    const name = String(req.body.username ?? '').trim().toLowerCase();
    const key = `${name}|${req.ip}`;
    if (tooManyAttempts(key)) return back(res, '/login', 'err', 'Too many attempts. Try again in 15 minutes.');
    const u = one('SELECT * FROM users WHERE username = ? AND active = 1', name);
    if (!u || !checkPassword(String(req.body.password ?? ''), u.pass_hash)) {
      noteFailure(key);
      return back(res, '/login', 'err', 'That username or password is not right.');
    }
    clearFailures(key);
    setCookie(req, res, createSession(u.id));
    res.redirect('/');
  });
  if (demo) {
    app.post('/demo-login', (req, res) => {
      setCookie(req, res, createSession(Number(req.body.id)));
      res.redirect('/');
    });
  }
  app.post('/logout', (req, res) => {
    destroySession(cookieOf(req));
    res.append('Set-Cookie', 'comb=; Path=/; Max-Age=0');
    res.redirect('/login');
  });
  app.get('/password', need, (req, res) => show(req, res, 'Password', '', passwordPage(!!req.user.must_change)));
  app.post('/password', need, (req, res) => {
    const pw = String(req.body.password ?? '');
    if (pw.length < 10) return back(res, '/password', 'err', 'Use at least 10 characters.');
    run('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?', hashPassword(pw), req.user.id);
    back(res, '/', 'ok', 'Password saved.');
  });

  app.get('/', need, (req, res) => show(req, res, 'Home', '/', homePage(req.user)));
  app.get('/new', need, (req, res) => show(req, res, 'New request', '/new', newPage()));

  const projectNames = () => all('SELECT name FROM projects WHERE active = 1 ORDER BY name').map((p) => p.name);

  function parseForm(type, b) {
    const title = String(b.title ?? '').trim();
    if (!title) throw new UserError('Add a description.');
    const raw = Object.values(b.lines ?? {}).filter((l) => String(l.description ?? '').trim());
    let lines, amount;
    if (type === 'advance') {
      lines = raw.map((l) => ({ description: l.description.trim(), days: num(l.days), units: num(l.units), people: num(l.people), unit_cost: num(l.unit_cost) }));
      if (lines.some((l) => [l.days, l.units, l.people, l.unit_cost].some((x) => !Number.isFinite(x) || x < 0))) throw new UserError('Days, units, people and unit cost must be numbers.');
      lines.forEach((l) => { l.total = advanceLineTotal(l); });
      amount = round2(lines.reduce((s, l) => s + l.total, 0));
    } else if (type === 'expense') {
      lines = raw.map((l) => ({ description: l.description.trim(), qty: 1, total: num(l.total) }));
      if (lines.some((l) => !Number.isFinite(l.total) || l.total < 0)) throw new UserError('Amounts must be numbers, like 1500 or 1,500.50. Choose the currency separately.');
      amount = round2(lines.reduce((s, l) => s + l.total, 0));
    } else {
      lines = raw.map((l) => ({ description: l.description.trim(), qty: num(l.qty), uom: String(l.uom ?? 'each').trim(), total: 0 }));
      if (lines.some((l) => !Number.isFinite(l.qty) || l.qty <= 0)) throw new UserError('Quantities must be numbers above zero.');
      amount = num(b.amount);
      if (!Number.isFinite(amount) || amount < 0) throw new UserError('The expected value must be a number, like 18000.');
    }
    const data = {};
    for (const k of ['payee', 'activity_location', 'activity_start', 'activity_end', 'payment_method', 'mobile_number', 'donor_requirements']) if (b[k]) data[k] = String(b[k]).trim();
    if (b.declared) data.declared = true;
    if (type === 'advance' && data.activity_start && data.activity_end && data.activity_end < data.activity_start) throw new UserError('The activity cannot end before it starts.');
    return { title, lines, amount, data };
  }

  function writeLines(id, type, lines) {
    const kind = type === 'advance' ? 'advance' : 'item';
    run('DELETE FROM lines WHERE request_id = ? AND kind = ?', id, kind);
    lines.forEach((l, i) => run(`INSERT INTO lines (request_id, kind, pos, description, qty, uom, days, units, people, unit_cost, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, kind, i, l.description, l.qty ?? null, l.uom ?? null, l.days ?? null, l.units ?? null, l.people ?? null, l.unit_cost ?? null, l.total ?? 0));
  }

  const typeOk = (t) => t in TYPE_LABEL;
  app.get('/new/:type', need, (req, res) => {
    if (!typeOk(req.params.type)) return res.redirect('/new');
    show(req, res, 'New request', '/new', requestForm(req.params.type, { projects: projectNames() }));
  });
  app.post('/new/:type', need, (req, res) => {
    const type = req.params.type;
    if (!typeOk(type)) return res.redirect('/new');
    try {
      const f = parseForm(type, req.body);
      const b = req.body;
      const currency = b.currency || 'ZMW';
      const rate = rateFor(currency);
      const id = tx(() => {
        const out = run(`INSERT INTO requests (ref, type, title, requester_id, department, project, budget_line, currency, amount, rate, amount_zmw, justification, priority, date_needed, data, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, nextNumber(TYPE_PREFIX[type], today().slice(0, 4)), type, f.title, req.user.id, req.user.department, b.project || null, b.budget_line || null, currency,
        f.amount, rate, round2(f.amount * rate), String(b.justification ?? '').trim(), b.priority || 'Medium', b.date_needed || null, JSON.stringify(f.data), nowIso());
        writeLines(out.lastInsertRowid, type, f.lines);
        logEvent(out.lastInsertRowid, req.user, 'created', 'draft');
        return out.lastInsertRowid;
      });
      res.redirect(`/r/${id}`);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      res.locals.err = e.message;
      show(req, res, 'New request', '/new', requestForm(type, { projects: projectNames(), form: req.body }), 400);
    }
  });

  app.get('/r/:id', need, loadRequest, (req, res) => show(req, res, req.r.ref, '/register', requestPage(req.r, req.user, `${req.protocol}://${req.get('host')}`)));

  const ownDraft = (req, res, next) => (req.r.state === 'draft' && req.r.requester_id === req.user.id ? next() : back(res, `/r/${req.r.id}`, 'err', 'Only the requester can edit a draft.'));
  app.get('/r/:id/edit', need, loadRequest, ownDraft, (req, res) => show(req, res, 'Edit', '/new', requestForm(req.r.type, { r: req.r, projects: projectNames() })));
  app.post('/r/:id/edit', need, loadRequest, ownDraft, (req, res) => {
    const r = req.r, b = req.body;
    try {
      const f = parseForm(r.type, b);
      const currency = b.currency || 'ZMW', rate = rateFor(currency);
      const data = { ...dataOf(r), ...f.data };
      tx(() => {
        run(`UPDATE requests SET title = ?, project = ?, budget_line = ?, currency = ?, amount = ?, rate = ?, amount_zmw = ?, justification = ?, priority = ?, date_needed = ?, data = ? WHERE id = ?`,
          f.title, b.project || null, b.budget_line || null, currency, f.amount, rate, round2(f.amount * rate), String(b.justification ?? '').trim(), b.priority || 'Medium', b.date_needed || null, JSON.stringify(data), r.id);
        writeLines(r.id, r.type, f.lines);
      });
      back(res, `/r/${r.id}`, 'ok', 'Saved.');
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      res.locals.err = e.message;
      show(req, res, 'Edit', '/new', requestForm(r.type, { r, projects: projectNames(), form: b }), 400);
    }
  });
  app.post('/r/:id/convert', need, loadRequest, ownDraft, (req, res) => {
    const r = req.r;
    if (r.type !== 'expense') return res.redirect(`/r/${r.id}`);
    const ref = nextNumber('PR', today().slice(0, 4));
    run(`UPDATE requests SET type = 'procurement', ref = ? WHERE id = ?`, ref, r.id);
    logEvent(r.id, req.user, 'moved to procurement', 'draft', `Was ${r.ref}`);
    back(res, `/r/${r.id}`, 'ok', 'Moved to procurement.');
  });

  app.post('/r/:id/act', need, loadRequest, (req, res) => {
    const { action, ...input } = req.body;
    try {
      const r = perform(req.user, req.r.id, action ?? 'approve', input);
      back(res, `/r/${r.id}`, 'ok', r.state === 'sealed' ? 'Sealed. This record is now locked.' : `Done. Now at: ${STAGES[r.state].label}.`);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      back(res, `/r/${req.r.id}`, 'err', e.message);
    }
  });

  function storeFile(r, user, file, kind) {
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const stored = `${r.id}-${randomBytes(8).toString('hex')}${extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`;
    writeFileSync(join(uploadDir, stored), file.buffer);
    const id = run(`INSERT INTO documents (request_id, kind, filename, stored_as, mime, size, sha256, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id, kind, file.originalname.slice(0, 200), stored, file.mimetype, file.size, sha256, user.id, nowIso()).lastInsertRowid;
    logEvent(r.id, user, 'uploaded', null, `${kind}: ${file.originalname.slice(0, 200)}`);
    return { id, sha256 };
  }
  const KINDS = new Set(['quote', 'invoice', 'receipt', 'delivery_note', 'proof', 'deposit_slip', 'tender', 'report', 'other']);
  const receive = (field) => (req, res, next) => upload.single(field)(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `Files must be under ${MAX_MB}MB.` : 'That file could not be uploaded.';
    if (req.path.endsWith('/scan')) return res.status(400).json({ error: msg });
    back(res, `/r/${req.params.id}`, 'err', msg);
  });

  app.post('/r/:id/docs', need, loadRequest, receive('file'), (req, res) => {
    if (!req.file) return back(res, `/r/${req.r.id}`, 'err', 'Upload a photo or PDF.');
    if (!editable(req.r)) return back(res, `/r/${req.r.id}`, 'err', 'This record is closed.');
    storeFile(req.r, req.user, req.file, KINDS.has(req.body.kind) ? req.body.kind : 'other');
    back(res, `/r/${req.r.id}`, 'ok', 'Uploaded.');
  });

  app.post('/r/:id/scan', need, loadRequest, receive('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Upload a photo or PDF.' });
    if (!editable(req.r)) return res.status(400).json({ error: 'This record is closed.' });
    const { id, sha256 } = storeFile(req.r, req.user, req.file, KINDS.has(req.body.kind) ? req.body.kind : 'other');
    const twin = one('SELECT r.ref FROM documents x JOIN requests r ON r.id = x.request_id WHERE x.sha256 = ? AND x.request_id != ? LIMIT 1', sha256, req.r.id);
    const warnings = twin ? [`This exact file was already used on ${twin.ref}.`] : [];
    let read = null;
    try {
      const doc = one('SELECT * FROM documents WHERE id = ?', id);
      read = await readDocument(join(uploadDir, doc.stored_as), doc.mime);
      if (read) {
        run('UPDATE documents SET extracted = ? WHERE id = ?', JSON.stringify(read), id);
        logEvent(req.r.id, null, 'AI read document', null, `${doc.filename}, ${read.confidence} confidence. A person must confirm the figures.`);
      }
    } catch (e) {
      console.error('Document reading failed:', e.message);
    }
    res.json({ document_id: id, read, ai: aiEnabled(), warnings });
  });

  app.get('/docs/:id', need, (req, res) => {
    const d = one('SELECT * FROM documents WHERE id = ?', Number(req.params.id));
    const r = d && getRequest(d.request_id);
    if (!r || !canView(req.user, r) || !d.stored_as) return show(req, res, 'Not found', '', html`<h1>Document not found</h1>`, 404);
    const path = join(uploadDir, d.stored_as);
    if (!existsSync(path)) return show(req, res, 'Not found', '', html`<h1>File missing from storage</h1>`, 404);
    res.set({ 'Content-Type': d.mime, 'Content-Disposition': `inline; filename="${encodeURIComponent(d.filename)}"`, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
    res.send(readFileSync(path));
  });

  const mustBeStage = (stage) => (req, res, next) => (req.r.state === stage && canAct(req.user, req.r) ? next() : back(res, `/r/${req.r.id}`, 'err', 'This step is not open.'));
  const quoteDocOk = (r, id) => !id || one('SELECT 1 AS x FROM documents WHERE id = ? AND request_id = ?', Number(id), r.id);

  app.post('/r/:id/quotes', need, loadRequest, mustBeStage('sourcing'), (req, res) => {
    try {
      if (!one('SELECT 1 AS x FROM vendors WHERE id = ?', Number(req.body.vendor_id))) throw new UserError('Choose a vendor.');
      if (quotesOf(req.r.id).some((q) => q.vendor_id === Number(req.body.vendor_id))) throw new UserError('That vendor already has a quote here. Quotes must come from different vendors.');
      if (!quoteDocOk(req.r, req.body.document_id)) throw new UserError('That document belongs to another request.');
      saveQuote(req.r, req.body);
      logEvent(req.r.id, req.user, 'added quote', 'sourcing');
      back(res, `/r/${req.r.id}`, 'ok', 'Quote saved.');
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      back(res, `/r/${req.r.id}`, 'err', e.message);
    }
  });
  app.post('/r/:id/draft-reason', need, loadRequest, mustBeStage('sourcing'), async (req, res) => {
    const quotes = quotesOf(req.r.id);
    const chosen = quotes.find((q) => q.id === Number(req.body.quote));
    if (!chosen) return res.status(400).json({ error: 'Choose a vendor first.' });
    try {
      res.json({ text: await draftJustification({ title: req.r.title, quotes, chosen: chosen.vendor_name }) });
    } catch (e) {
      console.error('Draft failed:', e.message);
      res.status(502).json({ error: 'AI is not available right now. Write this one by hand.' });
    }
  });

  app.post('/r/:id/retirement-lines', need, loadRequest, mustBeStage('retirement'), (req, res) => {
    const b = req.body, r = req.r;
    const total = num(b.total);
    if (!String(b.description ?? '').trim()) return back(res, `/r/${r.id}`, 'err', 'Say what this was for.');
    if (!Number.isFinite(total) || total < 0) return back(res, `/r/${r.id}`, 'err', 'The amount must be a number.');
    if (!quoteDocOk(r, b.document_id)) return back(res, `/r/${r.id}`, 'err', 'That document belongs to another request.');
    const pos = linesOf(r.id, 'retirement').length;
    run(`INSERT INTO lines (request_id, kind, pos, description, total, spent_on, vendor, receipt_no, category, comment, document_id) VALUES (?, 'retirement', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id, pos, String(b.description).trim(), round2(total), b.spent_on || null, b.vendor || null, b.receipt_no || null, b.category || 'Other', b.comment || null, b.document_id ? Number(b.document_id) : null);
    back(res, `/r/${r.id}`, 'ok', 'Line added.');
  });
  app.post('/r/:id/retirement-lines/:line/delete', need, loadRequest, mustBeStage('retirement'), (req, res) => {
    run(`DELETE FROM lines WHERE id = ? AND request_id = ? AND kind = 'retirement'`, Number(req.params.line), req.r.id);
    res.redirect(`/r/${req.r.id}`);
  });

  app.get('/r/:id/print/:doc', need, loadRequest, (req, res) => {
    const fn = Object.hasOwn(PRINTS, req.params.doc) ? PRINTS[req.params.doc] : null;
    if (!fn) return res.redirect(`/r/${req.r.id}`);
    try {
      res.send(printPage(req.r.ref, fn(req.r)));
    } catch {
      back(res, `/r/${req.r.id}`, 'err', 'That document is not ready yet.');
    }
  });

  app.get('/register', need, (req, res) => show(req, res, 'Register', '/register', registerPage(req.user, req.query)));

  const csvCell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // Stops spreadsheets running a cell as a formula.
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const sendCsv = (res, name, rows) => res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` }).send(`﻿${csv(rows)}`);

  app.get('/register.csv', need, (req, res) => {
    const rows = registerRows(req.user, req.query);
    sendCsv(res, 'comb-register.csv', [['Ref', 'Type', 'Title', 'Requester', 'Department', 'Project', 'Budget line', 'Currency', 'Amount', 'ZMW equivalent', 'Stage', 'Needed by'],
      ...rows.map((r) => [r.ref, TYPE_LABEL[r.type], r.title, r.requester_name, r.department, r.project, r.budget_line, r.currency, r.amount, r.amount_zmw, STAGES[r.state]?.label, r.date_needed])]);
  });

  app.get('/advances', need, senior, (req, res) => show(req, res, 'Advances', '/advances', advancesPage()));
  app.get('/reports', need, senior, (req, res) => show(req, res, 'Reports', '/reports', reportsPage()));

  // Bills for Xero's CSV import. Comb does not write to Xero: finance imports and reconciles there.
  app.get('/export/xero.csv', need, finance, (req, res) => {
    const rows = all(`SELECT r.*, v.voucher_no, v.payee, v.amount AS paid, v.paid_on FROM requests r JOIN vouchers v ON v.request_id = r.id
      WHERE v.paid_on IS NOT NULL AND r.type != 'advance' AND r.xero_exported_at IS NULL ORDER BY v.id`);
    const header = ['*ContactName', '*InvoiceNumber', '*InvoiceDate', '*DueDate', 'Description', '*Quantity', '*UnitAmount', '*AccountCode', '*TaxType', 'TrackingName1', 'TrackingOption1', 'Currency'];
    const body = rows.map((r) => {
      const line = one('SELECT account_code FROM budget_lines WHERE project = ? AND name = ?', r.project, r.budget_line);
      return [r.payee, dataOf(r).invoice_no ?? r.voucher_no, r.paid_on, r.paid_on, `${r.title} (${r.ref})`, 1, r.paid, line?.account_code ?? '', 'Tax Exempt', 'Project', r.project, r.currency];
    });
    tx(() => { for (const r of rows) { run('UPDATE requests SET xero_exported_at = ? WHERE id = ?', nowIso(), r.id); logEvent(r.id, req.user, 'exported to Xero CSV'); } });
    sendCsv(res, `comb-xero-bills-${today()}.csv`, [header, ...body]);
  });

  app.get('/vendors', need, (req, res) => show(req, res, 'Vendors', '/vendors', vendorsPage(req.user)));
  app.post('/vendors', need, (req, res) => {
    const b = req.body, name = String(b.name ?? '').trim();
    if (!name) return back(res, '/vendors', 'err', 'Add the vendor name.');
    if (one('SELECT 1 AS x FROM vendors WHERE lower(name) = lower(?)', name)) return back(res, '/vendors', 'err', 'That vendor is already listed.');
    run('INSERT INTO vendors (name, contact, address, tpin, bank_details, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)', name, b.contact || null, b.address || null, b.tpin || null, b.bank_details || null, req.user.id, nowIso());
    back(res, '/vendors', 'ok', 'Vendor added. Finance needs to approve it.');
  });
  app.post('/vendors/:id/status', need, finance, (req, res) => {
    if (!['pending', 'approved', 'blocked'].includes(req.body.status)) return res.redirect('/vendors');
    run('UPDATE vendors SET status = ? WHERE id = ?', req.body.status, Number(req.params.id));
    back(res, '/vendors', 'ok', 'Vendor updated.');
  });

  app.get('/admin', need, finance, (req, res) => show(req, res, 'Admin', '/admin', adminPage(null)));
  app.post('/admin/settings', need, finance, (req, res) => {
    const b = req.body;
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      const v = k === 'block_advance_if_overdue' ? (b[k] ? 1 : 0) : num(b[k]);
      if (!Number.isFinite(v) || v < 0) return back(res, '/admin', 'err', `${k} must be a number.`);
      run('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
    }
    const s = getSettings();
    if (!(s.single_quote_max < s.two_quote_max && s.two_quote_max < s.tender_above)) return back(res, '/admin', 'err', 'Thresholds must increase. Check them.');
    back(res, '/admin', 'ok', 'Rules saved.');
  });
  app.post('/admin/rates', need, finance, (req, res) => {
    for (const [c, v] of Object.entries(req.body.rate ?? {})) {
      const n = num(v);
      if (!Number.isFinite(n) || n <= 0) return back(res, '/admin', 'err', `The ${c} rate must be above zero.`);
      run('UPDATE rates SET to_zmw = ?, confirmed = 1, updated_at = ? WHERE currency = ?', n, nowIso(), c);
    }
    back(res, '/admin', 'ok', 'Rates confirmed.');
  });
  app.post('/admin/departments', need, finance, (req, res) => {
    for (const [d, id] of Object.entries(req.body.lead ?? {})) run('UPDATE departments SET lead_id = ? WHERE name = ?', id ? Number(id) : null, d);
    back(res, '/admin', 'ok', 'Leads saved.');
  });
  app.post('/admin/budget-lines', need, finance, (req, res) => {
    const b = req.body;
    const budget = b.budget_zmw ? num(b.budget_zmw) : null;
    if (budget !== null && !Number.isFinite(budget)) return back(res, '/admin', 'err', 'The budget must be a number.');
    run(`INSERT INTO budget_lines (project, name, account_code, budget_zmw) VALUES (?, ?, ?, ?) ON CONFLICT(project, name) DO UPDATE SET account_code = excluded.account_code, budget_zmw = excluded.budget_zmw`, b.project, String(b.name).trim(), b.account_code || null, budget);
    back(res, '/admin', 'ok', 'Budget line saved.');
  });
  app.post('/admin/projects', need, finance, (req, res) => {
    run('INSERT INTO projects (name) VALUES (?) ON CONFLICT(name) DO NOTHING', String(req.body.name).trim());
    back(res, '/admin', 'ok', 'Project added.');
  });
  app.post('/admin/users', need, finance, (req, res) => {
    const name = String(req.body.name ?? '').trim();
    if (!name) return back(res, '/admin', 'err', 'Add a name.');
    const pw = tempPassword();
    try {
      run('INSERT INTO users (name, username, department, pass_hash) VALUES (?, ?, ?, ?)', name, username(name), req.body.department, hashPassword(pw));
    } catch {
      return back(res, '/admin', 'err', 'That username is already taken.');
    }
    show(req, res, 'Admin', '/admin', adminPage({ name, password: pw }));
  });
  app.post('/admin/users/:id', need, finance, (req, res) => {
    if (!['staff', 'finance', 'director'].includes(req.body.role)) return res.redirect('/admin');
    if (Number(req.params.id) === req.user.id && req.body.role !== 'finance') return back(res, '/admin', 'err', 'You cannot change your own role.');
    run('UPDATE users SET role = ? WHERE id = ?', req.body.role, Number(req.params.id));
    back(res, '/admin', 'ok', 'Role saved.');
  });
  app.post('/admin/users/:id/reset', need, finance, (req, res) => {
    const u = one('SELECT * FROM users WHERE id = ?', Number(req.params.id));
    if (!u) return res.redirect('/admin');
    const pw = tempPassword();
    run('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?', hashPassword(pw), u.id);
    run('DELETE FROM sessions WHERE user_id = ?', u.id);
    show(req, res, 'Admin', '/admin', adminPage({ name: u.name, password: pw }));
  });

  app.use((req, res) => (req.user ? show(req, res, 'Not found', '', html`<h1>Page not found</h1>`, 404) : res.redirect('/login')));
  app.use((err, req, res, _next) => {
    console.error(err);
    if (err instanceof UserError) return res.status(400).send(err.message);
    res.status(500).send('Something went wrong. Nothing was saved. Try again, and tell finance if it keeps happening.');
  });
  return app;
}

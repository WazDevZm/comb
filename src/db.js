import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL,
  department TEXT, role TEXT NOT NULL DEFAULT 'staff', -- staff | finance | director
  pass_hash TEXT, must_change INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS departments (name TEXT PRIMARY KEY, lead_id INTEGER REFERENCES users(id));
CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS budget_lines (
  id INTEGER PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL,
  account_code TEXT, budget_zmw REAL, UNIQUE(project, name)
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rates (currency TEXT PRIMARY KEY, to_zmw REAL NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, type TEXT NOT NULL, -- expense | procurement | advance
  title TEXT NOT NULL, requester_id INTEGER NOT NULL REFERENCES users(id), department TEXT,
  project TEXT, budget_line TEXT, currency TEXT NOT NULL DEFAULT 'ZMW',
  amount REAL NOT NULL DEFAULT 0, rate REAL NOT NULL DEFAULT 1, amount_zmw REAL NOT NULL DEFAULT 0,
  justification TEXT, priority TEXT NOT NULL DEFAULT 'Medium', date_needed TEXT,
  state TEXT NOT NULL DEFAULT 'draft', data TEXT NOT NULL DEFAULT '{}',
  legacy INTEGER NOT NULL DEFAULT 0, demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, submitted_at TEXT, sealed_at TEXT, seal_hash TEXT, xero_exported_at TEXT
);
CREATE TABLE IF NOT EXISTS lines (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id),
  kind TEXT NOT NULL, -- item | advance | retirement
  pos INTEGER NOT NULL, description TEXT NOT NULL, qty REAL, uom TEXT,
  days REAL, units REAL, people REAL, unit_cost REAL, total REAL NOT NULL DEFAULT 0,
  spent_on TEXT, vendor TEXT, receipt_no TEXT, category TEXT, comment TEXT,
  document_id INTEGER, received_qty REAL, condition TEXT
);
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, contact TEXT, address TEXT, tpin TEXT,
  bank_details TEXT, status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | blocked
  added_by INTEGER REFERENCES users(id), added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id), quote_date TEXT, reference TEXT, validity TEXT,
  currency TEXT NOT NULL DEFAULT 'ZMW', rate REAL NOT NULL DEFAULT 1, extra REAL NOT NULL DEFAULT 0, vat REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, total_zmw REAL NOT NULL DEFAULT 0,
  document_id INTEGER, selected INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quote_prices (
  quote_id INTEGER NOT NULL REFERENCES quotes(id), line_id INTEGER NOT NULL REFERENCES lines(id),
  unit_price REAL NOT NULL DEFAULT 0, PRIMARY KEY (quote_id, line_id)
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id),
  kind TEXT NOT NULL, filename TEXT NOT NULL, stored_as TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, extracted TEXT, uploaded_by INTEGER NOT NULL REFERENCES users(id), uploaded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY, request_id INTEGER UNIQUE NOT NULL REFERENCES requests(id), voucher_no TEXT UNIQUE NOT NULL,
  amount REAL NOT NULL, currency TEXT NOT NULL, payee TEXT NOT NULL, created_at TEXT NOT NULL,
  paid_on TEXT, method TEXT, mobile_network TEXT, account_details TEXT, reference TEXT,
  ack_by INTEGER REFERENCES users(id), ack_at TEXT
);
-- The audit trail is append-only. Nobody edits history, including admins using the app.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id), actor_id INTEGER, actor_name TEXT NOT NULL,
  action TEXT NOT NULL, stage TEXT, detail TEXT, at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'audit trail is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'audit trail is append-only'); END;
-- Sealed records are locked at database level. Only the Xero export stamp may change afterwards.
CREATE TRIGGER IF NOT EXISTS sealed_request BEFORE UPDATE ON requests
  WHEN OLD.state = 'sealed' AND (NEW.amount IS NOT OLD.amount OR NEW.state IS NOT OLD.state OR NEW.title IS NOT OLD.title
    OR NEW.data IS NOT OLD.data OR NEW.seal_hash IS NOT OLD.seal_hash OR NEW.project IS NOT OLD.project OR NEW.budget_line IS NOT OLD.budget_line)
  BEGIN SELECT RAISE(ABORT, 'record is sealed'); END;
CREATE TRIGGER IF NOT EXISTS sealed_request_del BEFORE DELETE ON requests WHEN OLD.state = 'sealed' BEGIN SELECT RAISE(ABORT, 'record is sealed'); END;
CREATE TRIGGER IF NOT EXISTS sealed_lines_u BEFORE UPDATE ON lines WHEN (SELECT state FROM requests WHERE id = OLD.request_id) = 'sealed' BEGIN SELECT RAISE(ABORT, 'record is sealed'); END;
CREATE TRIGGER IF NOT EXISTS sealed_lines_d BEFORE DELETE ON lines WHEN (SELECT state FROM requests WHERE id = OLD.request_id) = 'sealed' BEGIN SELECT RAISE(ABORT, 'record is sealed'); END;
CREATE TRIGGER IF NOT EXISTS sealed_lines_i BEFORE INSERT ON lines WHEN (SELECT state FROM requests WHERE id = NEW.request_id) = 'sealed' BEGIN SELECT RAISE(ABORT, 'record is sealed'); END;
CREATE TRIGGER IF NOT EXISTS sealed_vouchers BEFORE UPDATE ON vouchers WHEN (SELECT state FROM requests WHERE id = OLD.request_id) = 'sealed' BEGIN SELECT RAISE(ABORT, 'record is sealed'); END;
CREATE TRIGGER IF NOT EXISTS sealed_docs BEFORE DELETE ON documents WHEN (SELECT state FROM requests WHERE id = OLD.request_id) = 'sealed' BEGIN SELECT RAISE(ABORT, 'record is sealed'); END;
CREATE TRIGGER IF NOT EXISTS sealed_docs_i BEFORE INSERT ON documents WHEN (SELECT state FROM requests WHERE id = NEW.request_id) = 'sealed' BEGIN SELECT RAISE(ABORT, 'record is sealed'); END;

CREATE INDEX IF NOT EXISTS idx_req_state ON requests(state);
CREATE INDEX IF NOT EXISTS idx_req_user ON requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_lines_req ON lines(request_id, kind);
CREATE INDEX IF NOT EXISTS idx_events_req ON events(request_id);
CREATE INDEX IF NOT EXISTS idx_docs_sha ON documents(sha256);
`;

export function initDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

export function nextNumber(prefix, year) {
  const k = `${prefix}-${year}`;
  run('INSERT INTO counters (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1', k);
  const { n } = one('SELECT n FROM counters WHERE k = ?', k);
  return `${k}-${String(n).padStart(4, '0')}`;
}

export function getSettings() {
  const s = { ...DEFAULT_SETTINGS };
  for (const { k, v } of all('SELECT k, v FROM settings')) s[k] = Number.isNaN(Number(v)) ? v : Number(v);
  return s;
}

// Defaults come from the forms. Where the forms disagree, finance must confirm: see README "Decisions".
export const DEFAULT_SETTINGS = {
  single_quote_max: 10000,     // up to this: 1 quote
  two_quote_max: 20000,        // up to this: 2 quotes, above: 3
  tender_above: 100000,        // above this: open tender
  expense_limit: 10000,        // expenses above this must go through procurement
  retirement_days: 5,          // Advance Request says 5 working days, Payment Voucher says 7
  split_window_days: 14,
  block_advance_if_overdue: 1,
};

export const CURRENCIES = ['ZMW', 'USD', 'EUR', 'GBP', 'ZAR'];
export function rateFor(currency) {
  if (currency === 'ZMW') return 1;
  const r = one('SELECT to_zmw FROM rates WHERE currency = ?', currency);
  return r ? r.to_zmw : 1;
}

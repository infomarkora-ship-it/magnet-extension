const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, tz TEXT NOT NULL DEFAULT 'America/New_York',
  offer TEXT NOT NULL DEFAULT '', tone TEXT NOT NULL DEFAULT 'friendly, short, casual', booking_link TEXT NOT NULL DEFAULT '',
  opener_template TEXT NOT NULL DEFAULT '', followups TEXT NOT NULL DEFAULT '[]',
  auto_reply INTEGER NOT NULL DEFAULT 0, auto_approve_pass INTEGER NOT NULL DEFAULT 0, auto_reject_no INTEGER NOT NULL DEFAULT 1,
  daily_cap INTEGER NOT NULL DEFAULT 20, send_start INTEGER NOT NULL DEFAULT 9, send_end INTEGER NOT NULL DEFAULT 20,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('sender','finder')), label TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id), ig_username TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  ig_age TEXT NOT NULL DEFAULT 'young', state TEXT NOT NULL DEFAULT 'active', reason TEXT NOT NULL DEFAULT '',
  cooldown_until INTEGER NOT NULL DEFAULT 0, warm_started_at INTEGER NOT NULL, profiles_per_day INTEGER NOT NULL DEFAULT 40,
  daily_cap_override INTEGER, last_seen_at INTEGER, last_version TEXT, last_mode TEXT, logged_in_as TEXT,
  replaced_by INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_acc ON events(account_id, at);
CREATE TABLE IF NOT EXISTS lead_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id), name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', include TEXT NOT NULL DEFAULT '[]', include_mode TEXT NOT NULL DEFAULT 'any',
  exclude TEXT NOT NULL DEFAULT '[]', account_types TEXT NOT NULL DEFAULT '[]', min_followers INTEGER NOT NULL DEFAULT 0,
  max_followers INTEGER NOT NULL DEFAULT 0, active_within_days INTEGER NOT NULL DEFAULT 0, regions TEXT NOT NULL DEFAULT '[]',
  require_contact INTEGER NOT NULL DEFAULT 0, public_only INTEGER NOT NULL DEFAULT 1, borderline TEXT NOT NULL DEFAULT 'haiku',
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_type_id INTEGER REFERENCES lead_types(id), kind TEXT NOT NULL, ref TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'peers', enabled INTEGER NOT NULL DEFAULT 1,
  pause_reason TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'server', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER REFERENCES clients(id), lead_type_id INTEGER REFERENCES lead_types(id),
  lead_type_name TEXT NOT NULL DEFAULT '', lead_type_desc TEXT NOT NULL DEFAULT '', lead_regions TEXT NOT NULL DEFAULT '[]', source_id INTEGER REFERENCES sources(id), finder_account_id INTEGER, sender_account_id INTEGER,
  username TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
  followers INTEGER, following INTEGER, posts INTEGER, is_business INTEGER, external_url TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', last_post_at INTEGER, captions TEXT NOT NULL DEFAULT '[]',
  surfaced_by TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL DEFAULT 'pass', needs_haiku INTEGER NOT NULL DEFAULT 0,
  rules_score INTEGER NOT NULL DEFAULT 0, reasons TEXT NOT NULL DEFAULT '[]',
  haiku_status TEXT NOT NULL DEFAULT 'none', haiku_fit TEXT NOT NULL DEFAULT '', haiku_score INTEGER, haiku_reason TEXT NOT NULL DEFAULT '',
  review TEXT NOT NULL DEFAULT 'pending', review_reason TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT 'new',
  opener TEXT NOT NULL DEFAULT '', opener_edited INTEGER NOT NULL DEFAULT 0, contact TEXT NOT NULL DEFAULT '{}',
  enrich_status TEXT NOT NULL DEFAULT 'none', thread_ig TEXT NOT NULL DEFAULT '', follow_step INTEGER NOT NULL DEFAULT 0,
  next_follow_at INTEGER, last_activity_at INTEGER, last_inbound_ts INTEGER NOT NULL DEFAULT 0,
  no_followup INTEGER NOT NULL DEFAULT 0, needs_human INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
  reviewed_at INTEGER, booked_at INTEGER,
  found_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS leads_uq ON leads(IFNULL(client_id, 0), username);
CREATE INDEX IF NOT EXISTS leads_client ON leads(client_id, review, stage);
CREATE INDEX IF NOT EXISTS leads_found ON leads(found_at);
CREATE TABLE IF NOT EXISTS claims (username TEXT PRIMARY KEY, client_id INTEGER NOT NULL, claimed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, direction TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL,
  UNIQUE (lead_id, direction, ts, text));
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, client_id INTEGER, lead_id INTEGER, type TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
  not_before INTEGER NOT NULL DEFAULT 0, inbound_at INTEGER, tries INTEGER NOT NULL DEFAULT 0, result_code TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, done_at INTEGER);
CREATE INDEX IF NOT EXISTS tasks_acc ON tasks(account_id, status, not_before);
CREATE INDEX IF NOT EXISTS tasks_lead ON tasks(lead_id, status);
CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0);
`;

function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  raw.exec(SCHEMA);
  const cache = new Map();
  const st = (sql) => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); cache.set(sql, s); } return s; };
  const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
  const db = {
    raw,
    get: (sql, ...p) => st(sql).get(...norm(p)),
    all: (sql, ...p) => st(sql).all(...norm(p)),
    run: (sql, ...p) => { const r = st(sql).run(...norm(p)); return { changes: Number(r.changes), id: Number(r.lastInsertRowid) }; },
    tx(fn) { raw.exec("BEGIN"); try { const r = fn(); raw.exec("COMMIT"); return r; } catch (e) { raw.exec("ROLLBACK"); throw e; } },
    setting(key, def = null) { const r = db.get("SELECT value FROM settings WHERE key = ?", key); if (!r) return def; try { return JSON.parse(r.value); } catch { return def; } },
    setSetting(key, value) { db.run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value)); },
    close() { raw.close(); }
  };
  return db;
}
module.exports = { openDb };

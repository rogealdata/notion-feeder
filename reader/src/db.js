import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL CHECK (kind IN ('article', 'pdf', 'epub')),
  title          TEXT NOT NULL,
  author         TEXT,
  site_name      TEXT,
  url            TEXT,
  excerpt        TEXT,
  content_html   TEXT,
  word_count     INTEGER,
  file_name      TEXT,
  original_name  TEXT,
  size           INTEGER,
  status         TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox', 'later', 'archive')),
  favorite       INTEGER NOT NULL DEFAULT 0,
  progress       REAL NOT NULL DEFAULT 0,
  location       TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_opened_at TEXT
);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  PRIMARY KEY (document_id, tag)
);

CREATE TABLE IF NOT EXISTS highlights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  note        TEXT,
  color       TEXT NOT NULL DEFAULT 'yellow',
  anchor      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status, created_at);
CREATE INDEX IF NOT EXISTS idx_highlights_document ON highlights(document_id);
`;

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

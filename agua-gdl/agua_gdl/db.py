import json
import sqlite3
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  canonical_url TEXT UNIQUE,
  source_id TEXT, source_name TEXT, scope TEXT,
  title TEXT, summary TEXT, published TEXT, text TEXT,
  partial INTEGER DEFAULT 0,
  status TEXT DEFAULT 'nuevo',   -- nuevo | descargado | error | duplicado
  error TEXT,
  discovery TEXT,
  found_at TEXT
);
CREATE TABLE IF NOT EXISTS analysis (
  article_id INTEGER PRIMARY KEY REFERENCES articles(id),
  relevant INTEGER, rel_score REAL,
  stance TEXT, confidence REAL, crit_score REAL, favor_score REAL,
  strategy_score REAL, covers_strategy INTEGER,
  themes TEXT, evidence TEXT, targets TEXT, voices TEXT,
  manual INTEGER DEFAULT 0
);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class DB:
    def __init__(self, path):
        self.con = sqlite3.connect(path)
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA)

    def add_candidate(self, url, canonical, source, title, summary, published, discovery):
        cur = self.con.execute(
            "INSERT OR IGNORE INTO articles (url, canonical_url, source_id, source_name, scope, title, summary,"
            " published, discovery, found_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (url, canonical, source["id"], source["name"], source["scope"], title, summary, published, discovery, now()),
        )
        self.con.commit()
        return cur.rowcount == 1

    def pending(self):
        return self.con.execute("SELECT * FROM articles WHERE status='nuevo'").fetchall()

    def set_resolved(self, art_id, url, canonical):
        """Actualiza la URL tras resolver un enlace de Google Noticias; marca duplicado si ya existía."""
        try:
            self.con.execute("UPDATE articles SET url=?, canonical_url=? WHERE id=?", (url, canonical, art_id))
        except sqlite3.IntegrityError:
            self.con.execute("UPDATE articles SET status='duplicado' WHERE id=?", (art_id,))
            self.con.commit()
            return False
        self.con.commit()
        return True

    def save_download(self, art_id, title, published, text, partial):
        self.con.execute(
            "UPDATE articles SET title=COALESCE(NULLIF(?, ''), title), published=COALESCE(NULLIF(?, ''), published),"
            " text=?, partial=?, status='descargado', error=NULL WHERE id=?",
            (title, published, text, int(partial), art_id),
        )
        self.con.commit()

    def save_error(self, art_id, msg):
        self.con.execute("UPDATE articles SET status='error', error=? WHERE id=?", (msg[:300], art_id))
        self.con.commit()

    def mark_duplicate(self, art_id):
        self.con.execute("UPDATE articles SET status='duplicado' WHERE id=?", (art_id,))
        self.con.commit()

    def to_analyze(self):
        return self.con.execute(
            "SELECT * FROM articles WHERE status IN ('descargado','nuevo') AND (text IS NOT NULL OR summary IS NOT NULL)"
        ).fetchall()

    def save_analysis(self, art_id, a):
        self.con.execute(
            "INSERT OR REPLACE INTO analysis (article_id, relevant, rel_score, stance, confidence, crit_score,"
            " favor_score, strategy_score, covers_strategy, themes, evidence, targets, voices, manual)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (art_id, int(a["relevant"]), a["rel_score"], a["stance"], a["confidence"], a["crit_score"],
             a["favor_score"], a["strategy_score"], int(a["covers_strategy"]),
             json.dumps(a["themes"], ensure_ascii=False), json.dumps(a["evidence"], ensure_ascii=False),
             json.dumps(a["targets"], ensure_ascii=False), json.dumps(a["voices"], ensure_ascii=False),
             int(a.get("manual", 0))),
        )
        self.con.commit()

    def results(self, only_relevant=True):
        q = ("SELECT a.*, n.relevant, n.rel_score, n.stance, n.confidence, n.crit_score, n.favor_score,"
             " n.strategy_score, n.covers_strategy, n.themes, n.evidence, n.targets, n.voices, n.manual"
             " FROM articles a JOIN analysis n ON n.article_id = a.id")
        if only_relevant:
            q += " WHERE n.relevant = 1"
        q += " ORDER BY a.published DESC"
        rows = []
        for r in self.con.execute(q).fetchall():
            d = dict(r)
            for k, empty in (("themes", []), ("evidence", []), ("targets", {}), ("voices", {})):
                d[k] = json.loads(d[k]) if d[k] else empty
            rows.append(d)
        return rows

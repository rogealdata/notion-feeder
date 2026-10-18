"""Descubrimiento de notas: RSS propios de cada medio + Google Noticias (site:dominio)."""
import re
from datetime import datetime
from time import mktime
from urllib.parse import quote_plus, urlparse

import feedparser

from .config import compile_patterns
from .textutil import canonical_url, norm


def _published(entry):
    t = entry.get("published_parsed") or entry.get("updated_parsed")
    return datetime.fromtimestamp(mktime(t)).isoformat(timespec="seconds") if t else ""


def _clean_title(title, source_name=None):
    # Google Noticias agrega " - Nombre del medio" al final
    return re.sub(r"\s+-\s+[^-]{2,60}$", "", title or "").strip()


def google_news_url(query, domain, since):
    q = f"{query} site:{domain}"
    if since:
        q += f" after:{since}"
    return f"https://news.google.com/rss/search?q={quote_plus(q)}&hl=es-419&gl=MX&ceid=MX:es-419"


def collect(cfg, db, client, since, only=None, log=print):
    water = compile_patterns(cfg.keywords["agua"])
    stats = {"nuevas": 0, "vistas": 0, "fallas": []}

    def ingest(entries, source, discovery, prefilter):
        for e in entries:
            link, title = e.get("link"), e.get("title", "")
            if not link or not title:
                continue
            summary = re.sub(r"<[^>]+>", " ", e.get("summary", ""))
            if prefilter and not water.search(norm(title + " " + summary)):
                continue
            if discovery == "google":
                src_url = (e.get("source") or {}).get("href", "")
                if src_url and urlparse(src_url).netloc.removeprefix("www.") != source["domain"].lower().removeprefix("www."):
                    continue  # Google a veces devuelve otros dominios
                title = _clean_title(title)
            stats["vistas"] += 1
            if db.add_candidate(link, canonical_url(link), source, title, summary.strip(), _published(e), discovery):
                stats["nuevas"] += 1

    for src in cfg.sources:
        if only and src["id"] not in only:
            continue
        for feed_url in src.get("rss", []):
            try:
                r = client.get(feed_url, check_robots=False)
                ingest(feedparser.parse(r.content).entries, src, "rss", prefilter=True)
                log(f"  [{src['id']}] RSS ok: {feed_url}")
            except Exception as ex:  # noqa: BLE001 - un feed caído no debe detener todo
                stats["fallas"].append((src["id"], feed_url, str(ex)))
                log(f"  [{src['id']}] RSS falló ({ex}): {feed_url}")
        if src.get("domain"):
            for q in cfg.keywords["busquedas"]:
                url = google_news_url(q, src["domain"], since)
                try:
                    r = client.get(url, check_robots=False)
                    ingest(feedparser.parse(r.content).entries, src, "google", prefilter=False)
                except Exception as ex:  # noqa: BLE001
                    stats["fallas"].append((src["id"], q, str(ex)))
                    log(f"  [{src['id']}] Google Noticias falló para '{q}': {ex}")
            log(f"  [{src['id']}] {src['name']}: listo")
    return stats


def add_urls(db, urls, source_for_url, log=print):
    """Alta manual de URLs (una por línea). source_for_url(url) -> dict de medio."""
    n = 0
    for u in urls:
        u = u.strip()
        if not u or u.startswith("#"):
            continue
        src = source_for_url(u)
        if db.add_candidate(u, canonical_url(u), src, "", "", "", "manual"):
            n += 1
    log(f"{n} URLs nuevas agregadas")
    return n

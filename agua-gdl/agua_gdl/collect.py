"""Descubrimiento de notas: RSS propios de cada medio + Google Noticias (site:dominio)."""
import gzip
import re
from datetime import datetime
from time import mktime
from urllib.parse import quote_plus, urlparse

import feedparser
from lxml import etree

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


def _local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def parse_sitemap(content):
    """-> ('index'|'urlset', [{'loc','lastmod','title'}]). Soporta sitemap índice, urlset y news-sitemap."""
    if content[:2] == b"\x1f\x8b":
        content = gzip.decompress(content)
    root = etree.fromstring(content, parser=etree.XMLParser(recover=True, resolve_entities=False))
    if root is None:
        return "urlset", []
    kind = "index" if _local(root.tag) == "sitemapindex" else "urlset"
    out = []
    for node in root:
        d = {"loc": "", "lastmod": "", "title": ""}
        for ch in node.iter():
            name = _local(ch.tag)
            text = (ch.text or "").strip()
            if name == "loc" and not d["loc"]:
                d["loc"] = text
            elif name in ("lastmod", "publication_date") and text and not d["lastmod"]:
                d["lastmod"] = text
            elif name == "title" and text and not d["title"]:
                d["title"] = text
        if d["loc"]:
            out.append(d)
    return kind, out


def _slug_title(url):
    slug = urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]
    return re.sub(r"[-_]+", " ", re.sub(r"\.\w{2,5}$", "", slug)).strip()


def discover_sitemap(client, src, since, water, max_sitemaps=12, log=print):
    """Descubre notas recientes desde los sitemaps del medio, filtrando por palabras de agua en título/slug."""
    base = f"https://{src['domain']}"
    starts = list(src.get("sitemap") or [])
    if not starts:
        try:
            for line in client.get(base + "/robots.txt", check_robots=False).text.splitlines():
                if line.lower().startswith("sitemap:"):
                    starts.append(line.split(":", 1)[1].strip())
        except Exception:  # noqa: BLE001
            pass
        starts += [base + "/news-sitemap.xml", base + "/sitemap.xml"]

    queue, seen, found, fetched = list(dict.fromkeys(starts)), set(), [], 0
    while queue and fetched < max_sitemaps:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        try:
            kind, entries = parse_sitemap(client.get(url, check_robots=False).content)
        except Exception:  # noqa: BLE001
            continue
        fetched += 1
        if kind == "index":
            recent = [e for e in entries if not since or not e["lastmod"] or e["lastmod"][:10] >= since]
            recent.sort(key=lambda e: e["lastmod"], reverse=True)
            recent.sort(key=lambda e: "news" not in e["loc"].lower())  # news-sitemaps primero (orden estable)
            queue = [e["loc"] for e in recent] + queue
        else:
            for e in entries:
                if since and e["lastmod"] and e["lastmod"][:10] < since:
                    continue
                title = e["title"] or _slug_title(e["loc"])
                if water.search(norm(title)):
                    found.append({"link": e["loc"], "title": title, "published": e["lastmod"]})
    return found


def collect(cfg, db, client, since, only=None, modes=("rss", "sitemap", "google"), log=print):
    water = compile_patterns(cfg.keywords["agua"])
    stats = {"nuevas": 0, "vistas": 0, "fallas": []}

    def ingest(entries, source, discovery, prefilter):
        for e in entries:
            if "published" in e and "published_parsed" not in e:
                e = {**e, "_pub": e["published"]}
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
            published = e.get("_pub") or _published(e)
            if db.add_candidate(link, canonical_url(link), source, title, summary.strip(), published, discovery):
                stats["nuevas"] += 1

    for src in cfg.sources:
        if only and src["id"] not in only:
            continue
        for feed_url in (src.get("rss", []) if "rss" in modes else []):
            try:
                r = client.get(feed_url, check_robots=False)
                ingest(feedparser.parse(r.content).entries, src, "rss", prefilter=True)
                log(f"  [{src['id']}] RSS ok: {feed_url}")
            except Exception as ex:  # noqa: BLE001 - un feed caído no debe detener todo
                stats["fallas"].append((src["id"], feed_url, str(ex)))
                log(f"  [{src['id']}] RSS falló ({ex}): {feed_url}")
        if "sitemap" in modes and src.get("domain"):
            try:
                ingest(discover_sitemap(client, src, since, water, log=log), src, "sitemap", prefilter=False)
                log(f"  [{src['id']}] sitemap ok")
            except Exception as ex:  # noqa: BLE001
                stats["fallas"].append((src["id"], "sitemap", str(ex)))
                log(f"  [{src['id']}] sitemap falló ({ex})")
        if "google" in modes and src.get("domain"):
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

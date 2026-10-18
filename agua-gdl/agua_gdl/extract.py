"""Extracción de título, fecha y texto de una nota a partir del HTML (heurísticas, sin LLM)."""
import json
import re

from bs4 import BeautifulSoup

_BOILERPLATE = re.compile(
    r"^(lee tambi[eé]n|te recomendamos|te puede interesar|suscr[ií]bete|sigue leyendo|"
    r"publicidad|con informaci[oó]n de|foto:|fotos?:|ver m[aá]s|compartir|comentarios)", re.I)
_CONTAINERS = ["[itemprop=articleBody]", "article", ".article-body", ".entry-content", ".post-content",
               ".nota-content", ".story-body", "main"]
_DROP = ["script", "style", "nav", "aside", "footer", "header", "form", "figure", "noscript", "iframe"]


def _jsonld_articles(soup):
    found = []

    def walk(node):
        if isinstance(node, list):
            for n in node:
                walk(n)
        elif isinstance(node, dict):
            t = node.get("@type")
            t = t if isinstance(t, list) else [t]
            if any(x in ("NewsArticle", "Article", "ReportageNewsArticle", "BlogPosting") for x in t):
                found.append(node)
            walk(node.get("@graph", []))

    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            walk(json.loads(tag.string or ""))
        except (ValueError, TypeError):
            continue
    return found


def _meta(soup, *names):
    for n in names:
        tag = soup.find("meta", attrs={"property": n}) or soup.find("meta", attrs={"name": n})
        if tag and tag.get("content"):
            return tag["content"].strip()
    return ""


def _paragraphs(container):
    out = []
    for p in container.find_all("p"):
        t = re.sub(r"\s+", " ", p.get_text(" ", strip=True))
        if len(t) >= 40 and not _BOILERPLATE.match(t):
            out.append(t)
    return out


def extract(html):
    """Devuelve dict(title, published, text)."""
    soup = BeautifulSoup(html, "lxml")
    ld = _jsonld_articles(soup)

    title = (ld[0].get("headline") if ld else "") or _meta(soup, "og:title", "twitter:title")
    if not title:
        h1 = soup.find("h1")
        title = h1.get_text(" ", strip=True) if h1 else (soup.title.string.strip() if soup.title and soup.title.string else "")

    published = (ld[0].get("datePublished") if ld else "") or _meta(
        soup, "article:published_time", "datePublished", "date", "pubdate")
    if not published:
        t = soup.find("time", attrs={"datetime": True})
        published = t["datetime"] if t else ""

    body = ""
    if ld and isinstance(ld[0].get("articleBody"), str):
        body = re.sub(r"<[^>]+>", " ", ld[0]["articleBody"])
        body = re.sub(r"[ \t]+", " ", body).strip()

    paragraphs = []
    if len(body) < 400:
        for tag in soup(_DROP):
            tag.decompose()
        best = []
        for sel in _CONTAINERS:
            for c in soup.select(sel):
                ps = _paragraphs(c)
                if sum(map(len, ps)) > sum(map(len, best)):
                    best = ps
        paragraphs = best or _paragraphs(soup)
        body = "\n".join(paragraphs) if paragraphs else body

    return {"title": (title or "").strip(), "published": (published or "").strip(), "text": body.strip()}

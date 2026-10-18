"""Descarga de cada nota y extracción de su texto."""
from urllib.parse import urlparse

from .extract import extract
from .textutil import canonical_url, title_key

MIN_FULL_TEXT = 600  # menos caracteres que esto = probable muro de pago o bloqueo


def resolve_google(url):
    """Resuelve un enlace news.google.com al artículo real (requiere googlenewsdecoder)."""
    try:
        from googlenewsdecoder import gnewsdecoder
    except ImportError as e:
        raise RuntimeError("falta instalar googlenewsdecoder para resolver enlaces de Google Noticias") from e
    res = gnewsdecoder(url, interval=1)
    if not res.get("status"):
        raise RuntimeError(f"no se pudo resolver: {res.get('message')}")
    return res["decoded_url"]


def fetch_all(db, client, log=print, limit=None):
    seen_titles = {}
    for row in db.con.execute("SELECT id, title FROM articles WHERE status='descargado'"):
        seen_titles[title_key(row["title"])] = row["id"]

    pending = db.pending()
    if limit:
        pending = pending[:limit]
    ok = err = dup = 0
    for i, row in enumerate(pending, 1):
        url = row["url"]
        try:
            if urlparse(url).netloc == "news.google.com":
                real = resolve_google(url)
                if not db.set_resolved(row["id"], real, canonical_url(real)):
                    dup += 1
                    continue
                url = real
            html = client.get(url).text
            data = extract(html)
            text = data["text"] or row["summary"] or ""
            partial = len(data["text"]) < MIN_FULL_TEXT
            title = data["title"] or row["title"]
            key = title_key(title)
            if key and key in seen_titles and seen_titles[key] != row["id"]:
                db.mark_duplicate(row["id"])
                dup += 1
                continue
            seen_titles[key] = row["id"]
            db.save_download(row["id"], title, data["published"], text, partial)
            ok += 1
        except Exception as ex:  # noqa: BLE001
            db.save_error(row["id"], str(ex))
            err += 1
            log(f"  error [{row['source_id']}] {url}: {ex}")
        if i % 25 == 0:
            log(f"  {i}/{len(pending)} procesadas")
    log(f"descarga: {ok} ok, {err} con error, {dup} duplicadas")
    return ok, err, dup

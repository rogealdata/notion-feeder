import re
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

_ABBREV = {"dr", "dra", "lic", "ing", "sr", "sra", "mtro", "mtra", "gral", "num", "no", "art", "etc", "vs", "prof", "arq"}
_SENT_SPLIT = re.compile(r'(?<=[.!?…])["”»)]?\s+(?=[A-ZÁÉÍÓÚÑ¿¡"“«0-9])')
_TRACKING = re.compile(r"^(utm_|fbclid|gclid|mc_|ref$|ref_|cmpid|outputtype|amp$)", re.I)


def norm(text):
    """Minúsculas, sin acentos, espacios colapsados."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", text.lower()).strip()


def split_sentences(text):
    out = []
    for para in re.split(r"\n+", text or ""):
        para = para.strip()
        if not para:
            continue
        for piece in _SENT_SPLIT.split(para):
            piece = piece.strip()
            if not piece:
                continue
            prev = out[-1] if out else ""
            last_word = re.sub(r"\W", "", prev.split()[-1].lower()) if prev.split() else ""
            if prev and prev.endswith(".") and last_word in _ABBREV:
                out[-1] = f"{prev} {piece}"
            else:
                out.append(piece)
    return out


def canonical_url(url):
    p = urlparse((url or "").strip())
    query = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not _TRACKING.match(k)]
    path = p.path.rstrip("/") or "/"
    return urlunparse((p.scheme.lower(), p.netloc.lower().removeprefix("www."), path, "", urlencode(query), ""))


def title_key(title):
    """Clave para detectar notas repetidas entre medios (sin el sufijo ' - Medio')."""
    t = re.sub(r"\s[-|–—]\s[^-|–—]{2,40}$", "", title or "")
    return re.sub(r"[^a-z0-9]+", "", norm(t))

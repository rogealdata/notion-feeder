"""Correcciones manuales: config/revision_manual.csv (url,postura,nota)."""
import csv
from pathlib import Path

from .analysis import STANCES
from .textutil import canonical_url


def from_rows(rows):
    """rows: iterable de dicts con url/postura (p. ej. la pestaña Revisión de Google Sheets)."""
    out = {}
    for row in rows:
        stance = str(row.get("postura") or "").strip()
        if row.get("url") and stance in STANCES:
            out[canonical_url(str(row["url"]))] = stance
    return out


def load(path):
    p = Path(path)
    if not p.exists():
        return {}
    with open(p, newline="", encoding="utf-8") as f:
        return from_rows(csv.DictReader(f))

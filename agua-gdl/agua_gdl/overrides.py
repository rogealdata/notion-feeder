"""Correcciones manuales: config/revision_manual.csv (url,postura,nota)."""
import csv
from pathlib import Path

from .analysis import STANCES
from .textutil import canonical_url


def load(path):
    p = Path(path)
    if not p.exists():
        return {}
    out = {}
    with open(p, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            stance = (row.get("postura") or "").strip()
            if row.get("url") and stance in STANCES:
                out[canonical_url(row["url"])] = stance
    return out

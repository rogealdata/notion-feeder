"""Etapas compartidas por la CLI y el cuaderno de Colab."""
from .analysis import Analyzer
from .textutil import canonical_url


def analyze_all(db, cfg, overrides=None, log=print):
    an = Analyzer(cfg)
    overrides = overrides or {}
    n = rel = 0
    for r in db.to_analyze():
        res = an.analyze(r["title"] or "", r["text"] or r["summary"] or "")
        manual = overrides.get(r["canonical_url"]) or overrides.get(canonical_url(r["url"]))
        if manual:
            res["stance"], res["manual"] = manual, 1
        db.save_analysis(r["id"], res)
        n += 1
        rel += res["relevant"]
    log(f"{n} notas analizadas, {rel} relevantes")
    return n, rel

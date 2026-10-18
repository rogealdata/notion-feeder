import argparse
import csv
import sys
from pathlib import Path
from urllib.parse import urlparse

from .analysis import STANCES, Analyzer
from .collect import add_urls, collect
from .config import ROOT, Config
from .db import DB
from .fetch import fetch_all
from .http import Client
from .overrides import load as load_overrides
from .report import build
from .textutil import canonical_url

DATA = ROOT / "data"


def _source_for_url(cfg):
    by_domain = {s["domain"].lower().removeprefix("www."): s for s in cfg.sources if s.get("domain")}

    def find(url):
        host = urlparse(url).netloc.lower().removeprefix("www.")
        for dom, s in by_domain.items():
            if host == dom or host.endswith("." + dom):
                return s
        return {"id": host, "name": host, "scope": "nacional"}  # medio no listado: ajusta scope en sources.yaml
    return find


def cmd_collect(a, cfg, db):
    since = a.desde or cfg.keywords.get("desde")
    s = collect(cfg, db, Client(delay=a.pausa), since, only=set(a.medio) if a.medio else None)
    print(f"{s['nuevas']} notas nuevas de {s['vistas']} vistas; {len(s['fallas'])} fuentes con falla")


def cmd_fetch(a, cfg, db):
    fetch_all(db, Client(delay=a.pausa, respect_robots=not a.ignorar_robots), limit=a.limite)


def cmd_analyze(a, cfg, db):
    an = Analyzer(cfg)
    ov = load_overrides(cfg.dir / "revision_manual.csv")
    n = rel = 0
    for r in db.to_analyze():
        res = an.analyze(r["title"] or "", r["text"] or r["summary"] or "")
        manual = ov.get(r["canonical_url"]) or ov.get(canonical_url(r["url"]))
        if manual:
            res["stance"], res["manual"] = manual, 1
        db.save_analysis(r["id"], res)
        n += 1
        rel += res["relevant"]
    print(f"{n} notas analizadas, {rel} relevantes")


def cmd_report(a, cfg, db):
    out = Path(a.salida)
    s = build(db, cfg.themes, out, Path(__file__).parent / "templates")
    print(f"Reporte en {out/'reporte.html'}  |  {s}")


def cmd_add_urls(a, cfg, db):
    lines = Path(a.archivo).read_text(encoding="utf-8").splitlines()
    add_urls(db, lines, _source_for_url(cfg))


def cmd_evaluate(a, cfg, db):
    """Compara la clasificación automática con etiquetas tuyas (CSV: url,postura)."""
    gold = {}
    with open(a.etiquetas, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["postura"] in STANCES:
                gold[canonical_url(row["url"])] = row["postura"]
    rows = {canonical_url(r["url"]): r for r in db.results(only_relevant=False)}
    labels = list(STANCES)
    matrix = {g: {p: 0 for p in labels} for g in labels}
    hits = total = 0
    for url, g in gold.items():
        r = rows.get(url)
        if not r:
            continue
        matrix[g][r["stance"]] += 1
        total += 1
        hits += g == r["stance"]
    print("filas = etiqueta humana, columnas = predicción")
    print(f"{'':10}" + "".join(f"{p:>11}" for p in labels))
    for g in labels:
        print(f"{g:10}" + "".join(f"{matrix[g][p]:>11}" for p in labels))
    print(f"exactitud: {hits}/{total}" + (f" = {hits/total:.0%}" if total else ""))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="agua-gdl", description=__doc__)
    ap.add_argument("--config", help="carpeta de configuración (default: ./config)")
    ap.add_argument("--db", default=str(DATA / "agua.db"))
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("recolectar", help="descubre notas (RSS + Google Noticias)")
    p.add_argument("--desde", help="AAAA-MM-DD")
    p.add_argument("--medio", nargs="*", help="ids de medios (ver sources.yaml)")
    p.add_argument("--pausa", type=float, default=1.5)
    p.set_defaults(fn=cmd_collect)

    p = sub.add_parser("descargar", help="baja el texto de cada nota")
    p.add_argument("--limite", type=int)
    p.add_argument("--pausa", type=float, default=1.5)
    p.add_argument("--ignorar-robots", action="store_true")
    p.set_defaults(fn=cmd_fetch)

    p = sub.add_parser("analizar", help="relevancia, postura, estrategia y temas")
    p.set_defaults(fn=cmd_analyze)

    p = sub.add_parser("reporte", help="genera HTML + CSVs")
    p.add_argument("--salida", default=str(DATA / "reporte"))
    p.set_defaults(fn=cmd_report)

    p = sub.add_parser("agregar-urls", help="agrega URLs a mano desde un archivo (una por línea)")
    p.add_argument("archivo")
    p.set_defaults(fn=cmd_add_urls)

    p = sub.add_parser("evaluar", help="mide la exactitud contra tus etiquetas (CSV url,postura)")
    p.add_argument("etiquetas")
    p.set_defaults(fn=cmd_evaluate)

    p = sub.add_parser("todo", help="recolectar + descargar + analizar + reporte")
    p.add_argument("--desde")
    p.add_argument("--medio", nargs="*")
    p.add_argument("--pausa", type=float, default=1.5)
    p.add_argument("--limite", type=int)
    p.add_argument("--ignorar-robots", action="store_true")
    p.add_argument("--salida", default=str(DATA / "reporte"))

    a = ap.parse_args(argv)
    cfg = Config(a.config)
    DATA.mkdir(exist_ok=True)
    db = DB(a.db)
    if a.cmd == "todo":
        for fn in (cmd_collect, cmd_fetch, cmd_analyze, cmd_report):
            fn(a, cfg, db)
    else:
        a.fn(a, cfg, db)


if __name__ == "__main__":
    sys.exit(main())

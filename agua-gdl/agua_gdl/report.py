"""Genera CSVs y un reporte HTML autocontenido a partir de la base de datos."""
import csv
from collections import Counter, defaultdict
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

STANCE_LABEL = {"a_favor": "A favor", "en_contra": "En contra", "mixta": "Mixta", "neutral": "Neutral"}


def _short(r):
    ev = r["evidence"]
    return {
        "fecha": (r["published"] or "")[:10], "medio": r["source_name"], "ambito": r["scope"],
        "titulo": r["title"], "url": r["url"], "postura": r["stance"], "confianza": r["confidence"],
        "puntos_critica": r["crit_score"], "puntos_favor": r["favor_score"],
        "temas": "; ".join(t["etiqueta"] for t in r["themes"]),
        "evidencia_critica": " | ".join(e["frase"] for e in ev.get("critica", [])[:2]),
        "evidencia_favor": " | ".join(e["frase"] for e in ev.get("favor", [])[:2]),
        "texto_parcial": r["partial"], "manual": r["manual"],
    }


def criticism_summary(rows, themes_cfg):
    crit_rows = [r for r in rows if r["stance"] in ("en_contra", "mixta") and r["crit_score"] > 0]
    by_theme = defaultdict(list)
    for r in crit_rows:
        if r["stance"] == "mixta" and r["crit_score"] <= r["favor_score"]:
            continue
        keys = [t["tema"] for t in r["themes"]] or ["_otras"]
        for k in keys:
            by_theme[k].append(r)

    cards = []
    for k, arts in by_theme.items():
        arts = sorted(arts, key=lambda r: -r["crit_score"])
        targets, voices = Counter(), Counter()
        for r in arts:
            targets.update(r["targets"])
            voices.update(r["voices"])
        quotes = []
        for r in arts[:5]:
            ev = r["evidence"].get("critica") or []
            if ev:
                quotes.append({"frase": ev[0]["frase"], "medio": r["source_name"], "titulo": r["title"], "url": r["url"],
                               "fecha": (r["published"] or "")[:10]})
        cards.append({
            "tema": k,
            "etiqueta": "Otras críticas (sin tema dominante)" if k == "_otras" else themes_cfg[k]["etiqueta"],
            "n": len(arts),
            "medios": Counter(r["source_name"] for r in arts).most_common(6),
            "locales": sum(1 for r in arts if r["scope"] == "local"),
            "nacionales": sum(1 for r in arts if r["scope"] == "nacional"),
            "puntos": round(sum(r["crit_score"] for r in arts), 1),
            "quotes": quotes,
            "targets": targets.most_common(4),
            "voices": voices.most_common(4),
        })
    cards.sort(key=lambda c: (-c["n"], -c["puntos"]))
    return cards


def split(rows):
    """Reparte las notas relevantes en las listas que usan el reporte HTML, los CSV y Google Sheets."""
    by = lambda st: [r for r in rows if r["stance"] == st]  # noqa: E731
    en_contra = sorted(by("en_contra"), key=lambda r: -r["crit_score"])
    a_favor = sorted(by("a_favor"), key=lambda r: -r["favor_score"])
    strategy_all = [r for r in rows if r["covers_strategy"]]
    strategy_fav = sorted(
        (r for r in strategy_all if r["favor_score"] > r["crit_score"]),
        key=lambda r: -(r["favor_score"] + r["strategy_score"]))
    return {"en_contra": en_contra, "a_favor": a_favor, "mixtas": by("mixta"), "neutrales": by("neutral"),
            "strategy_all": strategy_all, "strategy_fav": strategy_fav}


def outlet_table(rows):
    per_outlet = defaultdict(Counter)
    for r in rows:
        per_outlet[(r["source_name"], r["scope"])][r["stance"]] += 1
    return sorted(
        ({"medio": k[0], "ambito": k[1], "total": sum(c.values()), **{s: c.get(s, 0) for s in STANCE_LABEL}}
         for k, c in per_outlet.items()), key=lambda o: (-o["total"], o["medio"]))


def build(db, themes_cfg, out_dir, templates_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rows = db.results(only_relevant=True)

    parts = split(rows)
    en_contra, a_favor, mixtas, neutrales = parts["en_contra"], parts["a_favor"], parts["mixtas"], parts["neutrales"]
    strategy_all, strategy_fav = parts["strategy_all"], parts["strategy_fav"]
    cards = criticism_summary(rows, themes_cfg)
    top_crit = en_contra[:15]
    outlets = outlet_table(rows)
    per_scope = {sc: Counter(r["stance"] for r in rows if r["scope"] == sc) for sc in ("local", "nacional")}

    # CSVs
    def dump(name, items):
        data = [_short(r) for r in items]
        with open(out / name, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(_short(items[0]).keys()) if items else ["vacio"])
            w.writeheader()
            w.writerows(data)

    dump("todas_las_notas.csv", rows)
    dump("notas_en_contra.csv", en_contra)
    dump("notas_a_favor.csv", a_favor)
    dump("notas_mixtas.csv", mixtas)
    dump("estrategia_gobierno_favorable.csv", strategy_fav)
    dump("estrategia_gobierno_toda_la_cobertura.csv", strategy_all)
    with open(out / "criticas_por_tema.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["tema", "notas", "locales", "nacionales", "puntos", "medios_principales", "a_quien_se_critica", "quien_critica"])
        for c in cards:
            w.writerow([c["etiqueta"], c["n"], c["locales"], c["nacionales"], c["puntos"],
                        ", ".join(f"{m} ({n})" for m, n in c["medios"]),
                        ", ".join(f"{t} ({n})" for t, n in c["targets"]),
                        ", ".join(f"{t} ({n})" for t, n in c["voices"])])

    env = Environment(loader=FileSystemLoader(str(templates_dir)), autoescape=True)
    env.filters["fecha"] = lambda s: (s or "")[:10]
    env.filters["seguro"] = lambda u: u if (u or "").startswith(("http://", "https://")) else "#"
    html = env.get_template("report.html.j2").render(
        total=len(rows), n_en_contra=len(en_contra), n_a_favor=len(a_favor), n_mixtas=len(mixtas),
        n_neutrales=len(neutrales), outlets=outlets, per_scope=per_scope, labels=STANCE_LABEL,
        en_contra=en_contra, a_favor=a_favor, mixtas=mixtas, cards=cards, top_crit=top_crit,
        strategy_fav=strategy_fav, strategy_all=strategy_all,
        parciales=sum(1 for r in rows if r["partial"]),
    )
    (out / "reporte.html").write_text(html, encoding="utf-8")
    return {"total": len(rows), "en_contra": len(en_contra), "a_favor": len(a_favor), "mixtas": len(mixtas),
            "neutrales": len(neutrales), "estrategia_favorable": len(strategy_fav), "temas": len(cards)}

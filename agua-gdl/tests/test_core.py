"""Pruebas con textos SINTÉTICOS escritos para validar la lógica (no son notas reales)."""
import pytest

from agua_gdl.analysis import Analyzer
from agua_gdl.config import Config
from agua_gdl.db import DB
from agua_gdl.extract import extract
from agua_gdl.overrides import load as load_overrides
from agua_gdl.report import build
from agua_gdl.textutil import canonical_url, norm, split_sentences, title_key

CRITICA = (
    "Colonias de Zapopan siguen sin agua y vecinos acusan negligencia del SIAPA",
    "Vecinos de Zapopan denunciaron que el SIAPA ha mostrado negligencia y falta de planeación ante el desabasto. "
    "Colectivos de la Zona Metropolitana de Guadalajara acusan opacidad en los contratos de las pipas. "
    "Especialistas advierten que el gobierno de Jalisco improvisa y que las medidas son paliativos insuficientes. "
    "Los tandeos continúan en varias colonias de Tlaquepaque y la crisis del agua se agrava.",
)
FAVOR = (
    "SIAPA inaugura nuevos pozos y garantiza abasto en la Zona Metropolitana de Guadalajara",
    "El gobierno de Jalisco inauguró nuevos pozos como parte de la estrategia hídrica y garantiza el abasto en Zapopan. "
    "La inversión de 500 millones de pesos beneficiará a miles de familias. "
    "El SIAPA informó que se restablece el servicio y que el desabasto disminuye en Tlaquepaque. "
    "Las obras de rehabilitación avanzan conforme al plan.",
)
NEUTRA = (
    "Publican calendario de tandeos de agua en Guadalajara",
    "El SIAPA publicó el calendario de tandeos de agua para Guadalajara y Zapopan. "
    "Las colonias pueden consultarlo en el portal del organismo.",
)
OFFTOPIC = ("Receta de agua de coco con limón", "Mezcle el agua de coco con hielo. Sirva en Guadalajara bien fría.")


@pytest.fixture(scope="module")
def an():
    return Analyzer(Config())


def test_normalize_and_sentences():
    assert norm("  Tlaquepaque ÁGUA  ñandú ") == "tlaquepaque agua nandu"
    s = split_sentences("El Dr. Pérez habló. Luego llegó la Lic. Ruiz con datos. Fin.")
    assert len(s) == 3 and s[0].startswith("El Dr. Pérez")


def test_canonical_and_title_key():
    assert canonical_url("https://www.X.com/a/b/?utm_source=fb&id=3#frag") == "https://x.com/a/b?id=3"
    assert title_key("Sin agua en Zapopan - El Informador") == title_key("Sin agua en Zapopan")


def test_critical_note(an):
    r = an.analyze(*CRITICA)
    assert r["relevant"] and r["stance"] == "en_contra"
    assert r["crit_score"] > r["favor_score"]
    assert {t["tema"] for t in r["themes"]} >= {"corrupcion_y_opacidad", "desabasto_y_tandeos"}
    assert "vecinos y colonos" in r["voices"] or "colectivos y activistas" in r["voices"]
    assert r["evidence"]["critica"]


def test_favorable_note_covers_strategy(an):
    r = an.analyze(*FAVOR)
    assert r["relevant"] and r["stance"] == "a_favor" and r["covers_strategy"]
    assert r["themes"] == []


def test_neutral_and_irrelevant(an):
    assert an.analyze(*NEUTRA)["stance"] == "neutral"
    assert not an.analyze(*OFFTOPIC)["relevant"]


def test_negation_flips_polarity(an):
    pos = an.sentence("El gobierno cumplió con la entrega de pozos.")
    neg = an.sentence("El gobierno no cumplió con la entrega de pozos.")
    assert pos["favor"] > pos["crit"] and neg["crit"] > neg["favor"]
    # "incumple" no debe contarse como "cumple"
    assert an.sentence("El SIAPA incumple su palabra.")["favor"] == 0
    # "sin embargo" no es negación
    assert an.sentence("Sin embargo, el SIAPA garantiza el servicio.")["favor"] > 0


def test_problem_words_need_government_actor(an):
    sin = an.sentence("Hay escasez y sequía en la región.")
    con = an.sentence("Hay escasez y sequía y el SIAPA no responde.")
    assert con["crit"] > sin["crit"]


def test_extract_prefers_jsonld_then_paragraphs():
    html = """<html><head><title>x</title>
    <meta property="og:title" content="Título OG">
    <meta property="article:published_time" content="2025-06-01T10:00:00-06:00"></head>
    <body><nav><p>Menú que no debe entrar en el texto de la nota para nada.</p></nav>
    <article><p>Primer párrafo largo de la nota con suficiente texto para contar como contenido real.</p>
    <p>Lee también: otra nota que debe quedar fuera del cuerpo del artículo por ser relleno.</p>
    <p>Segundo párrafo largo de la nota con suficiente texto para contar como contenido real.</p></article></body></html>"""
    d = extract(html)
    assert d["title"] == "Título OG" and d["published"].startswith("2025-06-01")
    assert "Primer párrafo" in d["text"] and "Segundo párrafo" in d["text"]
    assert "Menú" not in d["text"] and "Lee también" not in d["text"]

    ld = ('<script type="application/ld+json">{"@type":"NewsArticle","headline":"H","datePublished":"2025-01-02",'
          '"articleBody":"' + "Texto de la nota. " * 40 + '"}</script>')
    d = extract(f"<html><head>{ld}</head><body></body></html>")
    assert d["title"] == "H" and d["text"].startswith("Texto de la nota.")


def test_pipeline_report_and_overrides(tmp_path):
    cfg = Config()
    an = Analyzer(cfg)
    db = DB(str(tmp_path / "t.db"))
    src_l = {"id": "l", "name": "Medio Local", "scope": "local"}
    src_n = {"id": "n", "name": "Medio Nacional", "scope": "nacional"}
    for i, (src, (t, x)) in enumerate([(src_l, CRITICA), (src_n, FAVOR), (src_l, NEUTRA), (src_n, OFFTOPIC)]):
        url = f"https://ejemplo.mx/nota-{i}"
        db.add_candidate(url, canonical_url(url), src, t, "", f"2025-06-0{i+1}", "manual")
        row = db.con.execute("SELECT id FROM articles WHERE url=?", (url,)).fetchone()
        db.save_download(row["id"], t, "", x, partial=False)
    for r in db.to_analyze():
        db.save_analysis(r["id"], an.analyze(r["title"], r["text"]))

    out = tmp_path / "out"
    summary = build(db, cfg.themes, out, __import__("pathlib").Path("agua_gdl/templates"))
    assert summary["en_contra"] == 1 and summary["a_favor"] == 1 and summary["neutrales"] == 1
    html = (out / "reporte.html").read_text(encoding="utf-8")
    assert "Principales críticas" in html and "Medio Local" in html
    for name in ("notas_en_contra.csv", "notas_a_favor.csv", "criticas_por_tema.csv", "estrategia_gobierno_favorable.csv"):
        assert (out / name).exists()

    ov = tmp_path / "rev.csv"
    ov.write_text("url,postura,nota\nhttps://www.ejemplo.mx/nota-2/,en_contra,x\nhttps://a.b,otra,y\n", encoding="utf-8")
    assert load_overrides(ov) == {"https://ejemplo.mx/nota-2": "en_contra"}

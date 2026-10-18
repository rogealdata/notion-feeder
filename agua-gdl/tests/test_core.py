"""Pruebas con textos SINTÉTICOS escritos para validar la lógica (no son notas reales)."""
from pathlib import Path

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
    summary = build(db, cfg.themes, out, Path(__file__).resolve().parent.parent / "agua_gdl" / "templates")
    assert summary["en_contra"] == 1 and summary["a_favor"] == 1 and summary["neutrales"] == 1
    html = (out / "reporte.html").read_text(encoding="utf-8")
    assert "Principales críticas" in html and "Medio Local" in html
    for name in ("notas_en_contra.csv", "notas_a_favor.csv", "criticas_por_tema.csv", "estrategia_gobierno_favorable.csv"):
        assert (out / name).exists()

    ov = tmp_path / "rev.csv"
    ov.write_text("url,postura,nota\nhttps://www.ejemplo.mx/nota-2/,en_contra,x\nhttps://a.b,otra,y\n", encoding="utf-8")
    assert load_overrides(ov) == {"https://ejemplo.mx/nota-2": "en_contra"}


# ---------- sitemaps y Google Sheets (sin red) ----------
from agua_gdl.collect import discover_sitemap, parse_sitemap  # noqa: E402
from agua_gdl.config import compile_patterns  # noqa: E402
from agua_gdl import sheets  # noqa: E402

SITEMAP_INDEX = b"""<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://ej.mx/sm-2025-06.xml</loc><lastmod>2025-06-30</lastmod></sitemap>
<sitemap><loc>https://ej.mx/sm-2019-01.xml</loc><lastmod>2019-01-31</lastmod></sitemap></sitemapindex>"""
NEWS_SITEMAP = b"""<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
 xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
<url><loc>https://ej.mx/a/1</loc><news:news><news:publication_date>2025-06-10T08:00:00-06:00</news:publication_date>
<news:title>Colonias de Zapopan sin agua</news:title></news:news></url>
<url><loc>https://ej.mx/deportes/gol-del-domingo</loc><lastmod>2025-06-11</lastmod></url>
<url><loc>https://ej.mx/jalisco/crisis-del-agua-en-guadalajara</loc><lastmod>2025-06-12</lastmod></url>
<url><loc>https://ej.mx/jalisco/agua-vieja</loc><lastmod>2020-01-01</lastmod></url></urlset>"""


def test_parse_sitemap():
    assert parse_sitemap(SITEMAP_INDEX)[0] == "index"
    kind, entries = parse_sitemap(NEWS_SITEMAP)
    assert kind == "urlset" and entries[0]["title"] == "Colonias de Zapopan sin agua"
    assert entries[0]["lastmod"].startswith("2025-06-10")


def test_discover_sitemap_filters_by_date_and_water():
    class FakeResp:
        def __init__(self, content):
            self.content, self.text = content, content.decode()

    class FakeClient:
        def __init__(self):
            self.asked = []

        def get(self, url, check_robots=True):
            self.asked.append(url)
            if url.endswith("robots.txt"):
                return FakeResp(b"Sitemap: https://ej.mx/index.xml")
            if url.endswith("index.xml"):
                return FakeResp(SITEMAP_INDEX)
            if "2025-06" in url:
                return FakeResp(NEWS_SITEMAP)
            raise RuntimeError("404")

    client = FakeClient()
    water = compile_patterns(Config().keywords["agua"])
    found = discover_sitemap(client, {"domain": "ej.mx"}, "2025-01-01", water)
    urls = {f["link"] for f in found}
    assert urls == {"https://ej.mx/a/1", "https://ej.mx/jalisco/crisis-del-agua-en-guadalajara"}
    assert not any("2019" in u for u in client.asked)  # no baja sitemaps viejos


class WorksheetNotFound(Exception):
    pass


class FakeWS:
    def __init__(self, title):
        self.title, self.values = title, []

    def get_all_values(self):
        return self.values

    def clear(self):
        self.values = []

    def resize(self, rows, cols):
        pass

    def update(self, range_name, values, value_input_option=None):
        assert value_input_option == "RAW"
        start = int(range_name[1:]) - 1
        self.values[start:start + len(values)] = [list(map(str, r)) for r in values]


class FakeSheet:
    def __init__(self):
        self.tabs = {}

    def worksheet(self, title):
        if title not in self.tabs:
            raise WorksheetNotFound(title)
        return self.tabs[title]

    def add_worksheet(self, title, rows, cols):
        self.tabs[title] = FakeWS(title)
        return self.tabs[title]


def test_sheets_roundtrip(tmp_path):
    cfg = Config()
    sh = FakeSheet()
    sheets.seed_config(sh, cfg)
    assert {"Medios", "Busquedas", "Revision"} <= set(sh.tabs)
    # el usuario apaga un medio y limita el número
    medios = sh.tabs["Medios"].values
    medios[1][-1] = "no"
    cfg2 = sheets.apply_config(sh, Config(), max_medios=3)
    assert len(cfg2.sources) == 3 and medios[1][0] not in {s["id"] for s in cfg2.sources}
    assert cfg2.sources[0]["rss"] is not None
    # revisión manual desde la hoja
    sh.tabs["Revision"].values = [["url", "postura", "nota"], ["https://ejemplo.mx/n/", "a_favor", ""]]
    assert sheets.read_overrides(sh) == {"https://ejemplo.mx/n": "a_favor"}
    # exportación
    an = Analyzer(cfg)
    db = DB(str(tmp_path / "s.db"))
    src = {"id": "l", "name": "Medio Local", "scope": "local"}
    for i, (t, x) in enumerate([CRITICA, FAVOR]):
        u = f"https://ejemplo.mx/n{i}"
        db.add_candidate(u, canonical_url(u), src, t, "", "2025-06-01", "manual")
        rid = db.con.execute("select id from articles where url=?", (u,)).fetchone()["id"]
        db.save_download(rid, t, "", x, False)
    for r in db.to_analyze():
        db.save_analysis(r["id"], an.analyze(r["title"], r["text"]))
    res = sheets.export(sh, db, cfg.themes)
    assert res["notas"] == 2
    assert sh.tabs["En contra"].values[1][1] == "Medio Local" and len(sh.tabs["A favor"].values) == 2
    assert sh.tabs["Resumen"].values[0] == ["Notas relevantes", "2"]
    assert any(r[0].startswith("Desabasto") for r in sh.tabs["Críticas por tema"].values[1:])

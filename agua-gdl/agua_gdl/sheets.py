"""Lectura de configuración y escritura de resultados en Google Sheets (gspread).

`sh` es un gspread.Spreadsheet. El módulo solo usa: sh.worksheet / sh.add_worksheet y, de cada hoja,
get_all_values / clear / resize / update, para poder probarse con un doble sin conexión.
"""
from .overrides import from_rows
from .report import STANCE_LABEL, _short, criticism_summary, outlet_table, split

TAB_MEDIOS, TAB_BUSQUEDAS, TAB_REVISION = "Medios", "Busquedas", "Revision"
MEDIOS_HEADER = ["id", "nombre", "ambito", "dominio", "rss", "sitemap", "paywall", "activo"]
CELL_MAX = 2000
CHUNK = 1000


def _cell(v):
    if v is None:
        return ""
    if isinstance(v, (int, float)):
        return v
    return str(v)[:CELL_MAX]


def _worksheet(sh, title, rows=200, cols=14):
    try:
        return sh.worksheet(title), False
    except Exception as ex:  # noqa: BLE001 - gspread.WorksheetNotFound
        if type(ex).__name__ != "WorksheetNotFound":
            raise
        return sh.add_worksheet(title=title, rows=rows, cols=cols), True


def _write(ws, values):
    """Reemplaza el contenido de la hoja con `values` (lista de listas)."""
    ncols = max(len(r) for r in values)
    ws.clear()
    ws.resize(rows=max(len(values), 2), cols=max(ncols, 2))
    for i in range(0, len(values), CHUNK):
        ws.update(range_name=f"A{i + 1}", values=[[_cell(c) for c in r] for r in values[i:i + CHUNK]],
                  value_input_option="RAW")


def _table(ws):
    values = ws.get_all_values()
    if not values:
        return []
    head = [h.strip() for h in values[0]]
    return [dict(zip(head, row)) for row in values[1:] if any(c.strip() for c in row)]


def _split_list(text):
    return [x for x in str(text or "").replace(",", " ").split() if x]


# ---------------- configuración ----------------
def seed_config(sh, cfg):
    """Crea las pestañas de configuración con los valores por defecto si no existen."""
    ws, new = _worksheet(sh, TAB_MEDIOS, cols=len(MEDIOS_HEADER))
    if new:
        rows = [MEDIOS_HEADER] + [
            [s["id"], s["name"], s["scope"], s.get("domain", ""), " ".join(s.get("rss", [])),
             " ".join(s.get("sitemap", [])), "si" if s.get("paywall") else "", "si"] for s in cfg.sources]
        _write(ws, rows)
    ws, new = _worksheet(sh, TAB_BUSQUEDAS, cols=1)
    if new:
        _write(ws, [["busqueda"]] + [[q] for q in cfg.keywords["busquedas"]])
    ws, new = _worksheet(sh, TAB_REVISION, cols=3)
    if new:
        _write(ws, [["url", "postura", "nota"]])


def apply_config(sh, cfg, max_medios=None):
    """Sustituye medios y búsquedas de `cfg` por lo que haya en la hoja. `activo` vacío o 'no' = se omite."""
    medios = []
    for r in _table(sh.worksheet(TAB_MEDIOS)):
        if not r.get("id") or not r.get("dominio") and not r.get("rss"):
            continue
        if r.get("activo", "si").strip().lower() in ("no", "n", "0", "false"):
            continue
        medios.append({
            "id": r["id"].strip(), "name": r.get("nombre") or r["id"], "scope": (r.get("ambito") or "nacional").strip().lower(),
            "domain": r.get("dominio", "").strip(), "rss": _split_list(r.get("rss")),
            "sitemap": _split_list(r.get("sitemap")), "paywall": r.get("paywall", "").strip().lower() in ("si", "sí", "true", "1"),
        })
    if max_medios:
        medios = medios[:max_medios]
    cfg.sources = medios
    queries = [r["busqueda"].strip() for r in _table(sh.worksheet(TAB_BUSQUEDAS)) if r.get("busqueda", "").strip()]
    if queries:
        cfg.keywords["busquedas"] = queries
    return cfg


def read_overrides(sh):
    return from_rows(_table(sh.worksheet(TAB_REVISION)))


# ---------------- resultados ----------------
NOTE_COLS = ["fecha", "medio", "ambito", "titulo", "url", "postura", "confianza", "puntos_critica",
             "puntos_favor", "temas", "evidencia_critica", "evidencia_favor", "texto_parcial", "manual"]


def _notes_values(rows):
    return [NOTE_COLS] + [[_short(r)[c] for c in NOTE_COLS] for r in rows]


def export(sh, db, themes_cfg):
    rows = db.results(only_relevant=True)
    parts = split(rows)
    tabs = {
        "Todas las notas": rows, "En contra": parts["en_contra"], "A favor": parts["a_favor"],
        "Mixtas": parts["mixtas"], "Estrategia favorable": parts["strategy_fav"],
        "Estrategia (toda la cobertura)": parts["strategy_all"],
    }
    for title, items in tabs.items():
        ws, _ = _worksheet(sh, title, cols=len(NOTE_COLS))
        _write(ws, _notes_values(items))

    cards = criticism_summary(rows, themes_cfg)
    ws, _ = _worksheet(sh, "Críticas por tema", cols=9)
    values = [["tema", "notas", "locales", "nacionales", "puntos", "medios_principales", "a_quien_se_critica",
               "quien_critica", "frases_ejemplo"]]
    for c in cards:
        values.append([
            c["etiqueta"], c["n"], c["locales"], c["nacionales"], c["puntos"],
            ", ".join(f"{m} ({n})" for m, n in c["medios"]), ", ".join(f"{t} ({n})" for t, n in c["targets"]),
            ", ".join(f"{t} ({n})" for t, n in c["voices"]),
            "\n".join(f"“{q['frase'][:220]}” — {q['medio']} {q['url']}" for q in c["quotes"][:3])])
    _write(ws, values)

    ws, _ = _worksheet(sh, "Resumen", cols=7)
    values = [["Notas relevantes", len(rows)]] + [[STANCE_LABEL[k], len([r for r in rows if r["stance"] == k])]
                                                  for k in STANCE_LABEL]
    values += [["Cobertura favorable de la estrategia", len(parts["strategy_fav"])], [],
               ["medio", "ambito", "total", "en_contra", "a_favor", "mixta", "neutral"]]
    values += [[o["medio"], o["ambito"], o["total"], o["en_contra"], o["a_favor"], o["mixta"], o["neutral"]]
               for o in outlet_table(rows)]
    _write(ws, values)
    return {"notas": len(rows), "temas": len(cards)}

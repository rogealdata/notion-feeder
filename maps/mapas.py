import sys; sys.path.insert(0, "data")
import pandas as pd, geopandas as gpd, matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from gobiernos import T

COL = {"L": "#2166ac", "R": "#c0392b", "X": "#b0b0b0"}
YEARS = list(range(2008, 2027))
SNAP = list(range(2008, 2027, 2))

terms = pd.DataFrame(T, columns=["iso3","inicio","fin","lado","confianza","gobierno"])
terms[["inicio","fin"]] = terms[["inicio","fin"]].apply(pd.to_datetime)
rows = []
for y in YEARS:
    d = pd.Timestamp(f"{y}-07-01")
    for _, t in terms[(terms.inicio <= d) & (terms.fin > d)].iterrows():
        rows.append((t.iso3, y, t.lado, t.confianza, t.gobierno))
df = pd.DataFrame(rows, columns=["iso3","anio","lado","confianza","gobierno"])
df.to_csv("data/orientacion_por_anio.csv", index=False)

w = gpd.read_file("data/ne_110m_admin_0_countries.zip")
w = w[w.CONTINENT.isin(["North America","South America"])][["ADM0_A3","NAME","geometry"]]
w = w.rename(columns={"ADM0_A3":"iso3"}).to_crs(epsg=4326)
w = w[~w.iso3.isin(["GRL","FLK"])]
w.loc[w.iso3 == "PRI", "iso3"] = "USA_PRI"   # sin dato propio
w.to_file("data/americas.geojson", driver="GeoJSON")
m = w.merge(df, on="iso3", how="left")

def draw(ax, y):
    s = m[m.anio == y]
    w.plot(ax=ax, color="#e6e6e6", edgecolor="white", lw=.3)
    for k, c in COL.items():
        s[s.lado == k].plot(ax=ax, color=c, edgecolor="white", lw=.4)
    n = s.lado.value_counts()
    ax.set_title(f"{y}   (izq {n.get('L',0)} · der {n.get('R',0)})", fontsize=11)
    ax.set_xlim(-135, -30); ax.set_ylim(-57, 75); ax.axis("off")

leg = [Patch(color=COL["L"], label="Izquierda / progresista"), Patch(color=COL["R"], label="Derecha / securitaria"), Patch(color=COL["X"], label="No clasificable"), Patch(color="#e6e6e6", label="Sin dato (territorio)")]
for y in SNAP:
    f, ax = plt.subplots(figsize=(6, 8)); draw(ax, y)
    ax.legend(handles=leg, loc="lower left", fontsize=8, frameon=False)
    f.savefig(f"mapa_{y}.png", dpi=150, bbox_inches="tight"); plt.close(f)
f, axs = plt.subplots(2, 5, figsize=(22, 12))
for ax, y in zip(axs.flat, SNAP): draw(ax, y)
f.legend(handles=leg, loc="lower center", ncol=4, fontsize=12, frameon=False)
f.suptitle("Orientacion del gobierno en America, 1 julio de cada ano (2008-2026)", fontsize=16)
f.savefig("panel_2008_2026.png", dpi=110, bbox_inches="tight"); plt.close(f)

# pendulo
c = df[df.lado.isin(["L","R"])].groupby(["anio","lado"]).size().unstack(fill_value=0)
c["pct_izq"] = 100 * c.L / (c.L + c.R)
c.to_csv("data/conteo_por_anio.csv")
sw = df[df.lado.isin(["L","R"])].sort_values(["iso3","anio"])
sw["cambio"] = sw.groupby("iso3").lado.transform(lambda s: s != s.shift()) & (sw.groupby("iso3").cumcount() > 0)
cambios = sw[sw.cambio].groupby("anio").size().reindex(YEARS, fill_value=0)
por_pais = sw.groupby("iso3").cambio.sum().sort_values(ascending=False)
por_pais.to_csv("data/cambios_por_pais.csv")
f, (a, b) = plt.subplots(2, 1, figsize=(10, 7), sharex=True, gridspec_kw={"height_ratios":[3,1.4]})
a.stackplot(c.index, c.L, c.R, colors=[COL["L"], COL["R"]], labels=["Izquierda","Derecha"])
a.set_ylabel("Paises"); a.legend(loc="upper left", ncol=2); a.set_title("Ola o pendulo: paises por orientacion")
b.bar(cambios.index, cambios.values, color="#555"); b.set_ylabel("Cambios de signo\n(vs ano previo)")
f.savefig("pendulo.png", dpi=130, bbox_inches="tight")
print(c.round(0).to_string()); print(cambios.to_string()); print(por_pais.head(12).to_string())

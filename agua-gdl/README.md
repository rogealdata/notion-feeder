# agua-gdl · Cobertura mediática del problema del agua en la ZMG

Scrapea medios locales y nacionales, separa las notas **a favor** y **en contra** de la gestión del gobierno,
extrae las **principales críticas** y la **cobertura favorable de la estrategia de respuesta**.
**No usa LLM**: todo es léxico + reglas, y cada clasificación guarda su evidencia para poder auditarla.

## Uso

```bash
cd agua-gdl
pip install -r requirements.txt

python -m agua_gdl todo --desde 2025-01-01      # recolectar → descargar → analizar → reporte
# o por etapas:
python -m agua_gdl recolectar --desde 2025-01-01 [--medio informador jornada]
python -m agua_gdl descargar
python -m agua_gdl analizar
python -m agua_gdl reporte                       # data/reporte/reporte.html + CSVs
python -m agua_gdl agregar-urls urls.txt         # alta manual de notas (una URL por línea)
```

Salidas en `data/reporte/`: `reporte.html` (con filtros por medio/ámbito), `notas_en_contra.csv`, `notas_a_favor.csv`,
`notas_mixtas.csv`, `criticas_por_tema.csv`, `estrategia_gobierno_favorable.csv`,
`estrategia_gobierno_toda_la_cobertura.csv`, `todas_las_notas.csv`.

## Google Colab + Google Sheets

Abre `colab/agua_gdl_colab.ipynb` en Colab (Archivo → Abrir cuaderno → GitHub, o sube el archivo) y corre las celdas en orden.
- La hoja de cálculo es el panel: pestañas **Medios** (activo = no apaga un medio), **Busquedas** y **Revision**
  (correcciones manuales `url,postura`); los resultados se escriben en **En contra**, **A favor**, **Mixtas**,
  **Críticas por tema**, **Estrategia favorable**, **Estrategia (toda la cobertura)**, **Todas las notas** y **Resumen**.
- `MODOS` elige cómo descubrir notas: `rss` y `sitemap` raspan directo cada medio; `google` busca por dominio en Google Noticias.
  Lo recomendable es usar los tres: el scraping directo no depende de Google y Google Noticias llega más atrás en el tiempo.
- `MAX_MEDIOS` / `SOLO_MEDIOS` limitan cuántos medios se raspan; con `GUARDAR_EN_DRIVE` la base se acumula entre corridas.
- Si el repo es privado, guarda un token de GitHub en Colab (🔑 Secrets → `GITHUB_TOKEN`).

## Cómo funciona

1. **Recolectar** (`--modo rss sitemap google`): RSS propios de cada medio, sitemaps (incluye news-sitemaps; filtra por fecha y por palabras de agua en el título/URL) + búsquedas en Google Noticias restringidas por
   `site:dominio` (`config/keywords.yaml` → `busquedas`). Los enlaces de Google se resuelven al artículo real con
   `googlenewsdecoder`.
2. **Descargar**: respeta `robots.txt`, pausa por dominio y reintentos. Extrae título, fecha y cuerpo (JSON-LD →
   `<article>` → párrafos). Si baja poco texto (muro de pago) lo marca como `texto_parcial`. Descarta duplicados por URL y título.
3. **Relevancia**: términos de agua **y** de zona geográfica **y** de problema/estrategia.
4. **Postura** (por oración, luego se agrega con más peso al título y a la entradilla):
   - *Crítica directa* (corrupción, negligencia, improvisación, incumple…), *atribuciones* (acusan, exigen, denuncian…)
     y *descripción del problema* (desabasto, tandeos…) — estas dos solo pesan si la oración nombra a un actor de gobierno
     (SIAPA, CEA, Conagua, gobierno, gobernador, ayuntamiento…).
   - *Respaldo* (inaugura, garantiza, restablece, inversión, rehabilitación, avanza…).
   - Negaciones: «no cumplió» cuenta como crítica; «sin embargo» no es negación; «incumple» ≠ «cumple».
   - Resultado: `en_contra`, `a_favor`, `mixta` o `neutral` (umbrales en `lexicon.yaml → umbrales`).
5. **Principales críticas**: las notas `en_contra` (y mixtas con más crítica que respaldo) se agrupan por tema
   (`config/themes.yaml`), con frases ilustrativas, **a quién** se critica y **quién** critica (vecinos, colectivos,
   academia, legisladores, sector privado).
6. **Estrategia del gobierno**: notas que mencionan estrategia/plan/obras/inversión/programas junto con un actor de
   gobierno; la sección «favorable» exige más señal positiva que crítica.

## Calibración (importante)

Un clasificador por léxico es una **primera pasada**, no un veredicto: no entiende ironía ni distingue una nota que
*describe* una crisis de una que *culpa* al gobierno cuando no hay actor explícito. Para afinarlo:

1. Etiqueta a mano ~50–100 notas en un CSV `url,postura` (`a_favor|en_contra|mixta|neutral`).
2. `python -m agua_gdl evaluar etiquetas.csv` → matriz de confusión y exactitud.
3. Ajusta pesos/términos en `config/lexicon.yaml` y repite `analizar`.
4. Para correcciones puntuales: agrega la fila en `config/revision_manual.csv` (`url,postura,nota`) y vuelve a correr
   `analizar`; la nota queda marcada «corregida a mano».

Además: «a favor/en contra» se mide frente a la **gestión del gobierno**, no frente al problema del agua en sí. Los
medios con muro de pago (Mural, Reforma) se analizan con el texto que se alcance a bajar.

## Pruebas

```bash
python -m pytest tests
```
Usan textos sintéticos para validar la lógica; no contienen notas reales.

## Configuración

- `config/sources.yaml` — medios (local/nacional), dominios y RSS. Agrega o quita a tu gusto.
- `config/keywords.yaml` — búsquedas, fecha inicial, términos de relevancia.
- `config/lexicon.yaml` — léxico de postura, actores, voces y umbrales.
- `config/themes.yaml` — temas de crítica.

# Reader

App para guardar y leer **artículos web, PDF y EPUB** en un solo lugar, con subrayados y notas. Inspirada en Readwise Reader, pero autoalojada: todo vive en tu ordenador (una base de datos SQLite y una carpeta con tus archivos).

## Qué hace

- **Guardar artículos** pegando un enlace. Se extrae el texto limpio (sin anuncios ni menús) con Readability y se guarda una copia, así que puedes leerlo aunque la página desaparezca.
- **Subir PDF y EPUB** con el botón o arrastrándolos a la ventana. Se leen el título y el autor del propio archivo. Si pegas un enlace que apunta a un PDF o EPUB, también se guarda como archivo.
- **Bandeja, Leer después y Archivo** para organizar, además de **favoritos** y **etiquetas**. Hay búsqueda por título o autor y filtro por tipo.
- **Lectores**:
  - Artículos: vista de lectura con tamaño de letra ajustable.
  - PDF: pdf.js con texto seleccionable, zoom y carga perezosa de páginas, para que los libros largos no se atasquen.
  - EPUB: epub.js paginado, con índice, flechas del teclado y tamaño de letra.
  - Fondos de lectura Papel, Sepia y Noche, además del tema claro u oscuro de la app.
- **Subrayados en los tres formatos**: selecciona texto, elige uno de los 5 colores y añade una nota si quieres. Aparecen en el panel lateral y en la página **Subrayados**, que permite buscar en todos a la vez.
- **Progreso de lectura** guardado automáticamente: al volver a abrir un documento, continúas donde lo dejaste.
- **Exportar a Markdown** los subrayados y notas de un documento (útil para Obsidian, Notion, etc.).

## Cómo usarla

Necesitas **Node.js 22.13 o superior** (usa el SQLite que viene con Node, sin dependencias nativas).

```bash
cd reader
npm install
npm start
```

Abre <http://localhost:3000>.

Variables opcionales:

| Variable | Por defecto | Para qué sirve |
| --- | --- | --- |
| `PORT` | `3000` | Puerto del servidor |
| `HOST` | `127.0.0.1` | Pon `0.0.0.0` para abrirla desde otros dispositivos de tu red |
| `READER_DATA_DIR` | `reader/data` | Dónde se guardan la base de datos y los archivos |

> La app **no tiene usuarios ni contraseña**. Está pensada para uso personal en tu equipo. No la expongas a Internet tal cual.

Para hacer una copia de seguridad basta con copiar la carpeta `data/`.

## Extensión del navegador

La carpeta `extension/` tiene una extensión para **Chrome, Edge, Brave** y otros navegadores basados en Chromium. Sirve para guardar con un clic la página que estás leyendo.

**Instalarla (una sola vez):**

1. Abre `chrome://extensions` (en Edge, `edge://extensions`).
2. Activa el **Modo de desarrollador**, arriba a la derecha.
3. Pulsa **Cargar descomprimida** (o "Cargar sin empaquetar") y elige la carpeta `reader/extension`.
4. Fija el icono en la barra: pulsa el icono de la pieza de puzle y luego la chincheta junto a "Guardar en Reader".

**Usarla** (con la app abierta mediante `npm start`):

- **Clic en el icono** o **Alt+Shift+S**: guarda la página actual. Desde la ventanita puedes moverla a *Después*, archivarla, marcarla como favorita o ponerle etiquetas.
- **Clic derecho en un enlace** → *Guardar enlace en Reader*: guarda ese enlace sin abrirlo.
- Los PDF y EPUB abiertos en el navegador se guardan como archivo.

La extensión envía la página tal como la ves tú. Por eso funciona con artículos que solo ves con la sesión iniciada y con webs que cargan el texto con JavaScript.

Si tu Reader no está en `http://localhost:3000`, cambia la dirección en los **Ajustes** de la extensión.

## Desarrollo

```bash
npm run dev   # reinicia el servidor al cambiar archivos
npm test      # pruebas de la API (node:test)
```

Estructura:

```
src/
  server.js    API REST (Express) y archivos estáticos
  db.js        esquema SQLite (documents, document_tags, highlights)
  extract.js   descarga de URLs + Readability + limpieza con DOMPurify
  files.js     detección de PDF/EPUB y lectura de metadatos
  export.js    exportación de subrayados a Markdown
public/
  js/app.js            biblioteca, rutas y subida de archivos
  js/reader.js         lector: barra, panel de subrayados, menú de colores
  js/viewer-*.js       un visor por formato (article, pdf, epub)
test/                  pruebas de la API
extension/             extensión del navegador (Manifest V3)
```

Cada visor guarda la posición del subrayado de una forma distinta:

- Artículo: posiciones de inicio y fin en el texto, más la cita, por si el contenido cambia.
- PDF: número de página y rectángulos relativos al tamaño de la página, así que siguen bien con cualquier zoom.
- EPUB: un CFI, el estándar de EPUB para señalar una posición.

## Próximos pasos posibles

- Suscripción a RSS y newsletters por email.
- Resúmenes y preguntas sobre el documento con IA.
- Cuentas de usuario y sincronización entre dispositivos.
- Repaso diario de subrayados (como Readwise).

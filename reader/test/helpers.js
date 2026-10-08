import JSZip from 'jszip';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

export const ARTICLE_HTML = `<!doctype html>
<html><head><title>Cómo leer mejor | Blog</title>
<meta property="og:site_name" content="Blog de Lectura"></head>
<body>
  <nav>Inicio · Contacto</nav>
  <article>
    <h1>Cómo leer mejor</h1>
    <p class="byline">Por Ana Pérez</p>
    <p>Leer con atención es una habilidad que se entrena. ${'Subrayar las ideas importantes ayuda a recordarlas. '.repeat(20)}</p>
    <p>Otra idea clave: <a href="/notas">tomar notas</a> mientras se lee. <img src="/img/foto.jpg" alt="foto"></p>
    <script>alert('xss')</script>
    <p onclick="alert(1)">${'Revisar los subrayados una semana después consolida la memoria. '.repeat(15)}</p>
  </article>
  <footer>© 2026</footer>
</body></html>`;

export function minimalPdf({ title = 'Mi Libro PDF', author = 'Ana' } = {}) {
  return Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj
4 0 obj<</Title(${title})/Author(${author})>>endobj
trailer<</Root 1 0 R/Info 4 0 R>>
%%EOF`);
}

export async function minimalEpub({ title = 'Cien años', author = 'Gabriel' } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:uuid:1</dc:identifier><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator>
<dc:language>es</dc:language><dc:description>&lt;p&gt;Una novela &amp;amp; más&lt;/p&gt;</dc:description></metadata>
<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>
<spine><itemref idref="c1"/></spine></package>`,
  );
  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Índice</title></head>
<body><nav epub:type="toc"><ol><li><a href="c1.xhtml">Capítulo 1</a></li></ol></nav></body></html>`,
  );
  zip.file(
    'OEBPS/c1.xhtml',
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Capítulo 1</title></head>
<body><h1>Capítulo 1</h1>${'<p>Muchos años después, frente al pelotón de fusilamiento, el coronel recordaría aquella tarde remota.</p>'.repeat(30)}</body></html>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' });
}

/** Start the app on a random port with a throwaway data directory. */
export async function startServer({ fetchImpl } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'reader-test-'));
  const app = createApp({ dataDir, fetchImpl });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async request(path, { method = 'GET', json, body, headers } = {}) {
      const res = await fetch(base + path, {
        method,
        headers: json ? { 'content-type': 'application/json', ...headers } : headers,
        body: json ? JSON.stringify(json) : body,
      });
      const type = res.headers.get('content-type') || '';
      const data = res.status === 204 ? null : type.includes('json') ? await res.json() : await res.text();
      return { status: res.status, headers: res.headers, data };
    },
    async upload(buffer, filename) {
      const form = new FormData();
      form.append('file', new Blob([buffer]), filename);
      return this.request('/api/documents/upload', { method: 'POST', body: form });
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      app.locals.db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function fakeFetch(routes) {
  return async (url) => {
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    const response = new Response(route.body, { status: 200, headers: route.headers });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
}

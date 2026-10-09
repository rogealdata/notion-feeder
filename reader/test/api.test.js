import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ARTICLE_HTML, fakeFetch, minimalEpub, minimalPdf, startServer } from './helpers.js';
import { extractArticle } from '../src/extract.js';

let srv;

before(async () => {
  srv = await startServer({
    fetchImpl: fakeFetch({
      'https://blog.example.com/leer': { body: ARTICLE_HTML, headers: { 'content-type': 'text/html; charset=utf-8' } },
      'https://files.example.com/paper.pdf': { body: minimalPdf({ title: 'Paper remoto' }), headers: { 'content-type': 'application/pdf' } },
    }),
  });
});

after(() => srv.close());

test('saves an article from a URL as clean, sanitized HTML', async () => {
  const { status, data } = await srv.request('/api/documents/url', { method: 'POST', json: { url: 'https://blog.example.com/leer' } });
  assert.equal(status, 201);
  assert.equal(data.kind, 'article');
  assert.match(data.title, /Cómo leer mejor/);
  assert.equal(data.siteName, 'Blog de Lectura');
  assert.equal(data.status, 'inbox');
  assert.ok(data.wordCount > 100);

  const full = await srv.request(`/api/documents/${data.id}`);
  assert.doesNotMatch(full.data.contentHtml, /<script|onclick|alert/);
  assert.match(full.data.contentHtml, /href="https:\/\/blog\.example\.com\/notas"/, 'relative links become absolute');
  assert.match(full.data.contentHtml, /src="https:\/\/blog\.example\.com\/img\/foto\.jpg"/);
  assert.doesNotMatch(full.data.contentHtml, /Contacto|© 2026/, 'navigation and footer are dropped');
  assert.ok(full.data.lastOpenedAt);

  const again = await srv.request('/api/documents/url', { method: 'POST', json: { url: 'https://blog.example.com/leer' } });
  assert.equal(again.status, 200, 'saving the same URL twice returns the existing document');
  assert.equal(again.data.id, data.id);
});

test('a URL that points to a PDF is stored as a PDF', async () => {
  const { status, data } = await srv.request('/api/documents/url', { method: 'POST', json: { url: 'https://files.example.com/paper.pdf' } });
  assert.equal(status, 201);
  assert.equal(data.kind, 'pdf');
  assert.equal(data.title, 'Paper remoto');
});

test('rejects bad URLs', async () => {
  assert.equal((await srv.request('/api/documents/url', { method: 'POST', json: { url: 'file:///etc/passwd' } })).status, 400);
  assert.equal((await srv.request('/api/documents/url', { method: 'POST', json: { url: 'hola qué tal' } })).status, 400);
  const missing = await srv.request('/api/documents/url', { method: 'POST', json: { url: 'https://blog.example.com/404' } });
  assert.equal(missing.status, 422);
  assert.match(missing.data.error, /no existe \(error 404\)/);
  assert.equal((await srv.request('/api/documents/url', { method: 'POST', json: {} })).status, 400);
});

test('uploads a PDF, reads its metadata and serves the file back', async () => {
  const pdf = minimalPdf();
  const { status, data } = await srv.upload(pdf, 'mi_libro.pdf');
  assert.equal(status, 201);
  assert.equal(data.kind, 'pdf');
  assert.equal(data.title, 'Mi Libro PDF');
  assert.equal(data.author, 'Ana');
  assert.equal(data.originalName, 'mi_libro.pdf');

  const file = await fetch(`${srv.base}/api/documents/${data.id}/file`);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf);
});

test('uploads an EPUB and reads title, author and description', async () => {
  const { status, data } = await srv.upload(await minimalEpub(), 'libro.epub');
  assert.equal(status, 201);
  assert.equal(data.kind, 'epub');
  assert.equal(data.title, 'Cien años');
  assert.equal(data.author, 'Gabriel');
  assert.equal(data.excerpt, 'Una novela & más');
});

test('rejects files that are not PDF or EPUB, whatever their name', async () => {
  const { status } = await srv.upload(Buffer.from('hola, no soy un pdf'), 'falso.pdf');
  assert.equal(status, 415);
});

test('triage: status, favorite, progress, tags and filters', async () => {
  const { data: doc } = await srv.upload(minimalPdf({ title: 'Para filtrar' }), 'f.pdf');
  const { data: updated } = await srv.request(`/api/documents/${doc.id}`, {
    method: 'PATCH',
    json: { status: 'later', favorite: true, progress: 1.7, location: '3', tags: ['Filosofía', 'filosofía', ' ensayo '] },
  });
  assert.equal(updated.status, 'later');
  assert.equal(updated.favorite, true);
  assert.equal(updated.progress, 1, 'progress is clamped to 0..1');
  assert.deepEqual(updated.tags, ['ensayo', 'filosofía']);

  const later = (await srv.request('/api/documents?status=later')).data;
  assert.deepEqual(later.map((d) => d.id), [doc.id]);
  assert.equal((await srv.request('/api/documents?favorite=1')).data.length, 1);
  assert.equal((await srv.request('/api/documents?tag=ensayo')).data[0].id, doc.id);
  assert.equal((await srv.request('/api/documents?q=filtrar')).data[0].id, doc.id);
  assert.ok((await srv.request('/api/documents?kind=epub')).data.every((d) => d.kind === 'epub'));
  assert.deepEqual((await srv.request('/api/tags')).data, [
    { tag: 'ensayo', count: 1 },
    { tag: 'filosofía', count: 1 },
  ]);

  assert.equal((await srv.request(`/api/documents/${doc.id}`, { method: 'PATCH', json: { status: 'nope' } })).status, 400);
});

test('highlights: create, list, edit, export and cascade on delete', async () => {
  const { data: doc } = await srv.upload(await minimalEpub({ title: 'Con subrayados' }), 'h.epub');
  const created = await srv.request(`/api/documents/${doc.id}/highlights`, {
    method: 'POST',
    json: { text: 'Muchos años después', color: 'blue', anchor: { cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:19)' } },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.anchor, { cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:19)' });

  await srv.request(`/api/documents/${doc.id}/highlights`, {
    method: 'POST',
    json: { text: 'otra cita', anchor: { page: 4, rects: [] } },
  });
  const edited = await srv.request(`/api/highlights/${created.data.id}`, { method: 'PATCH', json: { note: 'Inicio famoso' } });
  assert.equal(edited.data.note, 'Inicio famoso');
  assert.equal(edited.data.color, 'blue');

  const list = await srv.request(`/api/documents/${doc.id}/highlights`);
  assert.equal(list.data.length, 2);
  const all = await srv.request('/api/highlights?q=famoso');
  assert.equal(all.data.length, 1);
  assert.equal(all.data[0].document.title, 'Con subrayados');

  const md = await srv.request(`/api/documents/${doc.id}/export`);
  assert.match(md.headers.get('content-type'), /text\/markdown/);
  assert.match(md.data, /^# Con subrayados/);
  assert.match(md.data, /> Muchos años después\n\n\*\*Nota:\*\* Inicio famoso/);
  assert.match(md.data, /> otra cita \(p\. 4\)/);

  assert.equal((await srv.request(`/api/documents/${doc.id}/highlights`, { method: 'POST', json: { text: 'x' } })).status, 400);

  assert.equal((await srv.request(`/api/documents/${doc.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await srv.request(`/api/documents/${doc.id}`)).status, 404);
  assert.equal((await srv.request(`/api/highlights/${created.data.id}`, { method: 'PATCH', json: { note: 'x' } })).status, 404);
  assert.equal((await fetch(`${srv.base}/api/documents/${doc.id}/file`)).status, 404);
});

test('serves the app shell and vendor libraries with a CSP', async () => {
  const home = await fetch(`${srv.base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(`${srv.base}/vendor/pdfjs/pdf.min.mjs`)).status, 200);
  assert.equal((await fetch(`${srv.base}/vendor/epubjs/epub.min.js`)).status, 200);
  assert.equal((await fetch(`${srv.base}/api/nada`)).status, 404);
});

test('saves a page sent as HTML by the browser extension', async () => {
  const url = 'https://members.example.com/post';
  const headers = { origin: 'chrome-extension://abcdefghijklmnop' };
  const { status, data } = await srv.request('/api/documents/html', { method: 'POST', headers, json: { url, html: ARTICLE_HTML } });
  assert.equal(status, 201);
  assert.equal(data.kind, 'article');
  assert.equal(data.url, url);
  assert.match(data.title, /Cómo leer mejor/);

  const full = await srv.request(`/api/documents/${data.id}`);
  assert.match(full.data.contentHtml, /href="https:\/\/members\.example\.com\/notas"/, 'links resolve against the page URL');
  assert.doesNotMatch(full.data.contentHtml, /<script/);

  const again = await srv.request('/api/documents/html', { method: 'POST', headers, json: { url, html: ARTICLE_HTML } });
  assert.equal(again.status, 200);
  assert.equal(again.data.id, data.id);

  assert.equal((await srv.request('/api/documents/html', { method: 'POST', json: { url: 'javascript:alert(1)', html: 'x' } })).status, 400);
  assert.equal((await srv.request('/api/documents/html', { method: 'POST', json: { url } })).status, 400, 'html is required');
  assert.equal((await srv.request('/api/documents/html', { method: 'POST', json: { url: 'https://n.example.com', html: '' } })).status, 400);
});

test('other websites cannot write to the library', async () => {
  const evil = { origin: 'https://evil.example.com' };
  assert.equal((await srv.request('/api/documents/url', { method: 'POST', headers: evil, json: { url: 'https://blog.example.com/leer' } })).status, 403);
  const form = new FormData();
  form.append('file', new Blob([minimalPdf()]), 'x.pdf');
  assert.equal((await srv.request('/api/documents/upload', { method: 'POST', headers: evil, body: form })).status, 403);
  assert.equal((await srv.request('/api/documents/1', { method: 'DELETE', headers: { origin: 'null' } })).status, 403);

  const sameOrigin = { origin: srv.base };
  assert.notEqual((await srv.request('/api/documents/html', { method: 'POST', headers: sameOrigin, json: {} })).status, 403);
  assert.equal((await srv.request('/api/documents', { headers: evil })).status, 200, 'reads are unaffected');
});

test('accepts links the way people paste them', async () => {
  const bare = await srv.request('/api/documents/url', { method: 'POST', json: { url: 'blog.example.com/leer' } });
  assert.ok([200, 201].includes(bare.status), 'missing https:// is added');
  assert.equal(bare.data.url, 'https://blog.example.com/leer');
  const inText = await srv.request('/api/documents/url', { method: 'POST', json: { url: 'Mira esto: https://blog.example.com/leer gracias' } });
  assert.equal(inText.data.id, bare.data.id, 'a link inside pasted text is found');
});

test('explains blocked and unreachable sites', async () => {
  const blocked = await startServer({ fetchImpl: async () => new Response('no', { status: 403 }) });
  const down = await startServer({
    fetchImpl: async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    },
  });
  try {
    const a = await blocked.request('/api/documents/url', { method: 'POST', json: { url: 'https://x.example.com/a' } });
    assert.equal(a.status, 422);
    assert.match(a.data.error, /no permite .* \(error 403\).*extensión/);
    const b = await down.request('/api/documents/url', { method: 'POST', json: { url: 'https://x.example.com/a' } });
    assert.match(b.data.error, /No se encontró ese sitio/);
  } finally {
    await blocked.close();
    await down.close();
  }
});

test('pages that are not a single article are still saved', () => {
  const home = `<!doctype html><html><head><title>Portada | Diario</title></head><body>
    <ul><li><a href="/a">Titular uno</a></li><li><a href="/b">Titular dos</a></li><li><a href="/c">Titular tres</a></li></ul>
    <script>x()</script></body></html>`;
  const result = extractArticle(home, 'https://diario.example.com/');
  assert.equal(result.title, 'Portada | Diario');
  assert.match(result.contentHtml, /Titular dos/);
  assert.doesNotMatch(result.contentHtml, /<script/);
  assert.throws(() => extractArticle('<html><body>   </body></html>', 'https://vacio.example.com/'), /no tiene texto/);
});

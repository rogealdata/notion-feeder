import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';
import tls from 'node:tls';

// Trust the operating system's certificates too (Node ≥ 22.19), so downloads keep working
// behind antivirus or company networks that inspect HTTPS traffic.
if (typeof tls.getCACertificates === 'function' && typeof tls.setDefaultCACertificates === 'function') {
  try {
    tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]);
  } catch {
    /* keep Node's bundled certificates */
  }
}

const MAX_HTML_BYTES = 15 * 1024 * 1024;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,application/epub+zip,*/*;q=0.8',
  'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
  'upgrade-insecure-requests': '1',
};

const purifyWindow = new JSDOM('').window;
const DOMPurify = createDOMPurify(purifyWindow);
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') {
    node.setAttribute('loading', 'lazy');
    node.setAttribute('referrerpolicy', 'no-referrer');
  }
});

export function sanitizeHtml(html) {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style', 'class', 'id'],
  });
}

export function countWords(text) {
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}

/** Turn a web page into a clean, sanitized article. */
export function extractArticle(html, url) {
  const virtualConsole = new VirtualConsole(); // swallow CSS/script parse noise
  const dom = new JSDOM(html, { url, virtualConsole });
  const doc = dom.window.document;
  const fallbackTitle = doc.title || new URL(url).hostname;
  // Readability edits the document, so keep a copy of the page for the fallback below.
  const bodyHtml = doc.body?.innerHTML || '';
  const parsed = new Readability(doc).parse();
  dom.window.close();

  if (!parsed?.content || !parsed.textContent?.trim()) {
    // Not an article (a home page, a list…): keep the whole page, cleaned, rather than failing.
    const contentHtml = sanitizeHtml(bodyHtml);
    const text = new JSDOM(contentHtml).window.document.body.textContent || '';
    if (!text.trim()) throw new Error('La página no tiene texto que se pueda guardar.');
    return {
      title: fallbackTitle.trim(),
      author: null,
      siteName: new URL(url).hostname.replace(/^www\./, ''),
      excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 200) || null,
      contentHtml,
      wordCount: countWords(text),
    };
  }

  return {
    title: (parsed.title || fallbackTitle).trim(),
    author: parsed.byline?.trim() || null,
    siteName: parsed.siteName?.trim() || new URL(url).hostname.replace(/^www\./, ''),
    excerpt: parsed.excerpt?.trim() || null,
    contentHtml: sanitizeHtml(parsed.content),
    wordCount: countWords(parsed.textContent || ''),
  };
}

async function readLimited(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (declared && declared > limit) throw new Error('El recurso es demasiado grande');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw new Error('El recurso es demasiado grande');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function filenameFromResponse(response, url) {
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match) return decodeURIComponent(match[1]);
  const last = new URL(url).pathname.split('/').filter(Boolean).pop();
  return last ? decodeURIComponent(last) : 'documento';
}

/**
 * Download a URL. Web pages come back as `{ type: 'html' }`; PDFs and EPUBs as
 * `{ type: 'file' }` so they can be stored like an upload.
 */
export async function fetchUrl(url, { fetchImpl = fetch } = {}) {
  const parsed = new URL(normalizeUrl(url));

  let response;
  try {
    response = await fetchImpl(parsed.href, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(describeNetworkError(err));
  }
  if (!response.ok) throw new Error(describeHttpStatus(response.status));

  const finalUrl = response.url || parsed.href;
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const looksLikeFile =
    contentType.includes('application/pdf') ||
    contentType.includes('application/epub') ||
    /\.(pdf|epub)$/i.test(new URL(finalUrl).pathname);

  if (looksLikeFile) {
    const buffer = await readLimited(response, MAX_FILE_BYTES);
    return { type: 'file', buffer, filename: filenameFromResponse(response, finalUrl), url: finalUrl };
  }

  const buffer = await readLimited(response, MAX_HTML_BYTES);
  return { type: 'html', html: decodeText(buffer, contentType), url: finalUrl };
}

function decodeText(buffer, contentType) {
  const charset = contentType.match(/charset=["']?([\w-]+)/)?.[1];
  try {
    return new TextDecoder(charset || 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * Accept what people actually paste: "elpais.com/…", "www.x.com", or text that contains a link.
 * Returns a full http(s) URL or throws a readable error.
 */
export function normalizeUrl(input) {
  let text = String(input || '').trim();
  const embedded = text.match(/https?:\/\/[^\s<>"']+/i);
  if (embedded) text = embedded[0];
  else if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/.test(text)) text = `https://${text}`;

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Eso no parece un enlace. Copia la dirección completa de la página, por ejemplo https://ejemplo.com/articulo');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Solo se pueden guardar enlaces web (que empiecen por http o https).');
  }
  return url.href;
}

const CERT_ERRORS = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const USE_EXTENSION = 'Ábrelo en el navegador y guárdalo con la extensión «Guardar en Reader».';

function describeNetworkError(err) {
  const code = err?.cause?.code || err?.code;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'El sitio tardó demasiado en responder. Inténtalo de nuevo.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'No se encontró ese sitio. Revisa el enlace y tu conexión a internet.';
  if (CERT_ERRORS.has(code)) {
    return `No se pudo verificar la conexión segura con el sitio (a veces lo causa un antivirus o la red de una empresa). ${USE_EXTENSION}`;
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return `El sitio cortó la conexión. ${USE_EXTENSION}`;
  return `No se pudo conectar con el sitio${code ? ` (${code})` : ''}. Revisa tu conexión a internet.`;
}

function describeHttpStatus(status) {
  if ([401, 403, 429, 503].includes(status)) {
    return `El sitio no permite que la app descargue sus páginas (error ${status}). ${USE_EXTENSION}`;
  }
  if (status === 404 || status === 410) return `Esa página no existe (error ${status}). Revisa el enlace.`;
  return `El sitio respondió con un error (${status}). Inténtalo más tarde.`;
}

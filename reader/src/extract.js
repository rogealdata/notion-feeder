import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';

const MAX_HTML_BYTES = 15 * 1024 * 1024;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

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
  const parsed = new Readability(doc).parse();
  dom.window.close();

  if (!parsed || !parsed.content) {
    throw new Error('No se pudo extraer el contenido del artículo');
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
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('URL no válida');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Solo se admiten URLs http(s)');
  }

  const response = await fetchImpl(parsed.href, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/pdf,application/epub+zip,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`La página respondió ${response.status}`);

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

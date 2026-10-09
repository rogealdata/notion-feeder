export const DEFAULT_SERVER = 'http://localhost:3000';

export async function getServer() {
  const { server } = await chrome.storage.sync.get('server');
  return (server || DEFAULT_SERVER).replace(/\/+$/, '');
}

export async function request(path, { method = 'GET', json } = {}) {
  const server = await getServer();
  let res;
  try {
    res = await fetch(server + path, {
      method,
      headers: json ? { 'content-type': 'application/json' } : undefined,
      body: json ? JSON.stringify(json) : undefined,
    });
  } catch {
    throw new Error(`No se pudo conectar con Reader en ${server}. ¿Está abierta la app (npm start)?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Reader respondió ${res.status}`);
  return { data, existed: res.status === 200 };
}

const isFileUrl = (url) => /\.(pdf|epub)$/i.test(new URL(url).pathname);

/** Save a link: Reader downloads it itself. */
export function saveUrl(url) {
  return request('/api/documents/url', { method: 'POST', json: { url } });
}

/** Save an open tab using the page as the browser shows it (works behind logins and for JS-built pages). */
export async function saveTab(tab) {
  if (!tab?.url || !/^https?:/i.test(tab.url)) {
    throw new Error('Solo se pueden guardar páginas web (http o https).');
  }
  if (isFileUrl(tab.url)) return saveUrl(tab.url);

  let page;
  try {
    [{ result: page }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ html: document.documentElement.outerHTML, contentType: document.contentType, url: location.href }),
    });
  } catch {
    // Pages the extension can't read (e.g. the built-in PDF viewer): let Reader download them.
    return saveUrl(tab.url);
  }
  if (!page || !/html|xml/i.test(page.contentType || '')) return saveUrl(tab.url);
  return request('/api/documents/html', { method: 'POST', json: { url: page.url, html: page.html } });
}

export function updateDocument(id, patch) {
  return request(`/api/documents/${id}`, { method: 'PATCH', json: patch });
}

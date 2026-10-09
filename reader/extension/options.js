import { DEFAULT_SERVER, getServer } from './lib.js';

const input = document.getElementById('server');
const status = document.getElementById('status');

function show(text, kind) {
  status.textContent = text;
  status.className = kind;
}

getServer().then((server) => (input.value = server));

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let url;
  try {
    url = new URL(input.value.trim() || DEFAULT_SERVER);
  } catch {
    return show('Escribe una dirección completa, por ejemplo http://localhost:3000', 'error');
  }
  const server = url.origin;

  // localhost is allowed out of the box; any other address needs the browser's permission.
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    const granted = await chrome.permissions.request({ origins: [`${server}/*`] });
    if (!granted) return show('Sin ese permiso la extensión no puede hablar con tu Reader.', 'error');
  }

  await chrome.storage.sync.set({ server });
  input.value = server;
  try {
    const res = await fetch(`${server}/api/tags`);
    if (!res.ok) throw new Error();
    show(`Conectado con Reader en ${server}.`, 'ok');
  } catch {
    show(`Guardado, pero no se pudo conectar con ${server}. ¿Está abierta la app?`, 'error');
  }
});

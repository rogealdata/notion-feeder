/** Tiny DOM helper: h('div.class', { attrs }, ...children). */
export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'html') el.innerHTML = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const PATHS = {
  inbox: 'M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6z',
  later: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  highlight: 'M4 20h6M14.5 4.5l5 5L11 18H6v-5z',
  tag: 'M3 12V4h8l9 9-8 8zM7.5 7.5h.01',
  back: 'M15 18l-6-6 6-6',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  panel: 'M4 4h16v16H4zM15 4v16',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  library: 'M4 4h4v16H4zM10 4h4v16h-4zM16 5l3.5-1 2.5 15.5-3.5 1z',
};

export function icon(name, filled = false) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name]);
  svg.append(path);
  return svg;
}

export function iconButton(name, label, onClick, extra = {}) {
  return h('button.btn.ghost.icon', { type: 'button', title: label, 'aria-label': label, onClick, ...extra }, icon(name, extra.filled));
}

export function toast(message, { error = false } = {}) {
  const el = h(`div.toast${error ? '.error' : ''}`, {}, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), error ? 6000 : 3000);
}

function openDialog(build) {
  return new Promise((resolve) => {
    const dialog = h('dialog');
    const close = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.append(...build(close));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Eliminar' }) {
  return openDialog((close) => [
    h('h3', {}, title),
    h('p', {}, message),
    h(
      'div.dialog-actions',
      {},
      h('button.btn', { type: 'button', onClick: () => close(false) }, 'Cancelar'),
      h('button.btn.primary', { type: 'button', onClick: () => close(true), autofocus: true }, confirmLabel),
    ),
  ]);
}

export function promptDialog({ title, message, value = '', placeholder = '', multiline = false, confirmLabel = 'Guardar' }) {
  return openDialog((close) => {
    const input = multiline
      ? h('textarea.field', { placeholder, id: 'prompt-input' })
      : h('input.field', { placeholder, id: 'prompt-input', type: 'text' });
    input.value = value;
    const form = h(
      'form',
      {
        method: 'dialog',
        onSubmit: (e) => {
          e.preventDefault();
          close(input.value);
        },
      },
      h('h3', {}, title),
      message && h('p', {}, message),
      input,
      h(
        'div.dialog-actions',
        {},
        h('button.btn', { type: 'button', onClick: () => close(null) }, 'Cancelar'),
        h('button.btn.primary', { type: 'submit' }, confirmLabel),
      ),
    );
    setTimeout(() => input.focus(), 0);
    return [form];
  });
}

export function debounce(fn, ms) {
  let timer;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return debounced;
}

export const KIND_LABEL = { article: 'WEB', pdf: 'PDF', epub: 'EPUB' };

export function formatDate(iso) {
  return new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function readingTime(words) {
  if (!words) return null;
  return `${Math.max(1, Math.round(words / 230))} min`;
}

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
  return null;
}

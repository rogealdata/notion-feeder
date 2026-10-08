import { api } from './api.js';
import { openReader } from './reader.js';
import {
  KIND_LABEL,
  confirmDialog,
  debounce,
  formatDate,
  h,
  icon,
  iconButton,
  promptDialog,
  readingTime,
  store,
  toast,
} from './ui.js';

const root = document.getElementById('app');
let cleanup = null;
let lastLibraryHash = '#/inbox';

const VIEWS = {
  inbox: { title: 'Bandeja de entrada', icon: 'inbox', query: { status: 'inbox' }, empty: 'Guarda un enlace o sube un PDF o EPUB para empezar.' },
  later: { title: 'Leer después', icon: 'later', query: { status: 'later' }, empty: 'Lo que marques para después aparecerá aquí.' },
  archive: { title: 'Archivo', icon: 'archive', query: { status: 'archive' }, empty: 'Los documentos terminados se guardan aquí.' },
  favorites: { title: 'Favoritos', icon: 'star', query: { favorite: 1 }, empty: 'Marca un documento con la estrella para verlo aquí.' },
  all: { title: 'Todo', icon: 'library', query: {}, empty: 'Tu biblioteca está vacía.' },
};

const libraryState = { kind: store('reader.kind') || '', q: '' };

// ---------- theme ----------

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(store('reader.theme'));

function themeToggle() {
  const isDark = () =>
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const btn = h('button.btn.ghost', { type: 'button' });
  const render = () => btn.replaceChildren(icon(isDark() ? 'sun' : 'moon'), isDark() ? 'Tema claro' : 'Tema oscuro');
  btn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    applyTheme(next);
    store('reader.theme', next);
    render();
  });
  render();
  return h('div.theme-switch', {}, btn);
}

// ---------- router ----------

function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').map(decodeURIComponent);
  if (parts[0] === 'read' && Number(parts[1])) {
    return { name: 'read', id: Number(parts[1]), highlightId: Number(new URLSearchParams(query).get('h')) || null };
  }
  if (parts[0] === 'tag' && parts[1]) return { name: 'tag', tag: parts[1] };
  if (parts[0] === 'highlights') return { name: 'highlights' };
  if (VIEWS[parts[0]]) return { name: parts[0] };
  return { name: 'inbox' };
}

async function route() {
  if (cleanup) {
    await cleanup();
    cleanup = null;
  }
  const r = parseRoute();
  if (r.name === 'read') {
    cleanup = await openReader(root, r.id, {
      highlightId: r.highlightId,
      onClose: () => (location.hash = lastLibraryHash),
    });
    return;
  }
  lastLibraryHash = location.hash || '#/inbox';
  renderLibrary(r);
}

window.addEventListener('hashchange', route);

// ---------- library ----------

async function renderSidebar(current) {
  const [tags, counts] = await Promise.all([
    api.tags().catch(() => []),
    Promise.all(['inbox', 'later'].map((s) => api.list({ status: s }).then((d) => d.length).catch(() => null))),
  ]);
  const count = { inbox: counts[0], later: counts[1] };
  const link = (key, label, iconName, n) =>
    h(
      'a',
      { href: `#/${key}`, 'aria-current': current === key ? 'page' : null },
      icon(iconName),
      label,
      n ? h('span.count', {}, n) : null,
    );
  return h(
    'aside.sidebar',
    {},
    h('div.brand', {}, h('span.brand-mark'), 'Reader'),
    h(
      'nav.nav',
      { 'aria-label': 'Biblioteca' },
      h('div.nav-label', {}, 'Biblioteca'),
      link('inbox', 'Bandeja', 'inbox', count.inbox),
      link('later', 'Después', 'later', count.later),
      link('archive', 'Archivo', 'archive'),
      link('favorites', 'Favoritos', 'star'),
      link('all', 'Todo', 'library'),
      link('highlights', 'Subrayados', 'highlight'),
    ),
    tags.length
      ? h(
          'nav.nav',
          { 'aria-label': 'Etiquetas' },
          h('div.nav-label', {}, 'Etiquetas'),
          tags.map((t) =>
            h(
              'a',
              { href: `#/tag/${encodeURIComponent(t.tag)}`, 'aria-current': current === `tag:${t.tag}` ? 'page' : null },
              icon('tag'),
              t.tag,
              h('span.count', {}, t.count),
            ),
          ),
        )
      : null,
    themeToggle(),
  );
}

function addBar(onAdded) {
  const input = h('input.field', { type: 'url', id: 'add-url', placeholder: 'Pega un enlace a un artículo, PDF o EPUB…', required: true });
  const saveBtn = h('button.btn.primary', { type: 'submit' }, icon('plus'), 'Guardar');
  const fileInput = h('input', { type: 'file', accept: '.pdf,.epub,application/pdf,application/epub+zip', multiple: true, hidden: true });
  fileInput.addEventListener('change', () => {
    uploadFiles([...fileInput.files], onAdded);
    fileInput.value = '';
  });
  const form = h(
    'form.add-bar',
    {
      onSubmit: async (e) => {
        e.preventDefault();
        const url = input.value.trim();
        if (!url) return;
        saveBtn.disabled = true;
        saveBtn.lastChild.textContent = 'Guardando…';
        try {
          const doc = await api.saveUrl(url);
          input.value = '';
          toast(`Guardado: ${doc.title}`);
          onAdded();
        } catch (err) {
          toast(err.message, { error: true });
        } finally {
          saveBtn.disabled = false;
          saveBtn.lastChild.textContent = 'Guardar';
        }
      },
    },
    input,
    saveBtn,
    h('button.btn', { type: 'button', onClick: () => fileInput.click() }, icon('upload'), 'Subir PDF / EPUB'),
    fileInput,
  );
  return form;
}

async function uploadFiles(files, onAdded) {
  for (const file of files) {
    toast(`Subiendo ${file.name}…`);
    try {
      const doc = await api.upload(file);
      toast(`Añadido: ${doc.title}`);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, { error: true });
    }
  }
  onAdded();
}

function docRow(doc, refresh) {
  const pct = Math.round((doc.progress || 0) * 100);
  const meta = [
    doc.author,
    doc.siteName,
    doc.kind === 'article' ? readingTime(doc.wordCount) : null,
    pct ? h('span.num', {}, `${pct}% leído`) : null,
    doc.highlightCount ? h('span.num', {}, `${doc.highlightCount} subrayado${doc.highlightCount === 1 ? '' : 's'}`) : null,
    formatDate(doc.createdAt),
  ].filter(Boolean);

  const act = (fn) => async (e) => {
    e.stopPropagation();
    try {
      await fn();
      refresh();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  const move = (status, label) => act(async () => {
    await api.update(doc.id, { status });
    toast(`Movido a ${label}`);
  });

  return h(
    'li.doc',
    {
      tabindex: 0,
      onClick: () => (location.hash = `#/read/${doc.id}`),
      onKeydown: (e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) location.hash = `#/read/${doc.id}`;
      },
    },
    h('div.kind', { 'data-kind': doc.kind, style: { '--progress': `${pct}%` } }, KIND_LABEL[doc.kind]),
    h(
      'div.doc-body',
      {},
      h('div.doc-title', {}, doc.title),
      h('div.doc-meta', {}, meta.map((m) => (typeof m === 'string' ? h('span', {}, m) : m))),
      doc.tags.length ? h('div.chips', {}, doc.tags.map((t) => h('span.chip', {}, t))) : null,
    ),
    h(
      'div.doc-actions',
      {},
      doc.status !== 'later' && iconButton('later', 'Leer después', move('later', 'Leer después')),
      doc.status !== 'archive' && iconButton('archive', 'Archivar', move('archive', 'Archivo')),
      doc.status === 'archive' && iconButton('inbox', 'Devolver a la bandeja', move('inbox', 'Bandeja')),
      iconButton(
        'star',
        doc.favorite ? 'Quitar de favoritos' : 'Añadir a favoritos',
        act(() => api.update(doc.id, { favorite: !doc.favorite })),
        { 'aria-pressed': String(doc.favorite), filled: doc.favorite },
      ),
      iconButton(
        'tag',
        'Editar etiquetas',
        act(async () => {
          const value = await promptDialog({
            title: 'Etiquetas',
            message: 'Separa las etiquetas con comas.',
            value: doc.tags.join(', '),
            placeholder: 'filosofía, trabajo, novela',
          });
          if (value !== null) await api.update(doc.id, { tags: value.split(',') });
        }),
      ),
      iconButton(
        'trash',
        'Eliminar',
        act(async () => {
          const ok = await confirmDialog({
            title: '¿Eliminar este documento?',
            message: `Se borrarán «${doc.title}» y sus subrayados. No se puede deshacer.`,
          });
          if (ok) {
            await api.remove(doc.id);
            toast('Documento eliminado');
          }
        }),
        { class: 'btn ghost icon danger' },
      ),
    ),
  );
}

async function renderLibrary(r) {
  if (r.name === 'highlights') return renderHighlights();
  const view = r.name === 'tag' ? { title: `#${r.tag}`, query: { tag: r.tag }, empty: 'No hay documentos con esta etiqueta.' } : VIEWS[r.name];
  const current = r.name === 'tag' ? `tag:${r.tag}` : r.name;

  const list = h('ul.doc-list', { hidden: true });
  const empty = h('div.empty', { hidden: true });
  const sub = h('span.sub');

  const load = async () => {
    try {
      const docs = await api.list({ ...view.query, kind: libraryState.kind, q: libraryState.q });
      list.replaceChildren(...docs.map((d) => docRow(d, refresh)));
      list.hidden = !docs.length;
      empty.hidden = Boolean(docs.length);
      empty.replaceChildren(
        h('strong', {}, libraryState.q || libraryState.kind ? 'Nada coincide con el filtro' : 'Aquí no hay nada todavía'),
        h('span', {}, libraryState.q || libraryState.kind ? 'Prueba con otra búsqueda o tipo.' : view.empty),
      );
      sub.textContent = `${docs.length} documento${docs.length === 1 ? '' : 's'}`;
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  const refresh = async () => {
    await load();
    const sidebar = await renderSidebar(current);
    root.querySelector('.sidebar')?.replaceWith(sidebar);
  };

  const kindButtons = [
    ['', 'Todo'],
    ['article', 'Artículos'],
    ['pdf', 'PDF'],
    ['epub', 'EPUB'],
  ].map(([kind, label]) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String(libraryState.kind === kind),
        onClick: (e) => {
          libraryState.kind = kind;
          store('reader.kind', kind);
          for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
          load();
        },
      },
      label,
    ),
  );
  const search = h('input.field', { type: 'search', id: 'library-search', placeholder: 'Buscar título o autor', value: libraryState.q });
  search.addEventListener(
    'input',
    debounce(() => {
      libraryState.q = search.value.trim();
      load();
    }, 200),
  );

  root.replaceChildren(
    h(
      'div.library',
      {},
      await renderSidebar(current),
      h(
        'main.main',
        {},
        h(
          'div.main-inner',
          {},
          h('div.page-head', {}, h('h1', {}, view.title), sub),
          addBar(refresh),
          h('div.filters', {}, h('div.segmented', { role: 'group', 'aria-label': 'Tipo' }, kindButtons), search),
          list,
          empty,
        ),
      ),
    ),
  );
  document.title = `${view.title} · Reader`;
  await load();
  libraryRefresh = refresh;
}

let libraryRefresh = null;

// ---------- highlights page ----------

async function renderHighlights() {
  const listEl = h('div.hl-list');
  const sub = h('span.sub');
  const load = async (q) => {
    const items = await api.allHighlights(q);
    sub.textContent = `${items.length} subrayado${items.length === 1 ? '' : 's'}`;
    listEl.replaceChildren(
      ...(items.length
        ? items.map((hl) =>
            h(
              'article.hl-card',
              { 'data-color': hl.color },
              h('blockquote.hl-quote', {}, hl.text),
              hl.note ? h('div.hl-note', {}, hl.note) : null,
              h(
                'div.hl-source',
                {},
                h('a', { href: `#/read/${hl.document.id}?h=${hl.id}` }, hl.document.title),
                hl.document.author ? ` · ${hl.document.author}` : '',
                hl.anchor?.page ? ` · p. ${hl.anchor.page}` : '',
                ` · ${formatDate(hl.createdAt)}`,
              ),
            ),
          )
        : [
            h(
              'div.empty',
              {},
              h('strong', {}, q ? 'Ningún subrayado coincide' : 'Aún no has subrayado nada'),
              h('span', {}, 'Selecciona texto mientras lees y elige un color.'),
            ),
          ]),
    );
  };
  const search = h('input.field', { type: 'search', id: 'highlight-search', placeholder: 'Buscar en subrayados y notas' });
  search.addEventListener('input', debounce(() => load(search.value.trim()), 200));

  root.replaceChildren(
    h(
      'div.library',
      {},
      await renderSidebar('highlights'),
      h(
        'main.main',
        {},
        h('div.main-inner', {}, h('div.page-head', {}, h('h1', {}, 'Subrayados'), sub), h('div.filters.solo', {}, search), listEl),
      ),
    ),
  );
  document.title = 'Subrayados · Reader';
  await load();
}

// ---------- drag & drop uploads ----------

const dropzone = document.getElementById('dropzone');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || parseRoute().name === 'read') return;
  dragDepth += 1;
  dropzone.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropzone.hidden = true;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropzone.hidden = true;
  if (parseRoute().name === 'read') return;
  uploadFiles([...e.dataTransfer.files], () => libraryRefresh?.());
});

route();

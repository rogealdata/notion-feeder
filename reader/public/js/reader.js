import { api } from './api.js';
import { debounce, h, icon, iconButton, promptDialog, store, toast } from './ui.js';

const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'];
const COLOR_NAMES = { yellow: 'Amarillo', green: 'Verde', blue: 'Azul', pink: 'Rosa', purple: 'Morado' };
const READING_THEMES = [
  ['', 'Papel'],
  ['sepia', 'Sepia'],
  ['night', 'Noche'],
];

const VIEWERS = {
  article: () => import('./viewer-article.js'),
  pdf: () => import('./viewer-pdf.js'),
  epub: () => import('./viewer-epub.js'),
};

/** Open a document full-screen. Resolves to a cleanup function. */
export async function openReader(root, id, { onClose, highlightId } = {}) {
  root.replaceChildren(h('div.loading', {}, 'Abriendo…'));
  let doc;
  let highlights;
  try {
    [doc, highlights] = await Promise.all([api.get(id), api.highlights(id)]);
  } catch (err) {
    toast(err.message, { error: true });
    onClose();
    return () => {};
  }
  document.title = `${doc.title} · Reader`;

  // ---------- progress ----------
  const progressText = h('span.reader-progress', {}, `${Math.round(doc.progress * 100)}%`);
  const progressLine = h('div.progress-line', { style: { width: `${doc.progress * 100}%` } });
  const saveProgress = debounce((progress, location) => {
    api.update(doc.id, { progress, location }).catch(() => {});
  }, 800);
  let lastProgress = null;
  const onProgress = (progress, location) => {
    if (!Number.isFinite(progress)) return;
    progressText.textContent = `${Math.round(progress * 100)}%`;
    progressLine.style.width = `${progress * 100}%`;
    lastProgress = [progress, location];
    saveProgress(progress, location);
  };

  // ---------- status buttons ----------
  const statusBtn = (status, iconName, label) => {
    const btn = iconButton(iconName, label, async () => {
      const next = doc.status === status ? 'inbox' : status;
      try {
        doc = { ...doc, ...(await api.update(doc.id, { status: next })) };
        syncStatus();
        toast(next === 'inbox' ? 'Devuelto a la bandeja' : `Movido a ${label}`);
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
    btn.dataset.status = status;
    return btn;
  };
  const laterBtn = statusBtn('later', 'later', 'Leer después');
  const archiveBtn = statusBtn('archive', 'archive', 'Archivo');
  const favBtn = iconButton('star', 'Favorito', async () => {
    try {
      doc = { ...doc, ...(await api.update(doc.id, { favorite: !doc.favorite })) };
      syncStatus();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  function syncStatus() {
    laterBtn.setAttribute('aria-pressed', String(doc.status === 'later'));
    archiveBtn.setAttribute('aria-pressed', String(doc.status === 'archive'));
    favBtn.setAttribute('aria-pressed', String(doc.favorite));
    favBtn.replaceChildren(icon('star', doc.favorite));
  }
  syncStatus();

  // ---------- layout ----------
  const viewerEl = h('div.viewer', { id: 'viewer' });
  const panel = h('aside.panel', { 'aria-label': 'Subrayados' });
  const panelOpen = store('reader.panel') !== 'closed' && matchMedia('(min-width: 901px)').matches;
  panel.hidden = !panelOpen;
  const panelBtn = iconButton('panel', 'Mostrar subrayados', () => {
    panel.hidden = !panel.hidden;
    panelBtn.setAttribute('aria-pressed', String(!panel.hidden));
    store('reader.panel', panel.hidden ? 'closed' : 'open');
  });
  panelBtn.setAttribute('aria-pressed', String(!panel.hidden));

  let viewer = null;
  const readerEl = h('div.reader', { 'data-kind': doc.kind });
  let readingTheme = store('reader.readingTheme') || '';
  const applyReadingTheme = () => {
    if (readingTheme) readerEl.dataset.reading = readingTheme;
    else delete readerEl.dataset.reading;
    viewer?.setReadingTheme?.(readingTheme);
  };
  const themeBtn = h(
    'button.btn.ghost.hide-sm',
    {
      type: 'button',
      title: 'Fondo de lectura',
      onClick: () => {
        const i = READING_THEMES.findIndex(([k]) => k === readingTheme);
        [readingTheme] = READING_THEMES[(i + 1) % READING_THEMES.length];
        store('reader.readingTheme', readingTheme);
        themeBtn.lastChild.textContent = READING_THEMES.find(([k]) => k === readingTheme)[1];
        applyReadingTheme();
      },
    },
    icon('sun'),
    READING_THEMES.find(([k]) => k === readingTheme)?.[1] || 'Papel',
  );

  const extraControls = h('div.bar-group');
  readerEl.append(
    h(
      'div',
      {},
      h(
        'header.reader-bar',
        {},
        iconButton('back', 'Volver a la biblioteca', () => onClose()),
        h('div.reader-title', { title: doc.title }, doc.title),
        progressText,
        h('span.bar-sep.hide-sm'),
        extraControls,
        h('span.bar-sep.hide-sm'),
        themeBtn,
        laterBtn,
        archiveBtn,
        favBtn,
        h('a.btn.ghost.icon.hide-sm', { href: api.exportUrl(doc.id), title: 'Exportar subrayados (Markdown)', 'aria-label': 'Exportar subrayados' }, icon('download')),
        doc.url ? h('a.btn.ghost.icon.hide-sm', { href: doc.url, target: '_blank', rel: 'noopener noreferrer', title: 'Abrir original', 'aria-label': 'Abrir original' }, icon('external')) : null,
        panelBtn,
      ),
      progressLine,
    ),
    h('div.reader-body', {}, viewerEl, panel),
  );
  root.replaceChildren(readerEl);
  if (readingTheme) readerEl.dataset.reading = readingTheme;

  // ---------- selection toolbar ----------
  let pendingSelection = null;
  const selToolbar = h(
    'div.sel-toolbar',
    { hidden: true, role: 'toolbar', 'aria-label': 'Subrayar' },
    COLORS.map((color) =>
      h('button.swatch', {
        type: 'button',
        'data-color': color,
        title: `Subrayar en ${COLOR_NAMES[color].toLowerCase()}`,
        'aria-label': `Subrayar en ${COLOR_NAMES[color].toLowerCase()}`,
        onMousedown: (e) => e.preventDefault(),
        onClick: () => createHighlight(color),
      }),
    ),
    h('button.note-btn', { type: 'button', onMousedown: (e) => e.preventDefault(), onClick: () => createHighlight('yellow', true) }, '+ Nota'),
  );
  document.body.append(selToolbar);

  const onSelect = (sel) => {
    pendingSelection = sel;
    if (!sel) {
      selToolbar.hidden = true;
      return;
    }
    const top = Math.max(56, sel.rect.top);
    selToolbar.style.left = `${Math.min(window.innerWidth - 130, Math.max(130, sel.rect.left + sel.rect.width / 2))}px`;
    selToolbar.style.top = `${top}px`;
    selToolbar.hidden = false;
  };

  async function createHighlight(color, withNote = false) {
    const sel = pendingSelection;
    if (!sel) return;
    onSelect(null);
    sel.clear?.();
    let note = null;
    if (withNote) {
      note = await promptDialog({ title: 'Añadir nota', value: '', multiline: true, placeholder: '¿Qué te hizo pensar esto?' });
      if (note === null) return;
    }
    try {
      const created = await api.addHighlight(doc.id, { text: sel.text, anchor: sel.anchor, color, note: note || null });
      highlights.push(created);
      viewer.addHighlight(created);
      renderPanel();
      if (panel.hidden && withNote) panelBtn.click();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  // ---------- highlights panel ----------
  function renderPanel() {
    const sorted = viewer?.compare ? [...highlights].sort(viewer.compare) : highlights;
    panel.replaceChildren(
      h('h2', {}, `Subrayados · ${highlights.length}`),
      ...(sorted.length
        ? sorted.map(panelItem)
        : [h('p.panel-empty', {}, 'Selecciona texto para subrayarlo. Tus notas aparecerán aquí y podrás exportarlas en Markdown.')]),
    );
  }

  function panelItem(hl) {
    const note = h('textarea', { placeholder: 'Añadir nota…', rows: 1, 'aria-label': 'Nota' });
    note.value = hl.note || '';
    const saveNote = debounce(async () => {
      try {
        Object.assign(hl, await api.updateHighlight(hl.id, { note: note.value }));
      } catch (err) {
        toast(err.message, { error: true });
      }
    }, 600);
    note.addEventListener('input', saveNote);
    note.addEventListener('blur', () => saveNote.flush());

    const colorDots = COLORS.map((color) =>
      h('button.swatch', {
        type: 'button',
        'data-color': color,
        title: COLOR_NAMES[color],
        'aria-label': `Cambiar a ${COLOR_NAMES[color].toLowerCase()}`,
        style: { width: '14px', height: '14px', borderWidth: color === hl.color ? '2px' : '0', borderColor: 'var(--ink)' },
        onClick: async () => {
          try {
            Object.assign(hl, await api.updateHighlight(hl.id, { color }));
            viewer.updateHighlight(hl);
            renderPanel();
          } catch (err) {
            toast(err.message, { error: true });
          }
        },
      }),
    );

    return h(
      'div.panel-item',
      { 'data-color': hl.color, 'data-id': hl.id },
      h('blockquote', { title: 'Ir al subrayado', onClick: () => viewer.goTo(hl) }, hl.text),
      note,
      h(
        'div.row',
        {},
        colorDots,
        hl.anchor?.page ? h('span', {}, `p. ${hl.anchor.page}`) : null,
        h(
          'button.btn.ghost.danger',
          {
            type: 'button',
            onClick: async () => {
              try {
                await api.removeHighlight(hl.id);
                highlights = highlights.filter((x) => x.id !== hl.id);
                viewer.removeHighlight(hl);
                renderPanel();
              } catch (err) {
                toast(err.message, { error: true });
              }
            },
          },
          'Quitar',
        ),
      ),
    );
  }

  const onHighlightClick = (hl) => {
    if (panel.hidden) panelBtn.click();
    const item = panel.querySelector(`[data-id="${hl.id}"]`);
    item?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    item?.querySelector('textarea')?.focus({ preventScroll: true });
  };

  // ---------- mount viewer ----------
  try {
    const mod = await VIEWERS[doc.kind]();
    viewer = await mod.mount({ container: viewerEl, doc, highlights, onSelect, onProgress, onHighlightClick, readingTheme });
    extraControls.replaceChildren(...(viewer.controls || []));
  } catch (err) {
    console.error(err);
    viewerEl.replaceChildren(h('div.loading', {}, `No se pudo abrir el documento: ${err.message}`));
  }
  renderPanel();
  if (highlightId) {
    const target = highlights.find((x) => x.id === highlightId);
    if (target) setTimeout(() => viewer?.goTo(target), 150);
  }

  const onKey = (e) => {
    if (e.key === 'Escape') {
      if (!selToolbar.hidden) onSelect(null);
      else if (!e.target.closest?.('textarea, input, dialog')) onClose();
    }
  };
  document.addEventListener('keydown', onKey);

  return async () => {
    document.removeEventListener('keydown', onKey);
    selToolbar.remove();
    if (lastProgress) saveProgress.flush(...lastProgress);
    await viewer?.destroy?.();
  };
}

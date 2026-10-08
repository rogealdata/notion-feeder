import { h, store } from './ui.js';

const MIN_SIZE = 80;
const MAX_SIZE = 180;

function cssVar(el, name) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

export async function mount({ container, doc, highlights, onSelect, onProgress, onHighlightClick }) {
  if (!window.ePub) throw new Error('epub.js no está cargado');
  const readerEl = container.closest('.reader') || document.documentElement;

  const stage = h('div.epub-stage');
  const prevBtn = h('button.epub-nav', { type: 'button', 'aria-label': 'Página anterior', title: 'Página anterior (←)' }, '‹');
  const nextBtn = h('button.epub-nav', { type: 'button', 'aria-label': 'Página siguiente', title: 'Página siguiente (→)' }, '›');
  container.style.overflow = 'hidden';
  container.replaceChildren(h('div.epub-wrap', {}, prevBtn, stage, nextBtn));

  const data = await fetch(`/api/documents/${doc.id}/file`).then((r) => {
    if (!r.ok) throw new Error('No se pudo descargar el libro');
    return r.arrayBuffer();
  });
  const book = window.ePub(data);
  const rendition = book.renderTo(stage, {
    width: '100%',
    height: '100%',
    flow: 'paginated',
    spread: 'auto',
    minSpreadWidth: 1100,
    allowScriptedContent: false,
  });

  // ---------- typography & colors ----------
  let size = Number(store('reader.epubSize')) || 110;
  function applyTheme() {
    rendition.themes.override('color', cssVar(readerEl, '--read-ink'), true);
    rendition.themes.override('background', 'transparent', true);
    rendition.themes.fontSize(`${size}%`);
  }
  rendition.themes.default({
    body: { 'line-height': '1.6 !important', 'font-family': 'Charter, "Iowan Old Style", Cambria, Georgia, serif' },
    a: { color: 'inherit !important' },
    '::selection': { background: 'rgba(43, 78, 162, 0.3)' },
  });
  applyTheme();

  const sizeBtn = (delta, label, text) =>
    h(
      'button.btn.ghost',
      {
        type: 'button',
        title: label,
        'aria-label': label,
        onClick: () => {
          size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, size + delta));
          store('reader.epubSize', String(size));
          applyTheme();
        },
      },
      text,
    );

  // ---------- table of contents ----------
  const toc = h('select.field.toc-select.hide-sm', { 'aria-label': 'Índice', id: 'epub-toc' });
  toc.append(h('option', { value: '' }, 'Índice'));
  book.loaded.navigation
    .then((nav) => {
      const add = (items, depth) => {
        for (const item of items) {
          toc.append(h('option', { value: item.href }, `${'  '.repeat(depth)}${item.label.trim()}`));
          if (item.subitems?.length) add(item.subitems, depth + 1);
        }
      };
      add(nav.toc, 0);
    })
    .catch(() => {});
  toc.addEventListener('change', () => {
    if (toc.value) rendition.display(toc.value);
    toc.value = '';
  });

  // ---------- highlights ----------
  const hlColor = (color) => cssVar(document.documentElement, `--hl-${color}`) || '#ffd84d';
  const drawn = new Map();
  function drawHighlight(hl) {
    rendition.annotations.highlight(
      hl.anchor.cfi,
      { id: hl.id },
      () => onHighlightClick(hl),
      `hl-${hl.id}`,
      { fill: hlColor(hl.color), 'fill-opacity': '0.45', 'mix-blend-mode': 'multiply' },
    );
    drawn.set(hl.id, hl.anchor.cfi);
  }
  function eraseHighlight(hl) {
    const cfi = drawn.get(hl.id);
    if (cfi) rendition.annotations.remove(cfi, 'highlight');
    drawn.delete(hl.id);
  }
  highlights.forEach((hl) => hl.anchor?.cfi && drawHighlight(hl));

  rendition.on('selected', (cfiRange, contents) => {
    const range = rendition.getRange(cfiRange);
    const text = range?.toString().replace(/\s+/g, ' ').trim();
    if (!text) return onSelect(null);
    const frame = contents.window.frameElement?.getBoundingClientRect() || { left: 0, top: 0 };
    const r = range.getBoundingClientRect();
    onSelect({
      text,
      anchor: { cfi: cfiRange },
      rect: { left: frame.left + r.left, top: frame.top + r.top, width: r.width, height: r.height },
      clear: () => contents.window.getSelection()?.removeAllRanges(),
    });
  });
  rendition.on('click', () => onSelect(null));

  // ---------- navigation ----------
  const prev = () => (onSelect(null), rendition.prev());
  const next = () => (onSelect(null), rendition.next());
  prevBtn.addEventListener('click', prev);
  nextBtn.addEventListener('click', next);
  const onKey = (e) => {
    if (e.target.closest?.('input, textarea, select, dialog')) return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev();
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') next();
  };
  document.addEventListener('keyup', onKey);
  rendition.on('keyup', onKey);

  // ---------- progress ----------
  let locationsReady = false;
  let lastCfi = doc.location || null;
  const report = (cfi) => {
    lastCfi = cfi;
    const pct = locationsReady ? book.locations.percentageFromCfi(cfi) : doc.progress;
    onProgress(pct, cfi);
  };
  rendition.on('relocated', (loc) => {
    report(loc.atEnd ? loc.end.cfi : loc.start.cfi);
    if (loc.atEnd && locationsReady) onProgress(1, loc.end.cfi);
  });
  book.ready
    .then(() => book.locations.generate(1600))
    .then(() => {
      locationsReady = true;
      if (lastCfi) report(lastCfi);
    })
    .catch(() => {});

  // Restore the last position; fall back to the start if the saved CFI no longer resolves.
  await rendition.display(doc.location || undefined).catch(() => rendition.display());

  // Keep colors in sync if the app theme changes while reading.
  const media = matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', applyTheme);

  let compareCfi = null;
  try {
    compareCfi = new window.ePub.CFI();
  } catch {
    /* sorting falls back to creation order */
  }

  return {
    controls: [toc, sizeBtn(-10, 'Letra más pequeña', 'A−'), sizeBtn(10, 'Letra más grande', 'A+')],
    compare: compareCfi ? (a, b) => compareCfi.compare(a.anchor.cfi, b.anchor.cfi) : undefined,
    setReadingTheme: () => applyTheme(),
    addHighlight: drawHighlight,
    removeHighlight: eraseHighlight,
    updateHighlight(hl) {
      eraseHighlight(hl);
      drawHighlight(hl);
    },
    goTo(hl) {
      rendition.display(hl.anchor.cfi);
    },
    destroy() {
      document.removeEventListener('keyup', onKey);
      media.removeEventListener('change', applyTheme);
      rendition.destroy();
      book.destroy();
    },
  };
}

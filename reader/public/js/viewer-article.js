import { formatDate, h, readingTime, store } from './ui.js';

const MIN_SIZE = 15;
const MAX_SIZE = 28;

/** Character offset of (node, offset) within root's text. */
function textOffset(root, node, offset) {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

const normalize = (s) => s.replace(/\s+/g, ' ').trim();

/** Find where a highlight lives now; fall back to searching its quote if the offsets drifted. */
function locate(root, hl) {
  const full = root.textContent;
  const { start, end } = hl.anchor;
  if (Number.isInteger(start) && Number.isInteger(end) && normalize(full.slice(start, end)) === normalize(hl.text)) {
    return { start, end };
  }
  const index = full.indexOf(hl.text);
  return index === -1 ? null : { start: index, end: index + hl.text.length };
}

function wrap(root, hl, onClick) {
  const pos = locate(root, hl);
  if (!pos) return false;
  let cursor = 0;
  for (const node of textNodes(root)) {
    const len = node.data.length;
    const nodeStart = cursor;
    cursor += len;
    if (cursor <= pos.start) continue;
    if (nodeStart >= pos.end) break;
    const from = Math.max(0, pos.start - nodeStart);
    const to = Math.min(len, pos.end - nodeStart);
    if (!node.data.slice(from, to).trim()) continue;
    let target = node;
    if (from > 0) target = target.splitText(from);
    if (to - from < target.data.length) target.splitText(to - from);
    const mark = h('mark.hl', { 'data-hid': hl.id, 'data-color': hl.color, onClick: (e) => (e.stopPropagation(), onClick(hl)) });
    target.replaceWith(mark);
    mark.append(target);
  }
  return true;
}

function unwrap(root, id) {
  for (const mark of root.querySelectorAll(`mark[data-hid="${id}"]`)) {
    const parent = mark.parentNode;
    mark.replaceWith(...mark.childNodes);
    parent.normalize();
  }
}

export async function mount({ container, doc, highlights, onSelect, onProgress, onHighlightClick }) {
  const content = h('div.article-content', { html: doc.contentHtml || '' });
  const byline = [doc.author, doc.siteName, readingTime(doc.wordCount), formatDate(doc.createdAt)].filter(Boolean);
  const article = h(
    'article.article',
    {},
    h(
      'header.article-head',
      {},
      h('h1', {}, doc.title),
      h('div.byline', {}, byline.map((b) => h('span', {}, b))),
    ),
    content,
  );
  container.replaceChildren(article);

  let size = Number(store('reader.fontSize')) || 20;
  const applySize = () => article.style.setProperty('--read-size', `${size}px`);
  applySize();
  const sizeBtn = (delta, label, text) =>
    h(
      'button.btn.ghost',
      {
        type: 'button',
        title: label,
        'aria-label': label,
        onClick: () => {
          size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, size + delta));
          store('reader.fontSize', String(size));
          applySize();
        },
      },
      text,
    );

  for (const hl of highlights) wrap(content, hl, onHighlightClick);

  // Restore reading position once layout settles.
  const restore = Number(doc.location);
  if (restore > 0) {
    requestAnimationFrame(() => {
      container.scrollTop = restore * (container.scrollHeight - container.clientHeight);
    });
  }

  const onScroll = () => {
    const max = container.scrollHeight - container.clientHeight;
    const progress = max > 0 ? container.scrollTop / max : 1;
    onProgress(progress, progress.toFixed(4));
    onSelect(null);
  };
  container.addEventListener('scroll', onScroll, { passive: true });

  let selTimer;
  const onSelectionChange = () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return onSelect(null);
      const range = sel.getRangeAt(0);
      if (!content.contains(range.commonAncestorContainer)) return onSelect(null);
      const text = range.toString();
      if (!text.trim()) return onSelect(null);
      onSelect({
        text: text.trim(),
        anchor: {
          start: textOffset(content, range.startContainer, range.startOffset),
          end: textOffset(content, range.endContainer, range.endOffset),
        },
        rect: range.getBoundingClientRect(),
        clear: () => sel.removeAllRanges(),
      });
    }, 220);
  };
  document.addEventListener('selectionchange', onSelectionChange);

  return {
    controls: [sizeBtn(-1, 'Letra más pequeña', 'A−'), sizeBtn(1, 'Letra más grande', 'A+')],
    compare: (a, b) => (a.anchor.start ?? 0) - (b.anchor.start ?? 0),
    addHighlight(hl) {
      if (!wrap(content, hl, onHighlightClick)) console.warn('No se encontró el texto del subrayado', hl.id);
    },
    removeHighlight(hl) {
      unwrap(content, hl.id);
    },
    updateHighlight(hl) {
      for (const mark of content.querySelectorAll(`mark[data-hid="${hl.id}"]`)) mark.dataset.color = hl.color;
    },
    goTo(hl) {
      const marks = content.querySelectorAll(`mark[data-hid="${hl.id}"]`);
      if (!marks.length) return;
      marks[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      for (const m of marks) m.classList.add('flash');
      setTimeout(() => marks.forEach((m) => m.classList.remove('flash')), 1500);
    },
    destroy() {
      clearTimeout(selTimer);
      document.removeEventListener('selectionchange', onSelectionChange);
      container.removeEventListener('scroll', onScroll);
    },
  };
}

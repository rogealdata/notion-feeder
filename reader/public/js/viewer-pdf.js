import * as pdfjs from '/vendor/pdfjs/pdf.min.mjs';
import { h, icon, store } from './ui.js';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** Merge per-word rectangles that sit on the same line into one box. */
function mergeRects(rects) {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - r.y) < last.h * 0.5 && Math.abs(last.h - r.h) < last.h * 0.6 && r.x <= last.x + last.w + 0.01) {
      const right = Math.max(last.x + last.w, r.x + r.w);
      const bottom = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.y = Math.min(last.y, r.y);
      last.w = right - last.x;
      last.h = bottom - last.y;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

export async function mount({ container, doc, highlights, onSelect, onProgress }) {
  const pagesEl = h('div.pdf-pages');
  container.replaceChildren(pagesEl);

  const task = pdfjs.getDocument({
    url: `/api/documents/${doc.id}/file`,
    standardFontDataUrl: '/vendor/pdfjs-fonts/',
    cMapUrl: '/vendor/pdfjs-cmaps/',
    cMapPacked: true,
    isEvalSupported: false,
  });
  const pdf = await task.promise;
  const firstPage = await pdf.getPage(1);
  const baseViewport = firstPage.getViewport({ scale: 1 });

  let zoom = Number(store('reader.pdfZoom')) || 1;
  const fitScale = () => Math.min(1.6, Math.max(0.3, (container.clientWidth - 32) / baseViewport.width));
  let scale = fitScale() * zoom;

  const pageIndicator = h('span.reader-progress', {}, `1 / ${pdf.numPages}`);

  // One placeholder per page; real content is rendered when it scrolls near the viewport.
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const el = h('div.pdf-page', { 'data-page': n });
    const hlLayer = h('div.hl-layer');
    el.append(hlLayer, h('span.page-num', {}, n));
    pages.push({ n, el, hlLayer, dims: null, rendered: false, renderTask: null, textLayer: null });
    pagesEl.append(el);
  }

  function sizePage(p) {
    const w = (p.dims?.width ?? baseViewport.width) * scale;
    const hgt = (p.dims?.height ?? baseViewport.height) * scale;
    p.el.style.width = `${Math.floor(w)}px`;
    p.el.style.height = `${Math.floor(hgt)}px`;
    p.el.style.setProperty('--total-scale-factor', String(scale));
  }
  pages.forEach(sizePage);

  async function renderPage(p) {
    if (p.rendered) return;
    p.rendered = true;
    try {
      const page = await pdf.getPage(p.n);
      const viewport = page.getViewport({ scale });
      if (!p.dims) {
        const raw = page.getViewport({ scale: 1 });
        p.dims = { width: raw.width, height: raw.height };
        sizePage(p);
      }
      const dpr = window.devicePixelRatio || 1;
      const canvas = h('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      p.el.prepend(canvas);
      p.renderTask = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      });
      const textDiv = h('div.textLayer');
      p.el.append(textDiv);
      p.textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport });
      await Promise.all([p.renderTask.promise, p.textLayer.render()]);
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException' && err?.name !== 'AbortException') console.error(err);
    }
  }

  function unrenderPage(p) {
    if (!p.rendered) return;
    p.renderTask?.cancel();
    p.textLayer?.cancel();
    p.el.querySelector('canvas')?.remove();
    p.el.querySelector('.textLayer')?.remove();
    p.rendered = false;
    p.renderTask = null;
    p.textLayer = null;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const p = pages[Number(entry.target.dataset.page) - 1];
        if (entry.isIntersecting) renderPage(p);
        else unrenderPage(p);
      }
    },
    { root: container, rootMargin: '1200px 0px' },
  );
  pages.forEach((p) => observer.observe(p.el));

  // ---------- highlights ----------
  function drawHighlight(hl) {
    const p = pages[hl.anchor.page - 1];
    if (!p) return;
    for (const r of hl.anchor.rects || []) {
      p.hlLayer.append(
        h('div', {
          'data-hid': hl.id,
          'data-color': hl.color,
          style: { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` },
        }),
      );
    }
  }
  const eraseHighlight = (hl) => pagesEl.querySelectorAll(`.hl-layer [data-hid="${hl.id}"]`).forEach((n) => n.remove());
  highlights.forEach(drawHighlight);

  let selTimer;
  const onSelectionChange = () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return onSelect(null);
      const range = sel.getRangeAt(0);
      if (!pagesEl.contains(range.commonAncestorContainer)) return onSelect(null);
      const startNode = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      const pageEl = startNode?.closest('.pdf-page');
      if (!pageEl) return onSelect(null);
      const box = pageEl.getBoundingClientRect();
      const rects = [...range.getClientRects()]
        .filter((r) => r.width > 1 && r.height > 1 && r.height < box.height * 0.2)
        .filter((r) => r.top >= box.top - 2 && r.bottom <= box.bottom + 2)
        .map((r) => ({
          x: (r.left - box.left) / box.width,
          y: (r.top - box.top) / box.height,
          w: r.width / box.width,
          h: r.height / box.height,
        }));
      // pdf.js ends each text line with <br>; keep those as spaces so lines don't run together.
      const fragment = range.cloneContents();
      fragment.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
      const text = fragment.textContent.replace(/\s+/g, ' ').trim();
      if (!text || !rects.length) return onSelect(null);
      onSelect({
        text,
        anchor: { page: Number(pageEl.dataset.page), rects: mergeRects(rects).map((r) => ({ x: +r.x.toFixed(5), y: +r.y.toFixed(5), w: +r.w.toFixed(5), h: +r.h.toFixed(5) })) },
        rect: range.getBoundingClientRect(),
        clear: () => sel.removeAllRanges(),
      });
    }, 220);
  };
  document.addEventListener('selectionchange', onSelectionChange);

  // ---------- position & progress ----------
  function currentPosition() {
    const mid = container.scrollTop + 80;
    let current = pages[0];
    for (const p of pages) {
      if (p.el.offsetTop <= mid) current = p;
      else break;
    }
    const frac = Math.min(1, Math.max(0, (mid - current.el.offsetTop) / current.el.offsetHeight));
    return { page: current.n, frac };
  }

  function scrollToPosition(page, frac = 0) {
    const p = pages[Math.min(pdf.numPages, Math.max(1, page)) - 1];
    container.scrollTop = p.el.offsetTop + frac * p.el.offsetHeight - 80;
  }

  let ticking = false;
  const onScroll = () => {
    onSelect(null);
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const { page, frac } = currentPosition();
      pageIndicator.textContent = `${page} / ${pdf.numPages}`;
      const atEnd = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
      onProgress(atEnd ? 1 : (page - 1 + frac) / pdf.numPages, `${page}:${frac.toFixed(3)}`);
    });
  };
  container.addEventListener('scroll', onScroll, { passive: true });

  const [savedPage, savedFrac] = String(doc.location || '').split(':').map(Number);
  if (savedPage) requestAnimationFrame(() => scrollToPosition(savedPage, savedFrac || 0));

  function setZoom(next) {
    const { page, frac } = currentPosition();
    zoom = next;
    store('reader.pdfZoom', String(zoom));
    scale = fitScale() * zoom;
    pages.forEach((p) => {
      unrenderPage(p);
      sizePage(p);
    });
    scrollToPosition(page, frac);
    // Re-trigger rendering of whatever is now visible.
    pages.forEach((p) => {
      observer.unobserve(p.el);
      observer.observe(p.el);
    });
  }
  const zoomBtn = (dir, label, iconName) =>
    h(
      'button.btn.ghost.icon',
      {
        type: 'button',
        title: label,
        'aria-label': label,
        onClick: () => {
          const i = ZOOMS.findIndex((z) => z >= zoom - 0.001);
          const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i === -1 ? ZOOMS.length - 1 : i) + dir))];
          if (next !== zoom) setZoom(next);
        },
      },
      icon(iconName),
    );

  let resizeTimer;
  const resizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (Math.abs(fitScale() * zoom - scale) > 0.01) setZoom(zoom);
    }, 200);
  });
  resizeObserver.observe(container);

  return {
    controls: [pageIndicator, zoomBtn(-1, 'Alejar', 'minus'), zoomBtn(1, 'Acercar', 'plus')],
    compare: (a, b) => a.anchor.page - b.anchor.page || (a.anchor.rects?.[0]?.y ?? 0) - (b.anchor.rects?.[0]?.y ?? 0),
    addHighlight: drawHighlight,
    removeHighlight: eraseHighlight,
    updateHighlight(hl) {
      eraseHighlight(hl);
      drawHighlight(hl);
    },
    goTo(hl) {
      scrollToPosition(hl.anchor.page, hl.anchor.rects?.[0]?.y ?? 0);
      const boxes = pagesEl.querySelectorAll(`.hl-layer [data-hid="${hl.id}"]`);
      boxes.forEach((b) => b.animate?.([{ opacity: 0.2 }, { opacity: 1 }], { duration: 400, iterations: 3 }));
    },
    async destroy() {
      clearTimeout(selTimer);
      clearTimeout(resizeTimer);
      document.removeEventListener('selectionchange', onSelectionChange);
      container.removeEventListener('scroll', onScroll);
      observer.disconnect();
      resizeObserver.disconnect();
      await task.destroy();
    },
  };
}

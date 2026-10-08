import JSZip from 'jszip';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Identify a file by its contents, not its name. Returns 'pdf', 'epub' or null. */
export async function detectKind(buffer) {
  if (buffer.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    try {
      const zip = await JSZip.loadAsync(buffer);
      const mimetype = await zip.file('mimetype')?.async('string');
      if (mimetype?.trim() === 'application/epub+zip' || zip.file('META-INF/container.xml')) return 'epub';
    } catch {
      return null;
    }
  }
  return null;
}

function titleFromFilename(filename) {
  return (
    filename
      .replace(/\.[^.]+$/, '')
      .replace(/[_]+/g, ' ')
      .trim() || 'Sin título'
  );
}

function clean(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text || null;
}

export async function pdfMetadata(buffer, filename) {
  const fallback = { title: titleFromFilename(filename), author: null, pages: null };
  const task = getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false });
  try {
    const doc = await task.promise;
    const { info } = await doc.getMetadata();
    return { title: clean(info?.Title) || fallback.title, author: clean(info?.Author), pages: doc.numPages };
  } catch {
    return fallback;
  } finally {
    await task.destroy();
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, code) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
    }
    return ENTITIES[code.toLowerCase()] ?? entity;
  });
}

function stripTags(text) {
  return text.replace(/<[^>]+>/g, ' ');
}

function xmlText(xml, tag) {
  const match = xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i'));
  if (!match) return null;
  // Decode the XML layer, then the HTML that descriptions often carry inside it.
  const xmlDecoded = decodeEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
  return clean(decodeEntities(stripTags(xmlDecoded)));
}

export async function epubMetadata(buffer, filename) {
  const fallback = { title: titleFromFilename(filename), author: null, description: null };
  try {
    const zip = await JSZip.loadAsync(buffer);
    const container = await zip.file('META-INF/container.xml')?.async('string');
    const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
    const opf = opfPath && (await zip.file(opfPath)?.async('string'));
    if (!opf) return fallback;
    return {
      title: xmlText(opf, 'title') || fallback.title,
      author: xmlText(opf, 'creator'),
      description: xmlText(opf, 'description'),
    };
  } catch {
    return fallback;
  }
}

import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { extractArticle, fetchUrl } from './extract.js';
import { detectKind, epubMetadata, pdfMetadata } from './files.js';
import { documentToMarkdown } from './export.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = join(ROOT, 'node_modules');

const STATUSES = new Set(['inbox', 'later', 'archive']);
const KINDS = new Set(['article', 'pdf', 'epub']);
const COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'purple']);
const MIME = { pdf: 'application/pdf', epub: 'application/epub+zip' };

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' blob:",
  'img-src * data: blob:',
  "font-src 'self' data: blob:",
  "connect-src 'self' blob: data:",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();

export function createApp({ dataDir, fetchImpl } = {}) {
  const dir = resolve(dataDir || process.env.READER_DATA_DIR || join(ROOT, 'data'));
  const filesDir = join(dir, 'files');
  mkdirSync(filesDir, { recursive: true });
  const db = openDatabase(join(dir, 'reader.db'));

  const app = express();
  app.locals.db = db;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Content-Security-Policy', CSP);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  });

  // ---------- helpers ----------

  const tagsFor = db.prepare('SELECT tag FROM document_tags WHERE document_id = ? ORDER BY tag');

  function serialize(row, { full = false } = {}) {
    if (!row) return null;
    const doc = {
      id: row.id,
      kind: row.kind,
      title: row.title,
      author: row.author,
      siteName: row.site_name,
      url: row.url,
      excerpt: row.excerpt,
      wordCount: row.word_count,
      originalName: row.original_name,
      size: row.size,
      status: row.status,
      favorite: Boolean(row.favorite),
      progress: row.progress,
      location: row.location,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at,
      highlightCount: row.highlight_count ?? undefined,
      tags: tagsFor.all(row.id).map((t) => t.tag),
    };
    if (full) doc.contentHtml = row.content_html;
    return doc;
  }

  function getRow(id) {
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(id));
    if (!row) throw new HttpError(404, 'Documento no encontrado');
    return row;
  }

  function setTags(id, tags) {
    const clean = [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 30);
    db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(id);
    const insert = db.prepare('INSERT INTO document_tags (document_id, tag) VALUES (?, ?)');
    for (const tag of clean) insert.run(id, tag);
  }

  async function storeFile(buffer, originalName, url = null) {
    const kind = await detectKind(buffer);
    if (!kind) throw new HttpError(415, 'Solo se admiten archivos PDF y EPUB');
    const meta = kind === 'pdf' ? await pdfMetadata(buffer, originalName) : await epubMetadata(buffer, originalName);
    const fileName = `${randomUUID()}.${kind}`;
    await writeFile(join(filesDir, fileName), buffer);
    const result = db
      .prepare(
        `INSERT INTO documents (kind, title, author, url, excerpt, file_name, original_name, size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(kind, meta.title, meta.author, url, meta.description ?? null, fileName, originalName, buffer.length);
    return Number(result.lastInsertRowid);
  }

  function findByUrl(url) {
    return db.prepare('SELECT id FROM documents WHERE url = ?').get(url);
  }

  // ---------- documents ----------

  app.get('/api/documents', (req, res) => {
    const where = [];
    const params = [];
    const { status, kind, favorite, q, tag } = req.query;
    if (status && STATUSES.has(status)) {
      where.push('d.status = ?');
      params.push(status);
    }
    if (kind && KINDS.has(kind)) {
      where.push('d.kind = ?');
      params.push(kind);
    }
    if (favorite === '1' || favorite === 'true') where.push('d.favorite = 1');
    if (q) {
      where.push('(d.title LIKE ? OR d.author LIKE ? OR d.site_name LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM document_tags t WHERE t.document_id = d.id AND t.tag = ?)');
      params.push(String(tag).toLowerCase());
    }
    const rows = db
      .prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM highlights h WHERE h.document_id = d.id) AS highlight_count
         FROM documents d ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY d.created_at DESC, d.id DESC`,
      )
      .all(...params);
    res.json(rows.map((row) => serialize(row)));
  });

  app.get('/api/tags', (req, res) => {
    res.json(db.prepare('SELECT tag, COUNT(*) AS count FROM document_tags GROUP BY tag ORDER BY tag').all());
  });

  app.post('/api/documents/url', async (req, res) => {
    const url = String(req.body?.url || '').trim();
    if (!url) throw new HttpError(400, 'Falta la URL');
    const existing = findByUrl(url);
    if (existing) return res.status(200).json(serialize(getRow(existing.id)));

    let fetched;
    try {
      fetched = await fetchUrl(url, { fetchImpl });
    } catch (err) {
      throw new HttpError(422, `No se pudo descargar: ${err.message}`);
    }

    let id;
    if (fetched.type === 'file') {
      id = await storeFile(fetched.buffer, fetched.filename, url);
    } else {
      let article;
      try {
        article = extractArticle(fetched.html, fetched.url);
      } catch (err) {
        throw new HttpError(422, err.message);
      }
      id = Number(
        db
          .prepare(
            `INSERT INTO documents (kind, title, author, site_name, url, excerpt, content_html, word_count)
             VALUES ('article', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(article.title, article.author, article.siteName, url, article.excerpt, article.contentHtml, article.wordCount)
          .lastInsertRowid,
      );
    }
    res.status(201).json(serialize(getRow(id)));
  });

  app.post('/api/documents/upload', upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Falta el archivo');
    const id = await storeFile(req.file.buffer, req.file.originalname);
    res.status(201).json(serialize(getRow(id)));
  });

  app.get('/api/documents/:id', (req, res) => {
    const row = getRow(req.params.id);
    db.prepare('UPDATE documents SET last_opened_at = ? WHERE id = ?').run(now(), row.id);
    res.json(serialize(getRow(row.id), { full: true }));
  });

  app.patch('/api/documents/:id', (req, res) => {
    const row = getRow(req.params.id);
    const body = req.body || {};
    const updates = {};
    if (typeof body.title === 'string' && body.title.trim()) updates.title = body.title.trim();
    if (typeof body.author === 'string') updates.author = body.author.trim() || null;
    if (body.status !== undefined) {
      if (!STATUSES.has(body.status)) throw new HttpError(400, 'Estado no válido');
      updates.status = body.status;
    }
    if (body.favorite !== undefined) updates.favorite = body.favorite ? 1 : 0;
    if (body.progress !== undefined) {
      const progress = Number(body.progress);
      if (!Number.isFinite(progress)) throw new HttpError(400, 'Progreso no válido');
      updates.progress = Math.min(1, Math.max(0, progress));
    }
    if (body.location !== undefined) updates.location = body.location === null ? null : String(body.location).slice(0, 2000);

    const keys = Object.keys(updates);
    if (keys.length) {
      db.prepare(`UPDATE documents SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
        ...keys.map((k) => updates[k]),
        now(),
        row.id,
      );
    }
    if (Array.isArray(body.tags)) setTags(row.id, body.tags);
    res.json(serialize(getRow(row.id)));
  });

  app.delete('/api/documents/:id', async (req, res) => {
    const row = getRow(req.params.id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(row.id);
    if (row.file_name) await unlink(join(filesDir, row.file_name)).catch(() => {});
    res.status(204).end();
  });

  app.get('/api/documents/:id/file', (req, res) => {
    const row = getRow(req.params.id);
    if (!row.file_name) throw new HttpError(404, 'Este documento no tiene archivo');
    res.set('Content-Type', MIME[row.kind]);
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(join(filesDir, row.file_name));
  });

  app.get('/api/documents/:id/export', (req, res) => {
    const row = getRow(req.params.id);
    const highlights = db.prepare('SELECT * FROM highlights WHERE document_id = ? ORDER BY id').all(row.id);
    const safeName = row.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 80) || 'documento';
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.md`);
    res.send(documentToMarkdown(serialize(row), highlights.map(serializeHighlight)));
  });

  // ---------- highlights ----------

  function serializeHighlight(row) {
    return {
      id: row.id,
      documentId: row.document_id,
      text: row.text,
      note: row.note,
      color: row.color,
      anchor: JSON.parse(row.anchor),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.document_title !== undefined && {
        document: { id: row.document_id, title: row.document_title, kind: row.document_kind, author: row.document_author },
      }),
    };
  }

  function getHighlight(id) {
    const row = db.prepare('SELECT * FROM highlights WHERE id = ?').get(Number(id));
    if (!row) throw new HttpError(404, 'Subrayado no encontrado');
    return row;
  }

  app.get('/api/highlights', (req, res) => {
    const q = req.query.q ? `%${req.query.q}%` : null;
    const rows = db
      .prepare(
        `SELECT h.*, d.title AS document_title, d.kind AS document_kind, d.author AS document_author
         FROM highlights h JOIN documents d ON d.id = h.document_id
         ${q ? 'WHERE h.text LIKE ? OR h.note LIKE ? OR d.title LIKE ?' : ''}
         ORDER BY h.created_at DESC, h.id DESC`,
      )
      .all(...(q ? [q, q, q] : []));
    res.json(rows.map(serializeHighlight));
  });

  app.get('/api/documents/:id/highlights', (req, res) => {
    const row = getRow(req.params.id);
    const rows = db.prepare('SELECT * FROM highlights WHERE document_id = ? ORDER BY id').all(row.id);
    res.json(rows.map(serializeHighlight));
  });

  app.post('/api/documents/:id/highlights', (req, res) => {
    const row = getRow(req.params.id);
    const { text, note, color = 'yellow', anchor } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Falta el texto subrayado');
    if (!anchor || typeof anchor !== 'object') throw new HttpError(400, 'Falta la posición del subrayado');
    if (!COLORS.has(color)) throw new HttpError(400, 'Color no válido');
    const result = db
      .prepare('INSERT INTO highlights (document_id, text, note, color, anchor) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, text.trim().slice(0, 20000), note ? String(note) : null, color, JSON.stringify(anchor));
    res.status(201).json(serializeHighlight(getHighlight(result.lastInsertRowid)));
  });

  app.patch('/api/highlights/:id', (req, res) => {
    const row = getHighlight(req.params.id);
    const { note, color } = req.body || {};
    if (color !== undefined && !COLORS.has(color)) throw new HttpError(400, 'Color no válido');
    db.prepare('UPDATE highlights SET note = ?, color = ?, updated_at = ? WHERE id = ?').run(
      note === undefined ? row.note : note ? String(note) : null,
      color ?? row.color,
      now(),
      row.id,
    );
    res.json(serializeHighlight(getHighlight(row.id)));
  });

  app.delete('/api/highlights/:id', (req, res) => {
    const row = getHighlight(req.params.id);
    db.prepare('DELETE FROM highlights WHERE id = ?').run(row.id);
    res.status(204).end();
  });

  // ---------- static ----------

  app.use('/vendor/pdfjs', express.static(join(MODULES, 'pdfjs-dist', 'legacy', 'build')));
  app.use('/vendor/pdfjs-fonts', express.static(join(MODULES, 'pdfjs-dist', 'standard_fonts')));
  app.use('/vendor/pdfjs-cmaps', express.static(join(MODULES, 'pdfjs-dist', 'cmaps')));
  app.use('/vendor/epubjs', express.static(join(MODULES, 'epubjs', 'dist')));
  app.use('/vendor/jszip', express.static(join(MODULES, 'jszip', 'dist')));
  app.use(express.static(join(ROOT, 'public')));

  app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Error interno' : err.message });
  });

  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createApp().listen(port, host, () => {
    console.log(`Reader en http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  });
}

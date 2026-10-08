function quote(text) {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function where(anchor) {
  if (anchor?.page) return ` (p. ${anchor.page})`;
  return '';
}

/** Render a document's highlights and notes as Markdown (Obsidian/Notion friendly). */
export function documentToMarkdown(doc, highlights) {
  const lines = [`# ${doc.title}`, ''];
  const meta = [
    doc.author && `- Autor: ${doc.author}`,
    doc.siteName && `- Sitio: ${doc.siteName}`,
    doc.url && `- URL: ${doc.url}`,
    `- Tipo: ${doc.kind}`,
    doc.tags?.length && `- Etiquetas: ${doc.tags.map((t) => `#${t.replace(/\s+/g, '-')}`).join(' ')}`,
  ].filter(Boolean);
  lines.push(...meta, '', '## Subrayados', '');
  if (!highlights.length) lines.push('_Sin subrayados todavía._', '');
  for (const h of highlights) {
    lines.push(`${quote(h.text)}${where(h.anchor)}`, '');
    if (h.note) lines.push(`**Nota:** ${h.note}`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

async function request(path, { method = 'GET', json, body } = {}) {
  const res = await fetch(path, {
    method,
    headers: json ? { 'content-type': 'application/json' } : undefined,
    body: json ? JSON.stringify(json) : body,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

export const api = {
  list: (params = {}) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null));
    return request(`/api/documents?${query}`);
  },
  get: (id) => request(`/api/documents/${id}`),
  saveUrl: (url) => request('/api/documents/url', { method: 'POST', json: { url } }),
  upload: (file) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request('/api/documents/upload', { method: 'POST', body: form });
  },
  update: (id, patch) => request(`/api/documents/${id}`, { method: 'PATCH', json: patch }),
  remove: (id) => request(`/api/documents/${id}`, { method: 'DELETE' }),
  fileUrl: (id) => `/api/documents/${id}/file`,
  exportUrl: (id) => `/api/documents/${id}/export`,
  tags: () => request('/api/tags'),
  highlights: (id) => request(`/api/documents/${id}/highlights`),
  allHighlights: (q) => request(`/api/highlights${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  addHighlight: (id, highlight) => request(`/api/documents/${id}/highlights`, { method: 'POST', json: highlight }),
  updateHighlight: (id, patch) => request(`/api/highlights/${id}`, { method: 'PATCH', json: patch }),
  removeHighlight: (id) => request(`/api/highlights/${id}`, { method: 'DELETE' }),
};

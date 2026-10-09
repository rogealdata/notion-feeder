import { getServer, saveTab, updateDocument } from './lib.js';

const $ = (id) => document.getElementById(id);
let doc = null;

function setState(text, kind = '') {
  $('state').textContent = text;
  $('state').className = `state ${kind}`;
}

function render() {
  $('title').textContent = doc.title;
  $('meta').textContent = [doc.author, doc.siteName || doc.kind.toUpperCase()].filter(Boolean).join(' · ');
  $('later').setAttribute('aria-pressed', String(doc.status === 'later'));
  $('archive').setAttribute('aria-pressed', String(doc.status === 'archive'));
  $('favorite').setAttribute('aria-pressed', String(doc.favorite));
}

async function patch(changes, label) {
  try {
    ({ data: doc } = await updateDocument(doc.id, changes));
    render();
    setState(label, 'ok');
  } catch (err) {
    setState('Error', 'error');
    showMessage(err.message);
  }
}

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = false;
}

async function getTab() {
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  if (forced) return chrome.tabs.get(forced);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function save() {
  const tab = await getTab();
  $('title').textContent = tab?.title || 'Página actual';
  $('meta').textContent = tab?.url ? new URL(tab.url).hostname : '';
  $('message').hidden = true;
  $('retry').hidden = true;
  setState('Guardando…');
  try {
    const { data, existed } = await saveTab(tab);
    doc = data;
    render();
    setState(existed ? 'Ya estaba guardado' : 'Guardado', 'ok');
    $('saved').hidden = false;
    $('tags-label').hidden = false;
    $('tags').value = doc.tags.join(', ');
    $('open').href = `${await getServer()}/#/read/${doc.id}`;
    $('open').hidden = false;
  } catch (err) {
    setState('No se guardó', 'error');
    showMessage(err.message);
    $('retry').hidden = false;
  }
}

$('later').addEventListener('click', () =>
  patch({ status: doc.status === 'later' ? 'inbox' : 'later' }, doc.status === 'later' ? 'En la bandeja' : 'Para después'),
);
$('archive').addEventListener('click', () =>
  patch({ status: doc.status === 'archive' ? 'inbox' : 'archive' }, doc.status === 'archive' ? 'En la bandeja' : 'Archivado'),
);
$('favorite').addEventListener('click', () => patch({ favorite: !doc.favorite }, doc.favorite ? 'Guardado' : 'En favoritos'));
$('tags').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') patch({ tags: $('tags').value.split(',') }, 'Etiquetas guardadas');
});
$('tags').addEventListener('blur', () => {
  if (doc && $('tags').value !== doc.tags.join(', ')) patch({ tags: $('tags').value.split(',') }, 'Etiquetas guardadas');
});
$('retry').addEventListener('click', save);

save();

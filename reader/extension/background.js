import { saveTab, saveUrl } from './lib.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'save-page', title: 'Guardar página en Reader', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'save-link', title: 'Guardar enlace en Reader', contexts: ['link'] });
  });
});

async function flash(tabId, ok) {
  const opts = tabId ? { tabId } : {};
  await chrome.action.setBadgeBackgroundColor({ ...opts, color: ok ? '#2f8f4e' : '#b4332b' });
  await chrome.action.setBadgeText({ ...opts, text: ok ? '✓' : '!' });
  setTimeout(() => chrome.action.setBadgeText({ ...opts, text: '' }), 4000);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'save-link') await saveUrl(info.linkUrl);
    else await saveTab(tab);
    await flash(tab?.id, true);
    await chrome.action.setTitle({ tabId: tab?.id, title: 'Guardado en Reader' });
  } catch (err) {
    await flash(tab?.id, false);
    await chrome.action.setTitle({ tabId: tab?.id, title: `No se pudo guardar: ${err.message}` });
  }
});

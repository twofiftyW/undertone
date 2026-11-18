import { nativeRuntime } from './runtime.js';

export const iconNames = { green: 'Green', blue: 'Blue', amoled: 'Black', gray: 'Gray' };
const storageKey = 'undertone-app-icon';
const preferencesKey = 'undertone-app-icon-preferences';
let preferences = { sync: true, manual: null };
let savedIcon = 'green';
let nativeIconKnown = false;
let writes = Promise.resolve();
let latestRequest = 0;

function validIcon(id) { return Object.hasOwn(iconNames, id) ? id : 'green'; }
export function iconSyncEnabled() { return preferences.sync; }
export function appIconPath(id = document.documentElement.dataset.appIcon) {
  return `./icons/${validIcon(id)}.svg`;
}

function show(id) {
  document.documentElement.dataset.appIcon = id;
  const path = appIconPath(id);
  document.querySelector('link[rel="icon"]').setAttribute('href', path);
  for (const image of document.querySelectorAll('img[data-app-icon]')) image.setAttribute('src', path);
  const checkbox = document.querySelector('input[name="sync-app-icon"]');
  if (checkbox) checkbox.checked = preferences.sync;
  const choices = document.getElementById('app-icon-choices');
  if (choices) choices.hidden = preferences.sync;
  for (const radio of document.querySelectorAll('input[name="app-icon"]')) {
    radio.checked = radio.value === id;
    radio.disabled = preferences.sync;
  }
}

function remember(id) {
  savedIcon = id;
  try { localStorage.setItem(storageKey, id); } catch {}
}

function savePreferences() {
  try { localStorage.setItem(preferencesKey, JSON.stringify(preferences)); } catch {}
}

export async function restoreAppIcon() {
  let cached, stored;
  try {
    cached = localStorage.getItem(storageKey);
    stored = JSON.parse(localStorage.getItem(preferencesKey));
  } catch {}
  savedIcon = validIcon(cached);
  nativeIconKnown = false;
  preferences = {
    sync: stored?.sync !== false,
    manual: Object.hasOwn(iconNames, stored?.manual) ? stored.manual : null,
  };
  const theme = validIcon(document.documentElement.dataset.theme);
  show(preferences.sync ? theme : preferences.manual || savedIcon);
  if (nativeRuntime) {
    try {
      remember(validIcon(await nativeRuntime.invoke('get_app_icon')));
      nativeIconKnown = true;
    } catch (error) { console.warn('Could not read the native app icon', error); }
  }
  // Keep the previous independent selection available the first time sync is turned off.
  if (!stored && (Object.hasOwn(iconNames, cached) || savedIcon !== 'green')) preferences.manual = savedIcon;
  savePreferences();
  try { await applyIcon(preferences.sync ? theme : preferences.manual || savedIcon); }
  catch (error) { console.warn('Could not restore the selected app icon', error); }
}

function applyIcon(id) {
  show(id);
  const request = ++latestRequest;
  const save = writes.then(async () => {
    if (request !== latestRequest) return;
    try {
      if (nativeRuntime && (!nativeIconKnown || savedIcon !== id)) {
        await nativeRuntime.invoke('set_app_icon', { id });
        nativeIconKnown = true;
      }
      remember(id);
    } catch (error) {
      if (nativeRuntime) {
        try { remember(validIcon(await nativeRuntime.invoke('get_app_icon'))); } catch {}
      }
      if (request === latestRequest) {
        if (!preferences.sync) {
          preferences.manual = savedIcon;
          savePreferences();
        }
        show(savedIcon);
        throw error;
      }
    }
  });
  // A failed native change must not block the next radio selection.
  writes = save.catch(() => {});
  return save;
}

export function syncIconWithTheme() {
  return preferences.sync ? applyIcon(validIcon(document.documentElement.dataset.theme)) : Promise.resolve();
}

export function setIconSync(enabled) {
  preferences.sync = enabled;
  if (!enabled && !preferences.manual) preferences.manual = validIcon(document.documentElement.dataset.appIcon);
  savePreferences();
  return applyIcon(enabled ? validIcon(document.documentElement.dataset.theme) : preferences.manual);
}

export function selectAppIcon(id) {
  if (!Object.hasOwn(iconNames, id)) return Promise.reject(new Error('Unknown app icon'));
  if (preferences.sync) return syncIconWithTheme();
  preferences.manual = id;
  savePreferences();
  return applyIcon(id);
}

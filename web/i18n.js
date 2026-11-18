import { russian } from './ru.js';

let language = 'en';
try {
  if (globalThis.localStorage?.getItem('undertone-language') === 'ru') language = 'ru';
} catch { /* The app can still switch language for this session. */ }

export function appLanguage() { return language; }

export function setLanguage(value) {
  language = value === 'ru' ? 'ru' : 'en';
  try { globalThis.localStorage?.setItem('undertone-language', language); } catch {}
}

export function tr(message, values = {}) {
  const text = language === 'ru' && Object.hasOwn(russian, message) ? russian[message] : message;
  return String(text).replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}

const nouns = {
  en: { song: { one: 'song', other: 'songs' }, recording: { one: 'recording', other: 'recordings' } },
  ru: { song: { one: 'трек', few: 'трека', many: 'треков', other: 'трека' }, recording: { one: 'запись', few: 'записи', many: 'записей', other: 'записи' } },
};
const plurals = { en: new Intl.PluralRules('en'), ru: new Intl.PluralRules('ru') };
const numbers = { en: new Intl.NumberFormat('en'), ru: new Intl.NumberFormat('ru') };

export function countLabel(count, noun = 'song') {
  return `${numbers[language].format(count)} ${nouns[language][noun][plurals[language].select(count)]}`;
}

// Only marked app labels are translated. Catalog text and user input are kept as supplied.
export function translateStatic(document) {
  document.documentElement.lang = language;
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = tr(element.dataset.i18n);
  for (const attr of ['aria-label', 'placeholder', 'title']) {
    for (const element of document.querySelectorAll(`[data-i18n-${attr}]`)) element.setAttribute(attr, tr(element.getAttribute(`data-i18n-${attr}`)));
  }
}

/**
 * Localization for the Service Worker, plus the message catalog service that
 * content scripts depend on.
 *
 * Content scripts cannot fetch _locales themselves: their requests carry the
 * host page's origin, and exposing the catalog through web_accessible_resources
 * would hand it to every recorded page. The Service Worker reads it instead and
 * serves it over the message channel.
 */
const SUPPORTED_LOCALES = new Set(["zh_CN", "en"]);
const localeMessageCache = new Map();

/** Worker-side translation. Falls back to the inline Chinese string. */
export function t(key, substitutions = [], fallback = "") {
  return chrome.i18n.getMessage(key, Array.isArray(substitutions) ? substitutions : [substitutions]) || fallback;
}

export async function loadLocaleMessages(language) {
  const locale = SUPPORTED_LOCALES.has(language) ? language : "en";
  if (localeMessageCache.has(locale)) return localeMessageCache.get(locale);

  const response = await fetch(chrome.runtime.getURL(`_locales/${locale}/messages.json`));
  if (!response.ok) throw new Error(`Failed to load locale ${locale}: HTTP ${response.status}`);
  const messages = await response.json();
  localeMessageCache.set(locale, messages);
  return messages;
}

/** Shared Chrome extension localization helpers. */
(function () {
  if (globalThis.RecorderI18n) return;
  const { MESSAGE } = globalThis.WorkflowRecorderProtocol;
  const LANGUAGE_KEY = "uiLanguage";
  const SUPPORTED_LANGUAGES = new Set(["zh_CN", "en"]);
  // Extension pages may read _locales with fetch(). Content scripts issue
  // requests with the host page's origin, so an extension resource that is not
  // listed in web_accessible_resources is rejected as chrome-extension://invalid.
  // Those contexts ask the Service Worker for the parsed catalog instead, which
  // keeps _locales out of reach of the pages we record.
  const isExtensionPage = location.protocol === "chrome-extension:";
  let language = defaultLanguage();
  let messages = {};

  function formatFallback(template, substitutions) {
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    return values.reduce(
      (text, value, index) => text.replaceAll(`$${index + 1}`, value == null ? "" : String(value)),
      String(template || "")
    );
  }

  function formatMessage(entry, substitutions) {
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    let text = String(entry?.message || "");
    Object.entries(entry?.placeholders || {}).forEach(([name, placeholder]) => {
      const index = Number(/^\$(\d+)$/.exec(placeholder.content || "")?.[1]) - 1;
      const value = index >= 0 && index < values.length ? values[index] : "";
      text = text.replaceAll(`$${name.toUpperCase()}$`, value == null ? "" : String(value));
    });
    return values.reduce(
      (text, value, index) => text.replaceAll(`$${index + 1}`, value == null ? "" : String(value)),
      text
    );
  }

  function defaultLanguage() {
    const browserLanguage = chrome?.i18n?.getUILanguage?.() || navigator.language || "en";
    return /^zh(?:-|_|$)/i.test(browserLanguage) ? "zh_CN" : "en";
  }

  async function fetchLocaleMessages(nextLanguage) {
    if (isExtensionPage) {
      const response = await fetch(chrome.runtime.getURL(`_locales/${nextLanguage}/messages.json`));
      if (!response.ok) throw new Error(`Failed to load locale ${nextLanguage}: HTTP ${response.status}`);
      return response.json();
    }

    const response = await chrome.runtime.sendMessage({
      action: MESSAGE.getLocaleMessages,
      language: nextLanguage
    });
    if (!response?.success) {
      throw new Error(response?.error || `Failed to load locale ${nextLanguage} from the service worker`);
    }
    return response.messages;
  }

  async function loadMessages(nextLanguage) {
    messages = await fetchLocaleMessages(nextLanguage);
    language = nextLanguage;
  }

  async function selectedLanguage() {
    try {
      const stored = await chrome.storage.local.get(LANGUAGE_KEY);
      if (SUPPORTED_LANGUAGES.has(stored[LANGUAGE_KEY])) return stored[LANGUAGE_KEY];
    } catch (error) {
      console.warn("[i18n] Unable to read the stored language preference:", error.message);
    }
    return defaultLanguage();
  }

  /**
   * Resolves even when the catalog cannot be loaded. Callers await `ready`
   * before attaching recording listeners or rendering, so a locale failure must
   * never leave the recorder inert; t() still returns its inline fallback.
   */
  async function initialize() {
    language = await selectedLanguage();
    try {
      await loadMessages(language);
    } catch (error) {
      console.warn(`[i18n] Using inline fallback strings for ${language}:`, error.message);
    }
    return language;
  }

  function t(key, substitutions = [], fallback = "") {
    return formatMessage(messages[key], substitutions) || formatFallback(fallback, substitutions) || key;
  }

  function applyI18n(root = document) {
    // Recorded pages own their own markup and lang attribute. Only extension
    // pages carry [data-i18n] nodes, so this is a no-op in content scripts.
    if (!isExtensionPage) return;

    document.documentElement.lang = language === "zh_CN" ? "zh-CN" : "en";

    root.querySelectorAll("[data-i18n]").forEach(element => {
      element.textContent = t(element.dataset.i18n, [], element.textContent);
    });
    root.querySelectorAll("[data-i18n-html]").forEach(element => {
      element.innerHTML = t(element.dataset.i18nHtml, [], element.innerHTML);
    });
    root.querySelectorAll("[data-i18n-title]").forEach(element => {
      element.title = t(element.dataset.i18nTitle, [], element.title);
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach(element => {
      element.placeholder = t(element.dataset.i18nPlaceholder, [], element.placeholder);
    });
    root.querySelectorAll("[data-i18n-aria-label]").forEach(element => {
      element.setAttribute("aria-label", t(
        element.dataset.i18nAriaLabel,
        [],
        element.getAttribute("aria-label") || ""
      ));
    });
  }

  async function setLanguage(nextLanguage) {
    if (!SUPPORTED_LANGUAGES.has(nextLanguage)) return;
    await chrome.storage.local.set({ [LANGUAGE_KEY]: nextLanguage });
    await loadMessages(nextLanguage);
    applyI18n();
  }

  function bindLanguageToggle(button) {
    if (!button) return;
    const targetLanguage = language === "zh_CN" ? "en" : "zh_CN";
    button.textContent = targetLanguage === "en" ? "EN" : "中";
    const title = targetLanguage === "en"
      ? t("switchToEnglish", [], "切换到英文")
      : t("switchToChinese", [], "Switch to Chinese");
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", async () => {
      button.disabled = true;
      await chrome.storage.local.set({ [LANGUAGE_KEY]: targetLanguage });
      location.reload();
    });
  }

  const ready = initialize();
  globalThis.RecorderI18n = {
    applyI18n,
    bindLanguageToggle,
    getLanguage: () => language,
    ready,
    setLanguage,
    t
  };
  if (isExtensionPage) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", async () => {
        await ready;
        applyI18n();
      }, { once: true });
    } else {
      ready.then(() => applyI18n());
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    const nextLanguage = changes[LANGUAGE_KEY]?.newValue;
    if (area !== "local" || !SUPPORTED_LANGUAGES.has(nextLanguage) || nextLanguage === language) return;
    loadMessages(nextLanguage).then(() => {
      applyI18n();
      window.dispatchEvent(new CustomEvent("recorderLanguageChanged", { detail: { language } }));
    }).catch(error => console.error("[i18n] Failed to change language:", error));
  });
})();

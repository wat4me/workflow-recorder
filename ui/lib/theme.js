import { iconSvg } from "./icons.js";

export const THEME_KEY = "uiTheme";

const normalize = theme => theme === "dark" ? "dark" : "light";

export async function readTheme() {
  const stored = await chrome.storage.local.get(THEME_KEY);
  return normalize(stored[THEME_KEY]);
}

let themeButton;

function applyTheme(theme) {
  const current = normalize(theme);
  document.documentElement.dataset.theme = current;
  if (!themeButton) return;
  const { t } = globalThis.RecorderI18n;
  const dark = current === "dark";
  const label = dark
    ? t("switchToLightTheme", [], "切换到浅色模式")
    : t("switchToDarkTheme", [], "切换到深色模式");
  themeButton.innerHTML = iconSvg(dark ? "sun" : "moon", 14);
  themeButton.title = label;
  themeButton.setAttribute("aria-label", label);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[THEME_KEY]) applyTheme(changes[THEME_KEY].newValue);
});
const themeReady = readTheme().then(applyTheme, () => applyTheme("light"));

export function bindThemeToggle(button) {
  themeButton = button;
  applyTheme(document.documentElement.dataset.theme);
  let pending = false;
  button.addEventListener("click", async () => {
    if (pending) return;
    pending = true;
    try {
      await themeReady;
      const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      await chrome.storage.local.set({ [THEME_KEY]: theme });
    } catch (error) {
      globalThis.RecorderDialogs.reportError(error.message);
    } finally {
      pending = false;
    }
  });
}

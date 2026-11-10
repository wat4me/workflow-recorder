/** Folder accents encode hierarchy consistently across navigation and labels. */
const LEVEL_COLORS = [
  ["light-dark(#2563a6, #9dc8ff)", "light-dark(#eaf2fc, #263b57)"],
  ["light-dark(#14806b, #94e0c8)", "light-dark(#e6f5ef, #234139)"],
  ["light-dark(#a34b12, #ffbd91)", "light-dark(#fff1e5, #473328)"]
];
export function applyFolderColor(element, depth = 0) {
  const [color, background] = depth > 0
    ? LEVEL_COLORS[Math.min(3, depth) - 1] : ["light-dark(#65748b, #b0bed4)", "light-dark(#f1f4f8, #2b374a)"];
  element.style.setProperty("--folder-color", color);
  element.style.setProperty("--folder-background", background);
}

/** Folder accents encode hierarchy consistently across navigation and labels. */
const LEVEL_COLORS = [
  ["#2563a6", "#eaf2fc"], // Level 1: blue.
  ["#14806b", "#e6f5ef"], // Level 2: green.
  ["#a34b12", "#fff1e5"]  // Level 3: orange.
];
export function applyFolderColor(element, depth = 0) {
  const [color, background] = depth > 0
    ? LEVEL_COLORS[Math.min(3, depth) - 1] : ["#65748b", "#f1f4f8"];
  element.style.setProperty("--folder-color", color);
  element.style.setProperty("--folder-background", background);
}

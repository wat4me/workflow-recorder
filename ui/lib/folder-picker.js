/** Compact, keyboard-accessible folder hierarchy for save dialogs. */
(function () {
  function create({ label, options, value = "" }) {
    const element = document.createElement("div");
    element.className = "folder-picker";
    const current = document.createElement("div");
    current.className = "folder-picker-current";
    const path = document.createElement("span");
    current.appendChild(path);
    const list = document.createElement("div");
    list.className = "save-case-folder";
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-label", label);
    let selected = options.some(item => item.value === value) ? value : options[0]?.value || "";
    const rows = options.map(item => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "folder-picker-row";
      row.setAttribute("role", "radio");
      row.dataset.folderId = item.value;
      row.style.setProperty("--folder-depth", Math.max(0, Math.min(2, item.depth || 0)));
      row.title = item.label;
      row.innerHTML = '<svg class="folder-picker-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg><span class="folder-picker-name"></span><svg class="folder-picker-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
      row.querySelector(".folder-picker-name").textContent = item.name || item.label;
      if (item.depth) row.classList.add("is-nested");
      row.addEventListener("click", () => choose(item.value));
      list.appendChild(row);
      return row;
    });
    function choose(value) {
      selected = value;
      const item = options.find(item => item.value === selected);
      path.textContent = item?.label || "";
      current.title = item?.label || "";
      for (const row of rows) {
        const active = row.dataset.folderId === selected;
        row.setAttribute("aria-checked", String(active));
        row.tabIndex = active ? 0 : -1;
      }
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    list.addEventListener("keydown", event => {
      const index = rows.indexOf(document.activeElement);
      if (index < 0) return;
      let next;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % rows.length;
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index + rows.length - 1) % rows.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = rows.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        choose(options[next].value);
        rows[next].focus();
      }
      // Native button activation selects a row; Enter must not submit the dialog.
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    });
    choose(selected);
    element.append(current, list);
    return { element, get value() { return selected; } };
  }
  globalThis.RecorderFolderPicker = { create };
})();

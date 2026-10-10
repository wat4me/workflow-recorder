/** Folder tree, menus and move dialog for the saved-case library. */
import { iconSvg } from "../lib/icons.js";
export function attachFolders(ctx) {
  const {
    t, MESSAGE, sendRuntimeMessage, confirmAction, notify, promptText, reportError,
    folderList, createFolderButton, searchScope
  } = ctx;
  const folderRootTarget = createFolderButton.parentElement;
  ctx.folderRootTarget = folderRootTarget;
  ctx.folderMenu = null;
  ctx.folderMenuButton = null;
  ctx.draggedFolderId = null;
  ctx.draggedFolderTargets = new Set();
  ctx.collapsedFolders = new Set();
  ctx.collapsedMoveFolders = new Set();

  function folderName(folderId) {
    return ctx.folders.find(folder => folder.id === folderId)?.name || t("unfiledCases", [], "未分类");
  }
  function descendantIds(folderId) {
    const result = new Set([folderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of ctx.folders) {
        if (folder.parentId && result.has(folder.parentId) && !result.has(folder.id)) {
          result.add(folder.id);
          changed = true;
        }
      }
    }
    return result;
  }
  function flattenedFolders() {
    const byParent = new Map();
    for (const folder of ctx.folders) {
      const parentId = ctx.folders.some(item => item.id === folder.parentId) ? folder.parentId : null;
      if (!byParent.has(parentId)) byParent.set(parentId, []);
      byParent.get(parentId).push(folder);
    }
    for (const children of byParent.values()) {
      children.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    }
    const result = [];
    const append = (parentId, depth) => {
      for (const folder of byParent.get(parentId) || []) {
        result.push({ folder, depth });
        append(folder.id, depth + 1);
      }
    };
    append(null, 1);
    return result;
  }
  function updateFolderVisibility(container, collapsed) {
    let hiddenBelow = Infinity;
    for (const row of container.children) {
      const depth = Number(row.dataset.depth);
      if (depth <= hiddenBelow) hiddenBelow = Infinity;
      row.hidden = depth > hiddenBelow;
      if (!row.hidden && collapsed.has(row.dataset.folderId)) hiddenBelow = depth;
    }
  }
  function addFolderToggle(row, folderId, name, collapsed, container) {
    if (!ctx.folders.some(folder => folder.parentId === folderId)) return;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "folder-toggle";
    toggle.innerHTML = iconSvg("chevronRight", 14);
    const update = () => {
      const expanded = !collapsed.has(folderId);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.title = expanded
        ? t("collapseFolder", [name], `收起「${name}」的子文件夹`)
        : t("expandFolder", [name], `展开「${name}」的子文件夹`);
      toggle.setAttribute("aria-label", toggle.title);
    };
    toggle.addEventListener("click", event => {
      event.stopPropagation();
      if (collapsed.has(folderId)) collapsed.delete(folderId);
      else collapsed.add(folderId);
      update();
      updateFolderVisibility(container, collapsed);
    });
    update();
    row.prepend(toggle);
  }
  function expandFolderAncestors(folderId, collapsed) {
    let parentId = ctx.folders.find(folder => folder.id === folderId)?.parentId;
    while (parentId) {
      collapsed.delete(parentId);
      parentId = ctx.folders.find(folder => folder.id === parentId)?.parentId;
    }
  }
  function folderMoveTargets(folderId) {
    const tree = flattenedFolders();
    const source = tree.find(item => item.folder.id === folderId);
    if (!source) return new Set();
    const descendants = descendantIds(folderId);
    const height = Math.max(...tree.filter(item => descendants.has(item.folder.id)).map(item => item.depth)) - source.depth + 1;
    return new Set([null, ...tree.filter(item => !descendants.has(item.folder.id) && item.depth + height <= 3)
      .map(item => item.folder.id)].filter(parentId =>
      !ctx.folders.some(folder => folder.id !== folderId && (folder.parentId || null) === parentId &&
        folder.name.toLocaleLowerCase() === source.folder.name.toLocaleLowerCase())
    ));
  }
  async function updateFolder(folderId, changes) {
    const response = await sendRuntimeMessage({ action: MESSAGE.updateCaseFolder, folderId, changes });
    if (!response?.success) {
      reportError(response?.error || t("updateFolderFailed", [], "更新文件夹失败"));
      return false;
    }
    if (Object.hasOwn(changes, "parentId") && changes.parentId) {
      ctx.collapsedFolders.delete(changes.parentId);
      expandFolderAncestors(changes.parentId, ctx.collapsedFolders);
    }
    await ctx.refresh();
    notify(t("folderUpdated", [], "文件夹已更新"));
    return true;
  }
  function closeFolderMenu() {
    ctx.folderMenu?.remove();
    ctx.folderMenuButton?.setAttribute("aria-expanded", "false");
    ctx.folderMenu = null;
    ctx.folderMenuButton = null;
  }
  function showFolderMenu(button, folderId, name, count) {
    const sameButton = ctx.folderMenuButton === button;
    closeFolderMenu();
    if (sameButton) return;
    const menu = document.createElement("div");
    menu.className = "folder-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", name);
    ctx.folderMenu = menu;
    ctx.folderMenuButton = button;
    button.setAttribute("aria-expanded", "true");
    const addItem = (label, run, disabled = false, hint = "") => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "more-action";
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.disabled = disabled;
      item.title = hint || label;
      item.addEventListener("click", () => {
        closeFolderMenu();
        button.focus();
        run().catch(error => reportError(error.message));
      });
      menu.append(item);
    };
    addItem(t("renameFolder", [], "重命名"), async () => {
      const nextName = await promptText({
        title: t("renameFolder", [], "重命名"), label: t("folderName", [], "文件夹名称"),
        value: name, maxLength: 80, confirmText: t("save", [], "保存")
      });
      if (nextName !== null) await updateFolder(folderId, { name: nextName });
    });
    addItem(t("moveFolder", [], "移动文件夹"), () => ctx.showMoveDialog([], null, folderId));
    addItem(t("deleteFolder", [], "删除文件夹"), async () => {
      const confirmed = await confirmAction({
        title: t("deleteFolder", [], "删除文件夹"),
        message: t("deleteFolderMessage", [name], `确定删除空文件夹「${name}」吗？其空子文件夹也会一并删除。`),
        confirmText: t("delete", [], "删除"), danger: true
      });
      if (!confirmed) return;
      const response = await sendRuntimeMessage({ action: MESSAGE.deleteCaseFolder, folderId });
      if (!response?.success) return reportError(response?.error || t("deleteFolderFailed", [], "删除文件夹失败"));
      if (descendantIds(folderId).has(ctx.activeFolderId)) {
        ctx.activeFolderId = "unfiled";
        searchScope.value = "all";
      }
      await ctx.refresh();
    }, count > 0, count > 0 ? t("folderNotEmptyDeleteHint", [count], `仍有 ${count} 个用例，不能删除`) : "");
    document.body.append(menu);
    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector("button").focus();
  }
  async function createFolder(parentId = null) {
    const name = await promptText({
      title: parentId ? t("createSubfolder", [], "新建子文件夹") : t("createFolder", [], "新建文件夹"),
      message: parentId
        ? t("createSubfolderHint", [folderName(parentId)], `将在「${folderName(parentId)}」下创建文件夹`)
        : "",
      label: t("folderName", [], "文件夹名称"),
      confirmText: t("create", [], "创建"),
      maxLength: 80
    });
    if (name === null) return;
    const response = await sendRuntimeMessage({ action: MESSAGE.createCaseFolder, name, parentId });
    if (!response?.success) return reportError(response?.error || t("createFolderFailed", [], "创建文件夹失败"));
    ctx.activeFolderId = response.folder.id;
    if (parentId) {
      ctx.collapsedFolders.delete(parentId);
      expandFolderAncestors(parentId, ctx.collapsedFolders);
    }
    searchScope.value = "current";
    await ctx.refresh();
  }
  function buildFolderItem({ id, name, count, depth = 0, removable = false }) {
    const row = document.createElement("div");
    row.className = `case-folder-row${removable ? " is-removable" : ""}`;
    row.dataset.folderId = id;
    row.dataset.depth = depth;
    row.style.setProperty("--folder-indent", `${Math.max(0, depth - 1) * 14}px`);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "case-folder-button";
    button.title = name;
    button.classList.toggle("is-active", searchScope.value === "current" && ctx.activeFolderId === id);
    button.innerHTML = iconSvg("folder");
    const label = document.createElement("span");
    label.textContent = name;
    const badge = document.createElement("small");
    badge.textContent = String(count);
    button.append(label, badge);
    button.addEventListener("click", () => {
      ctx.activeFolderId = id;
      searchScope.value = "current";
      ctx.render();
    });
    row.append(button);
    if (removable) {
      addFolderToggle(row, id, name, ctx.collapsedFolders, folderList);
      button.draggable = true;
      button.addEventListener("dragstart", event => {
        closeFolderMenu();
        ctx.draggedFolderId = id;
        ctx.draggedFolderTargets = folderMoveTargets(id);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-workflow-recorder-folder-id", id);
        row.classList.add("is-dragging-folder");
        folderRootTarget.classList.add("is-folder-drop-target");
      });
      button.addEventListener("dragend", ctx.clearDragState);
    }

    row.classList.add("is-drop-target");
    row.addEventListener("dragover", event => {
      if (ctx.draggedFolderId) {
        if (id === "unfiled" || !ctx.draggedFolderTargets.has(id)) {
          event.dataTransfer.dropEffect = "none";
          return;
        }
      } else if (ctx.draggedCaseIds.length === 0) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      row.classList.add("is-drag-over");
    });
    row.addEventListener("dragleave", event => {
      if (!row.contains(event.relatedTarget)) row.classList.remove("is-drag-over");
    });
    row.addEventListener("drop", async event => {
      event.preventDefault();
      row.classList.remove("is-drag-over");
      if (ctx.draggedFolderId) {
        const folderId = ctx.draggedFolderId;
        const allowed = id !== "unfiled" && ctx.draggedFolderTargets.has(id);
        ctx.clearDragState();
        if (allowed) await updateFolder(folderId, { parentId: id });
        return;
      }
      const ids = ctx.readDraggedCaseIds(event.dataTransfer) || ctx.draggedCaseIds;
      if (ids.length === 0) return;
      await ctx.moveCases(ids, id === "unfiled" ? null : id, true);
    });

    if (removable) {
      const actions = document.createElement("div");
      actions.className = "case-folder-actions";
      if (depth < 3) {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "case-folder-add";
        add.title = t("createSubfolder", [], "新建子文件夹");
        add.setAttribute("aria-label", t("createSubfolderUnder", [name], `在「${name}」下新建子文件夹`));
        add.innerHTML = iconSvg("plus");
        add.addEventListener("click", () => createFolder(id));
        actions.append(add);
      }
      const more = document.createElement("button");
      more.type = "button";
      more.className = "case-folder-more";
      more.title = t("folderActions", [], "文件夹操作：重命名、移动、删除");
      more.setAttribute("aria-label", more.title);
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      more.innerHTML = iconSvg("more");
      more.addEventListener("click", () => showFolderMenu(more, id, name, count));
      actions.append(more);
      row.append(actions);
    }
    return row;
  }
  function renderFolders() {
    closeFolderMenu();
    const counts = new Map(ctx.folders.map(folder => [folder.id, 0]));
    let unfiledCount = 0;
    for (const item of ctx.cases) {
      if (item.folderId && counts.has(item.folderId)) {
        let currentId = item.folderId;
        const seen = new Set();
        while (currentId && !seen.has(currentId)) {
          seen.add(currentId);
          counts.set(currentId, (counts.get(currentId) || 0) + 1);
          currentId = ctx.folders.find(folder => folder.id === currentId)?.parentId || null;
        }
      } else unfiledCount++;
    }
    folderList.replaceChildren(
      buildFolderItem({ id: "unfiled", name: t("unfiledCases", [], "未分类"), count: unfiledCount }),
      ...flattenedFolders().map(({ folder, depth }) => buildFolderItem({
        id: folder.id, name: folder.name, count: counts.get(folder.id) || 0, depth, removable: true
      }))
    );
    updateFolderVisibility(folderList, ctx.collapsedFolders);
  }
  function showMoveDialog(caseIds, currentFolderId = null, movingFolderId = null) {
    return new Promise(resolve => {
      const movingFolder = ctx.folders.find(folder => folder.id === movingFolderId);
      const allowedTargets = movingFolderId ? folderMoveTargets(movingFolderId) : null;
      if (movingFolder) currentFolderId = movingFolder.parentId || null;
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";
      overlay.setAttribute("role", "presentation");
      const dialog = document.createElement("div");
      dialog.className = "confirm-dialog move-folder-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "move-folder-title");
      const content = document.createElement("div");
      content.className = "confirm-content";
      const title = document.createElement("h3");
      title.id = "move-folder-title";
      title.textContent = movingFolderId ? t("moveFolder", [], "移动文件夹") : t("moveToFolderTitle", [], "移动至");
      const hint = document.createElement("p");
      hint.textContent = movingFolderId
        ? t("moveFolderHint", [movingFolder?.name || ""], `选择「${movingFolder?.name || ""}」的新父目录，子文件夹和用例会一起移动。`)
        : t("moveToFolderHint", [caseIds.length], `为 ${caseIds.length} 个用例选择目标分类`);
      const choices = document.createElement("div");
      choices.className = "move-folder-choices";
      let selectedFolderId = currentFolderId;
      expandFolderAncestors(currentFolderId, ctx.collapsedMoveFolders);
      const addChoice = (folderId, name, depth) => {
        const row = document.createElement("div");
        row.className = "move-folder-row";
        row.dataset.folderId = folderId || "unfiled";
        row.dataset.depth = depth;
        row.style.setProperty("--folder-indent", `${Math.max(0, depth - 1) * 16}px`);
        const choice = document.createElement("button");
        choice.type = "button";
        choice.className = "move-folder-choice";
        choice.title = name;
        choice.disabled = !!allowedTargets && !allowedTargets.has(folderId);
        choice.classList.toggle("is-selected", selectedFolderId === folderId);
        choice.innerHTML = iconSvg("folder");
        const label = document.createElement("span");
        label.textContent = name;
        choice.append(label);
        choice.addEventListener("click", () => {
          selectedFolderId = folderId;
          choices.querySelectorAll(".is-selected").forEach(item => item.classList.remove("is-selected"));
          choice.classList.add("is-selected");
        });
        row.append(choice);
        if (folderId) addFolderToggle(row, folderId, name, ctx.collapsedMoveFolders, choices);
        choices.append(row);
      };
      addChoice(null, movingFolderId ? t("folderRoot", [], "根目录") : t("unfiledCases", [], "未分类"), 0);
      flattenedFolders().forEach(({ folder, depth }) => addChoice(folder.id, folder.name, depth));
      updateFolderVisibility(choices, ctx.collapsedMoveFolders);
      content.append(title, hint, choices);
      const actions = document.createElement("div");
      actions.className = "confirm-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "confirm-cancel";
      cancel.textContent = t("cancel", [], "取消");
      const submit = document.createElement("button");
      submit.type = "button";
      submit.className = "confirm-submit";
      submit.textContent = t("moveHere", [], "移动到这里");
      actions.append(cancel, submit);
      dialog.append(content, actions);
      overlay.append(dialog);
      const finish = result => {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        resolve(result);
      };
      const onKeyDown = event => {
        if (event.key === "Escape") finish(false);
      };
      cancel.addEventListener("click", () => finish(false));
      submit.addEventListener("click", async () => {
        submit.disabled = true;
        const moved = movingFolderId
          ? await updateFolder(movingFolderId, { parentId: selectedFolderId })
          : await ctx.moveCases(caseIds, selectedFolderId, caseIds.length > 1);
        if (moved) finish(true);
        else submit.disabled = false;
      });
      overlay.addEventListener("click", event => {
        if (event.target === overlay) finish(false);
      });
      document.addEventListener("keydown", onKeyDown);
      document.body.append(overlay);
      choices.querySelector(".is-selected")?.focus();
    });
  }

  Object.assign(ctx, {
    folderName, descendantIds, flattenedFolders, updateFolderVisibility, addFolderToggle,
    expandFolderAncestors, folderMoveTargets, updateFolder, closeFolderMenu, showFolderMenu,
    createFolder, buildFolderItem, renderFolders, showMoveDialog
  });
}

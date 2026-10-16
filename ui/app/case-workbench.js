/** Fullscreen saved-case library: browse, select, share, import, export and delete. */
import { attachFolders } from "./case-folders.js";
import { iconSvg } from "../lib/icons.js";
import { applyFolderColor } from "../lib/folder-colors.js";
import { nameKey } from "../../shared/case-names.js";

if (!globalThis.RecorderCaseWorkbench) {
  function create(options) {
    const {
      list, emptyState, countBadge, selectionLabel, searchInput, searchScope, selectAll,
      allCasesButton, locationTitle, locationMeta, actionbar,
      folderList, createFolderButton, moveToFolderButton, importButton, exportPackageButton,
      exportDocumentsButton, deleteCasesButton, fileInput, onOpenCase, onCasesChanged = () => {}
    } = options;
    const { t } = globalThis.RecorderI18n;
    const { MESSAGE } = globalThis.WorkflowRecorderProtocol;
    const { sendRuntimeMessage } = globalThis.RecorderBridge;
    const { confirmAction, notify, promptText, reportError } = globalThis.RecorderDialogs;
    const { exportWorkflowBatch } = globalThis.RecorderExport;
    const { exportCasePackage, importCasePackage } = globalThis.RecorderCasePackage;

    const ctx = {
      t, MESSAGE, sendRuntimeMessage, confirmAction, notify, promptText, reportError,
      list, emptyState, countBadge, selectionLabel, searchInput, searchScope, selectAll,
      folderList, createFolderButton, moveToFolderButton, importButton, exportPackageButton,
      exportDocumentsButton, deleteCasesButton, fileInput, onOpenCase, onCasesChanged,
      cases: [], folders: [], filteredCases: [], activeFolderId: "unfiled",
      draggedCaseIds: [], selectedIds: new Set(), disposed: false
    };
    attachFolders(ctx);

    function localeTag() {
      return globalThis.RecorderI18n.getLanguage() === "zh_CN" ? "zh-CN" : "en";
    }
    function updateSelection() {
      actionbar?.classList.toggle("has-selection", ctx.selectedIds.size > 0);
      const visibleIds = ctx.filteredCases.map(item => item.id);
      const visibleSelected = visibleIds.filter(id => ctx.selectedIds.has(id)).length;
      selectAll.disabled = visibleIds.length === 0;
      selectAll.checked = visibleIds.length > 0 && visibleSelected === visibleIds.length;
      selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visibleIds.length;
      exportPackageButton.disabled = ctx.selectedIds.size === 0;
      exportDocumentsButton.disabled = ctx.selectedIds.size === 0;
      deleteCasesButton.disabled = ctx.selectedIds.size === 0;
      moveToFolderButton.disabled = ctx.selectedIds.size === 0;
      selectionLabel.textContent = ctx.selectedIds.size > 0
        ? t("selectedCaseCount", [ctx.selectedIds.size], `已选择 ${ctx.selectedIds.size} 个用例`)
        : t("noCaseSelected", [], "未选择用例");
    }
    function actionButton(className, title, icon) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `library-item-btn ${className}`;
      button.title = title;
      button.innerHTML = icon;
      return button;
    }
    /**
     * What deleting these cases would free, or null when it cannot be read.
     *
     * Counts rather than bytes, deliberately. The step count is already in the
     * index and the screenshot keys are already the case's media list, so quoting
     * them costs no blob reads at all; quoting megabytes would mean reading every
     * screenshot just to fill in a dialog, and it would produce a number the user
     * has no way to check. `deletableScreenshotCount` is the one that matters:
     * screenshots shared with another case outlive the deletion, so it can be far
     * smaller than the total, and that is the surprise worth showing.
     *
     * A null answer means the dialog falls back to its plain wording. Refusing to
     * confirm because a count was unavailable would be worse than confirming
     * without one.
     */
    function deletionPreview(caseIds) {
      return sendRuntimeMessage({ action: MESSAGE.previewCaseDeletion, caseIds })
        .then(response => (response?.success ? response : null))
        .catch(() => null);
    }
    function buildItem(caseRecord) {
      const item = document.createElement("article");
      item.className = "library-item";
      item.dataset.caseId = caseRecord.id;
      item.draggable = true;
      item.addEventListener("dragstart", event => {
        ctx.draggedCaseIds = ctx.selectedIds.has(caseRecord.id) ? [...ctx.selectedIds] : [caseRecord.id];
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-workflow-recorder-case-ids", JSON.stringify(ctx.draggedCaseIds));
        event.dataTransfer.setData("text/plain", ctx.draggedCaseIds.join(","));
        item.classList.add("is-dragging");
        list.querySelectorAll(`[data-case-id]`).forEach(candidate => {
          candidate.classList.toggle("is-dragging-group", ctx.draggedCaseIds.includes(candidate.dataset.caseId));
        });
      });
      item.addEventListener("dragend", clearDragState);
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "selection-checkbox library-case-checkbox";
      checkbox.checked = ctx.selectedIds.has(caseRecord.id);
      checkbox.setAttribute("aria-label", t("selectCase", [], "选择用例"));
      checkbox.addEventListener("click", event => event.stopPropagation());
      checkbox.addEventListener("dragstart", event => event.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) ctx.selectedIds.add(caseRecord.id);
        else ctx.selectedIds.delete(caseRecord.id);
        item.classList.toggle("is-selected", checkbox.checked);
        updateSelection();
      });
      const info = document.createElement("button");
      info.type = "button";
      info.className = "library-item-info";
      const name = document.createElement("strong");
      name.textContent = caseRecord.name;
      name.title = caseRecord.name;
      const date = new Date(caseRecord.createdAt).toLocaleString(localeTag(), {
        year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
      });
      const meta = document.createElement("span");
      const showFolder = searchScope.value === "all"
        || (ctx.activeFolderId !== "unfiled" && caseRecord.folderId !== ctx.activeFolderId);
      meta.textContent = t("stepsMeta", [caseRecord.stepCount, date], `${caseRecord.stepCount} 个步骤 · ${date}`);
      if (showFolder) {
        meta.append(document.createTextNode(" · "));
        const folders = ctx.folderAncestors(caseRecord.folderId);
        const path = folders.length ? folders : [{ id: null, name: t("unfiledCases", [], "未分类") }];
        path.forEach((folder, index) => {
          if (index) meta.append(document.createTextNode(" / "));
          const label = document.createElement("span");
          label.className = "case-folder-label";
          label.dataset.folderId = folder.id || "unfiled";
          label.textContent = folder.name;
          applyFolderColor(label, folder.id ? index + 1 : 0);
          meta.append(label);
        });
      }
      meta.title = meta.textContent;
      info.append(name, meta);
      info.addEventListener("click", () => onOpenCase(caseRecord));
      const actions = document.createElement("div");
      actions.className = "library-item-actions";
      const rename = actionButton("rename", t("renameCase", [], "重命名用例"), iconSvg("pencil"));
      rename.setAttribute("aria-label", t("renameCaseNamed", [caseRecord.name], `重命名用例「${caseRecord.name}」`));
      rename.addEventListener("click", async () => {
        try {
          const name = await promptText({
            title: t("renameCase", [], "重命名用例"), label: t("caseName", [], "用例名称"),
            value: caseRecord.name, maxLength: 120, confirmText: t("save", [], "保存"),
            validate: name => !name || name.length > 120
              ? t("errorInvalidCaseName", [], "请输入 1–120 个字符的用例名称")
              : name !== caseRecord.name && ctx.cases.some(item => item.id !== caseRecord.id
                && (item.folderId || null) === (caseRecord.folderId || null) && nameKey(item.name) === nameKey(name))
                ? t("errorCaseNameExists", [], "当前文件夹已存在同名用例，请换一个名称") : ""
          });
          if (name === null || name === caseRecord.name) return;
          const response = await sendRuntimeMessage({ action: MESSAGE.renameCase, caseId: caseRecord.id, name });
          if (!response?.success) return reportError(response?.error || t("renameCaseFailed", [], "重命名用例失败"));
          await refresh();
        } catch (error) { reportError(error.message); }
      });
      rename.addEventListener("dragstart", event => event.stopPropagation());
      const move = actionButton(
        "move", t("moveCaseToFolder", [], "移动至"),
        iconSvg("folderCheck")
      );
      move.setAttribute("aria-label", t("moveCaseToFolderNamed", [caseRecord.name], `移动用例「${caseRecord.name}」至`));
      move.addEventListener("click", () => ctx.showMoveDialog([caseRecord.id], caseRecord.folderId || null));
      move.addEventListener("dragstart", event => event.stopPropagation());
      const remove = actionButton(
        "delete", t("deleteCase", [], "删除用例"),
        iconSvg("trash")
      );
      remove.addEventListener("click", async () => {
        const preview = await deletionPreview([caseRecord.id]);
        const message = preview
          ? t(
            "deleteCaseMessageWithCounts",
            [
              caseRecord.name,
              preview.stepCount,
              preview.screenshotCount,
              preview.deletableScreenshotCount
            ],
            `确定删除用例「${caseRecord.name}」吗？共 ${preview.stepCount} 个步骤、`
            + `${preview.screenshotCount} 张截图，其中 ${preview.deletableScreenshotCount} 张会一并删除。`
            + "此操作不可恢复。"
          )
          : t("deleteCaseMessage", [caseRecord.name], `确定删除用例「${caseRecord.name}」吗？此操作不可恢复。`);
        const confirmed = await confirmAction({
          title: t("deleteCase", [], "删除用例"),
          message,
          confirmText: t("delete", [], "删除"), danger: true
        });
        if (!confirmed) return;
        const response = await sendRuntimeMessage({ action: MESSAGE.deleteCase, caseId: caseRecord.id });
        if (!response?.success) {
          reportError(response?.error || t("deleteCaseFailed", [], "删除用例失败"));
          return;
        }
        ctx.selectedIds.delete(caseRecord.id);
        await refresh();
        if (response.cleanupPending) notify(t("screenshotCleanupDeferred", [], "用例已删除，截图将在后台重试清理"));
      });
      remove.addEventListener("dragstart", event => event.stopPropagation());
      actions.append(rename, move, remove);
      item.classList.toggle("is-selected", checkbox.checked);
      const symbol = document.createElement("span");
      symbol.className = "library-item-symbol";
      symbol.innerHTML = iconSvg("document", 20);
      item.append(checkbox, symbol, info, actions);
      return item;
    }
    function readDraggedCaseIds(dataTransfer) {
      try {
        const raw = dataTransfer?.getData("application/x-workflow-recorder-case-ids");
        const ids = JSON.parse(raw || "null");
        return Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === "string" && id))] : null;
      } catch { return null; }
    }
    function clearDragState() {
      ctx.draggedCaseIds = [];
      ctx.draggedFolderId = null;
      ctx.draggedFolderTargets.clear();
      ctx.folderRootTarget.classList.remove("is-folder-drop-target", "is-drag-over");
      folderList.querySelectorAll(".is-dragging-folder").forEach(row => row.classList.remove("is-dragging-folder"));
      list.querySelectorAll(".is-dragging, .is-dragging-group").forEach(item => {
        item.classList.remove("is-dragging", "is-dragging-group");
      });
      folderList.querySelectorAll(".is-drag-over").forEach(folder => folder.classList.remove("is-drag-over"));
    }
    async function moveCases(caseIds, folderId, clearSelection = false) {
      const response = await sendRuntimeMessage({ action: MESSAGE.moveCasesToFolder, caseIds, folderId });
      if (!response?.success) {
        reportError(response?.error || t("moveCasesFailed", [], "移动用例失败"));
        return false;
      }
      if (clearSelection) ctx.selectedIds.clear();
      notify(t("casesMoved", [response.movedCount], `已移动 ${response.movedCount} 个用例`)
        + (response.renamedCount ? t("duplicateNamesAdjusted", [response.renamedCount], `；${response.renamedCount} 个重名用例已自动添加编号`) : ""));
      await refresh();
      return true;
    }
    function openFolder(folderId) {
      ctx.selectedIds.clear();
      ctx.activeFolderId = folderId;
      searchScope.value = "current";
      ctx.expandFolderAncestors(folderId, ctx.collapsedFolders);
      render();
      locationTitle?.setAttribute("tabindex", "-1");
      locationTitle?.focus({ preventScroll: true });
    }
    function buildSubfolderItems() {
      const children = searchScope.value === "current"
        ? ctx.folders.filter(folder => folder.parentId === ctx.activeFolderId)
          .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
        : [];
      return children.map(folder => {
        const descendants = ctx.descendantIds(folder.id);
        const count = ctx.cases.filter(item => descendants.has(item.folderId)).length;
        const card = document.createElement("div");
        card.className = "library-folder-item subfolder-card";
        card.dataset.subfolderId = folder.id;
        applyFolderColor(card, ctx.folderAncestors(folder.id).length);
        const open = document.createElement("button");
        open.type = "button";
        open.className = "library-item-info subfolder-open subfolder-info";
        open.title = folder.name;
        const placeholder = document.createElement("span");
        placeholder.setAttribute("aria-hidden", "true");
        const symbol = document.createElement("span");
        symbol.className = "library-item-symbol";
        symbol.innerHTML = iconSvg("folder", 20);
        const name = document.createElement("strong");
        name.textContent = folder.name;
        const meta = document.createElement("span");
        meta.textContent = t("visibleCaseCount", [count], `${count} 个用例`);
        open.append(name, meta);
        open.addEventListener("click", () => openFolder(folder.id));
        const more = document.createElement("button");
        more.type = "button";
        more.className = "library-item-btn subfolder-more";
        more.innerHTML = iconSvg("more");
        more.title = t("folderActions", [], "文件夹操作：重命名、移动、删除");
        more.setAttribute("aria-label", `${folder.name} · ${more.title}`);
        more.setAttribute("aria-haspopup", "menu");
        more.setAttribute("aria-expanded", "false");
        more.addEventListener("click", () => ctx.showFolderMenu(more, folder.id, folder.name, count));
        const actions = document.createElement("div");
        actions.className = "library-item-actions";
        actions.append(more);
        card.append(placeholder, symbol, open, actions);
        return card;
      });
    }

    function render() {
      const query = searchInput.value.trim().toLocaleLowerCase(localeTag());
      ctx.filteredCases = ctx.cases.filter(item => {
        const hasKnownFolder = item.folderId && ctx.folders.some(folder => folder.id === item.folderId);
        const activeFolderIds = ctx.activeFolderId !== "unfiled" ? ctx.descendantIds(ctx.activeFolderId) : null;
        const inFolder = searchScope.value === "all"
          || (ctx.activeFolderId === "unfiled" ? !hasKnownFolder : activeFolderIds.has(item.folderId));
        return inFolder && (!query || item.name.toLocaleLowerCase(localeTag()).includes(query));
      });
      const visibleIds = new Set(ctx.filteredCases.map(item => item.id));
      for (const id of ctx.selectedIds) if (!visibleIds.has(id)) ctx.selectedIds.delete(id);
      const subfolders = buildSubfolderItems();
      list.replaceChildren(...subfolders, ...ctx.filteredCases.map(buildItem));
      countBadge.textContent = String(ctx.cases.length);
      allCasesButton?.classList.toggle("is-active", searchScope.value === "all");
      allCasesButton?.setAttribute("aria-pressed", String(searchScope.value === "all"));
      if (locationTitle) {
        const ancestors = [];
        const visited = new Set();
        let folder = ctx.folders.find(item => item.id === ctx.activeFolderId);
        while (folder && !visited.has(folder.id)) {
          ancestors.unshift(folder);
          visited.add(folder.id);
          folder = ctx.folders.find(item => item.id === folder.parentId);
        }
        locationTitle.replaceChildren();
        if (searchScope.value === "all" || ancestors.length === 0) {
          locationTitle.textContent = searchScope.value === "all"
            ? t("allCases", [], "全部用例") : t("unfiledCases", [], "未分类");
        } else {
          ancestors.forEach((ancestor, index) => {
            if (index > 0) {
              const separator = document.createElement("span");
              separator.className = "library-path-separator";
              separator.textContent = " / ";
              separator.setAttribute("aria-hidden", "true");
              locationTitle.append(separator);
            }
            const current = index === ancestors.length - 1;
            const part = document.createElement(current ? "span" : "button");
            part.className = "library-path-part";
            part.textContent = ancestor.name;
            if (current) {
              part.setAttribute("aria-current", "location");
            } else {
              part.type = "button";
              part.dataset.folderId = ancestor.id;
              part.addEventListener("click", () => openFolder(ancestor.id));
            }
            locationTitle.append(part);
          });
        }
        locationTitle.title = locationTitle.textContent;
      }
      if (locationMeta) locationMeta.textContent = t("visibleCaseCount", [ctx.filteredCases.length], `${ctx.filteredCases.length} 个用例`);
      ctx.renderFolders();
      const hasItems = subfolders.length > 0 || ctx.filteredCases.length > 0;
      emptyState.hidden = hasItems;
      list.hidden = !hasItems;
      const title = emptyState.querySelector("p");
      const hint = emptyState.querySelector("span");
      if (query && ctx.filteredCases.length === 0) {
        title.textContent = t("noMatchingCases", [], "没有匹配的用例");
        hint.textContent = t("tryAnotherSearch", [], "请尝试其他关键词");
      } else if (ctx.cases.length > 0 && ctx.filteredCases.length === 0) {
        title.textContent = t("folderHasNoCases", [], "此文件夹中暂无用例");
        hint.textContent = t("moveCasesIntoFolder", [], "选择其他位置的用例后，可将它们移动到此文件夹");
      } else {
        title.textContent = t("noSavedCases", [], "暂无保存的用例");
        hint.textContent = t("recordCasesInSidePanel", [], "请先在侧边栏完成录制并保存为用例");
      }
      updateSelection();
    }
    async function refresh() {
      const [caseResponse, folderResponse] = await Promise.all([
        sendRuntimeMessage({ action: MESSAGE.listCases }),
        sendRuntimeMessage({ action: MESSAGE.listCaseFolders })
      ]);
      if (!caseResponse?.success) throw new Error(caseResponse?.error || t("listCasesFailed", [], "读取历史用例失败"));
      if (!folderResponse?.success) throw new Error(folderResponse?.error || t("listFoldersFailed", [], "读取文件夹失败"));
      ctx.cases = caseResponse.cases || [];
      ctx.folders = folderResponse.folders || [];
      const liveFolderIds = new Set(ctx.folders.map(folder => folder.id));
      for (const collapsed of [ctx.collapsedFolders, ctx.collapsedMoveFolders]) {
        for (const id of collapsed) if (!liveFolderIds.has(id)) collapsed.delete(id);
      }
      if (ctx.activeFolderId !== "unfiled" && !ctx.folders.some(folder => folder.id === ctx.activeFolderId)) {
        ctx.activeFolderId = "unfiled";
      }
      const liveIds = new Set(ctx.cases.map(item => item.id));
      for (const id of ctx.selectedIds) if (!liveIds.has(id)) ctx.selectedIds.delete(id);
      render();
      onCasesChanged(ctx.cases);
    }
    async function readSelectedCases() {
      const details = [];
      const failed = [];
      for (const summary of ctx.cases.filter(item => ctx.selectedIds.has(item.id))) {
        const response = await sendRuntimeMessage({ action: MESSAGE.getCaseDetails, caseId: summary.id }, 30000);
        if (!response?.success) failed.push(summary.name);
        else details.push(response.case);
      }
      if (failed.length > 0) {
        reportError(t("exportCaseReadFailed", [failed.join("、")], `以下用例读取失败：${failed.join("、")}`));
      }
      return details;
    }

    ctx.render = render;
    ctx.refresh = refresh;
    ctx.readDraggedCaseIds = readDraggedCaseIds;
    ctx.clearDragState = clearDragState;
    ctx.moveCases = moveCases;

    selectAll.addEventListener("change", () => {
      ctx.filteredCases.forEach(item => {
        if (selectAll.checked) ctx.selectedIds.add(item.id);
        else ctx.selectedIds.delete(item.id);
      });
      render();
    });
    searchInput.addEventListener("input", render);
    searchScope.addEventListener("change", () => { ctx.selectedIds.clear(); render(); });
    allCasesButton?.addEventListener("click", () => {
      ctx.selectedIds.clear();
      searchScope.value = "all";
      render();
    });
    createFolderButton.addEventListener("click", async () => { await ctx.createFolder(); });
    moveToFolderButton.addEventListener("click", async () => { await ctx.showMoveDialog([...ctx.selectedIds]); });
    deleteCasesButton.addEventListener("click", async () => {
      const caseIds = [...ctx.selectedIds];
      const count = caseIds.length;
      if (count === 0) return;
      const preview = await deletionPreview(caseIds);
      const message = preview
        ? t(
          "batchDeleteCasesMessageWithCounts",
          [count, preview.stepCount, preview.screenshotCount, preview.deletableScreenshotCount],
          `确定删除选中的 ${count} 个用例吗？共 ${preview.stepCount} 个步骤、`
          + `${preview.screenshotCount} 张截图，其中 ${preview.deletableScreenshotCount} 张会一并删除。`
          + "此操作不可恢复。"
        )
        : t("batchDeleteCasesMessage", [count], `确定删除选中的 ${count} 个用例吗？此操作不可恢复。`);
      const confirmed = await confirmAction({
        title: t("deleteCase", [], "删除用例"),
        message,
        confirmText: t("delete", [], "删除"), danger: true
      });
      if (!confirmed) return;
      deleteCasesButton.disabled = true;
      const response = await sendRuntimeMessage({ action: MESSAGE.deleteCases, caseIds });
      if (!response?.success) {
        reportError(response?.error || t("deleteCasesFailed", [], "批量删除用例失败"));
        updateSelection();
        return;
      }
      ctx.selectedIds.clear();
      notify(t("casesDeleted", [response.deletedCount], `已删除 ${response.deletedCount} 个用例`));
      await refresh();
      if (response.cleanupPending) notify(t("screenshotCleanupDeferred", [], "用例已删除，截图将在后台重试清理"));
    });
    exportDocumentsButton.addEventListener("click", async () => {
      exportDocumentsButton.disabled = true;
      try {
        const details = await readSelectedCases();
        if (details.length > 0) {
          const stamp = new Date().toISOString().slice(0, 10);
          await exportWorkflowBatch(details, `${t("batchCaseArchive", [], "批量用例")}-${stamp}`);
        }
      } catch (error) {
        reportError(error.message || t("exportFailed", [], "导出失败"));
      } finally { updateSelection(); }
    });
    exportPackageButton.addEventListener("click", async () => {
      exportPackageButton.disabled = true;
      try {
        const details = await readSelectedCases();
        if (details.length > 0) {
          const name = details.length === 1
            ? details[0].name
            : `${t("sharedCasePackage", [], "共享用例包")}-${new Date().toISOString().slice(0, 10)}`;
          await exportCasePackage(details, name);
          notify(t("casePackageExported", [details.length], `已导出 ${details.length} 个可分享用例`));
        }
      } catch (error) {
        reportError(error.message || t("exportCasePackageFailed", [], "导出用例包失败"));
      } finally { updateSelection(); }
    });
    importButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (!file) return;
      importButton.disabled = true;
      try {
        const result = await importCasePackage(file);
        notify(t("casePackageImported", [result.importedCount], `已导入 ${result.importedCount} 个用例`)
          + (result.renamedCount ? t("duplicateNamesAdjusted", [result.renamedCount], `；${result.renamedCount} 个重名用例已自动添加编号`) : ""));
        await refresh();
      } catch (error) {
        reportError(error.message || t("importCasesFailed", [], "导入用例失败"));
      } finally { importButton.disabled = false; }
    });
    const onStorageChanged = (changes, area) => {
      if (!ctx.disposed && area === "local" && (changes.caseIndex || changes.caseFolders)) {
        refresh().catch(error => reportError(error.message));
      }
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    const onMenuPointerDown = event => {
      if (ctx.folderMenu && !ctx.folderMenu.contains(event.target) && !ctx.folderMenuButton?.contains(event.target)) ctx.closeFolderMenu();
    };
    const onMenuKeyDown = event => {
      if (!ctx.folderMenu) return;
      if (event.key === "Escape") {
        const button = ctx.folderMenuButton;
        ctx.closeFolderMenu();
        button?.focus();
      } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        const items = [...ctx.folderMenu.querySelectorAll("button:not(:disabled)")];
        const index = items.indexOf(document.activeElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      }
    };
    document.addEventListener("pointerdown", onMenuPointerDown);
    document.addEventListener("keydown", onMenuKeyDown);
    window.addEventListener("resize", ctx.closeFolderMenu);
    folderList.parentElement.addEventListener("scroll", ctx.closeFolderMenu);
    const onRootDragOver = event => {
      if (!ctx.draggedFolderId || !ctx.draggedFolderTargets.has(null)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      ctx.folderRootTarget.classList.add("is-drag-over");
    };
    const onRootDragLeave = event => {
      if (!ctx.folderRootTarget.contains(event.relatedTarget)) ctx.folderRootTarget.classList.remove("is-drag-over");
    };
    const onRootDrop = async event => {
      if (!ctx.draggedFolderId) return;
      event.preventDefault();
      const folderId = ctx.draggedFolderId;
      const allowed = ctx.draggedFolderTargets.has(null);
      clearDragState();
      if (allowed) await ctx.updateFolder(folderId, { parentId: null });
    };
    ctx.folderRootTarget.addEventListener("dragover", onRootDragOver);
    ctx.folderRootTarget.addEventListener("dragleave", onRootDragLeave);
    ctx.folderRootTarget.addEventListener("drop", onRootDrop);

    function dispose() {
      ctx.disposed = true;
      ctx.closeFolderMenu();
      document.removeEventListener("pointerdown", onMenuPointerDown);
      document.removeEventListener("keydown", onMenuKeyDown);
      window.removeEventListener("resize", ctx.closeFolderMenu);
      folderList.parentElement.removeEventListener("scroll", ctx.closeFolderMenu);
      ctx.folderRootTarget.removeEventListener("dragover", onRootDragOver);
      ctx.folderRootTarget.removeEventListener("dragleave", onRootDragLeave);
      ctx.folderRootTarget.removeEventListener("drop", onRootDrop);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    }
    return { dispose, refresh };
  }
  globalThis.RecorderCaseWorkbench = { create };
}
export {};

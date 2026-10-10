/**
 * Case storage and workspace lifecycle.
 *
 * The stored layout lives in case-store.js; this module owns what a case *means*
 * to the workspace: which one is the active baseline, what happens to the open
 * steps when another one is loaded, and when media becomes unreferenced.
 *
 * Every entry point waits on the case store coordinator first. Reads therefore
 * never observe a half-converted profile, and writes are refused outright while
 * the store is not writable -- a conversion that failed must not be able to
 * silently discard the user's open steps.
 */
import * as caseStore from "./case-store.js";
import { isReadableCase } from "./schema.js";
import * as actionStore from "./actions.js";
import { ORIGIN_KEY, lineageFor, originFor, readOrigin, tombstone } from "./workspace-origin.js";

export function createCaseManager({
  t,
  notifyStepsUpdated,
  deleteScreenshots,
  readReferencedScreenshotKeys,
  caseStoreReady,
  queueCaseWrite
}) {
  function generateCaseId() {
    return `case_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function generateFolderId() {
    return `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function defaultCaseName() {
    const time = new Date().toLocaleString(chrome.i18n.getUILanguage(), {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
    return t("defaultCaseName", [time], `用例 ${time}`);
  }

  function storeUnavailableError(state) {
    if (state.reason === "newer") {
      return t(
        "errorCaseStoreNewer",
        [],
        "用例数据由更新版本的扩展保存，当前版本无法修改。请升级扩展后重试。"
      );
    }
    return t(
      "errorCaseStoreUpgradeIncomplete",
      [],
      "用例存储升级尚未完成，暂时无法修改用例。请重启浏览器后重试。"
    );
  }

  /** Null when case records may be written, a user-facing reason when not. */
  async function blockedReason() {
    const state = await caseStoreReady();
    return state.writable ? null : storeUnavailableError(state);
  }

  function collectPages(actions) {
    const pagesByName = new Map();
    actions.forEach(action => {
      const pageName = action.pageName || "page1";
      if (!pagesByName.has(pageName)) {
        pagesByName.set(pageName, {
          name: pageName,
          url: action.url || "",
          title: action.title || ""
        });
      }
    });
    return Array.from(pagesByName.values());
  }

  function saveCase(name, snapshot = false, folderId = null) {
    const write = () => saveCaseUnlocked(name, snapshot, folderId);
    return globalThis.RecorderMediaStore?.withWriteLock
      ? globalThis.RecorderMediaStore.withWriteLock(write)
      : write();
  }

  async function saveCaseUnlocked(name, snapshot = false, folderId = null) {
    const blocked = await blockedReason();
    if (blocked) return { success: false, error: blocked };

    if (name != null && (typeof name !== "string" || name.length > 120)) {
      return { success: false, error: t("errorInvalidCaseName", [], "请输入 1–120 个字符的用例名称") };
    }
    name = name?.trim();

    if (folderId !== null && (typeof folderId !== "string" || !folderId)) {
      return { success: false, error: t("errorFolderNotFound", [], "文件夹不存在") };
    }
    if (folderId && !(await caseStore.readFolders()).some(folder => folder.id === folderId)) {
      return { success: false, error: t("errorFolderNotFound", [], "文件夹不存在") };
    }

    const actions = await actionStore.readActions();
    if (actions.length === 0) {
      return { success: false, error: t("errorNoStepsToSave", [], "当前没有可保存的步骤") };
    }

    const origin = await readOrigin();
    const caseRecord = {
      id: generateCaseId(),
      name: name || defaultCaseName(),
      folderId,
      createdAt: Date.now(),
      actions: structuredClone(actions),
      pages: collectPages(actions),
      // Null for a workspace that was not loaded from a case, which is what makes
      // it a root in the relationship graph.
      lineage: lineageFor(origin, actions)
    };

    // A snapshot is banked without becoming the baseline: the workspace stays
    // marked unsaved, keeps recording into the same session, and keeps pointing at
    // the case it came from. Several snapshots of one session therefore end up as
    // siblings under the same parent rather than a chain through each other.
    //
    // A normal save does become the baseline, so continuing after it produces
    // A -> B -> D rather than a second child of A. Written together with the case
    // so an origin can never name a case that failed to save.
    const entry = await caseStore.writeCase(
      caseRecord,
      snapshot ? {} : {
        activeCaseId: caseRecord.id,
        [ORIGIN_KEY]: originFor(caseRecord, actions)
      }
    );
    return { success: true, case: entry };
  }

  /**
   * Banks the open steps before something is about to discard them.
   *
   * Returns null when there is nothing to bank, so callers can tell "nothing to
   * do" apart from "could not be saved" and refuse to clear in the second case.
   */
  async function autoSaveWorkspace() {
    const { activeCaseId } = await chrome.storage.local.get("activeCaseId");
    if (activeCaseId || (await actionStore.countActions()) === 0) return null;
    return saveCase();
  }

  async function createNewCase() {
    const { isRecording } = await chrome.storage.local.get("isRecording");
    if (isRecording) {
      return { success: false, error: t("errorCaseChangeWhileRecording", [], "录制进行中，无法切换用例") };
    }
    const banked = await autoSaveWorkspace();
    if (banked && !banked.success) return banked;

    await actionStore.clearActions();
    await chrome.storage.local.set({
      tabsMapping: {},
      nextPageNumber: 1,
      activeCaseId: null,
      // Only a deliberate clear drops the origin. Appending steps and binding
      // screenshots must not, or continuing a recording would lose the very
      // relationship it is creating.
      [ORIGIN_KEY]: null
    });
    return { success: true };
  }

  /**
   * Discards the open workspace without touching any saved case.
   *
   * Unlike `createNewCase`, this is the explicit destructive action from the
    * recorder's step toolbar, so it does not auto-save the current draft first.
   * Media is collected only after the workspace references are gone, and through
   * the reference-aware path so screenshots shared with a saved case survive.
   */
  async function clearWorkspace() {
    const { isRecording } = await chrome.storage.local.get("isRecording");
    if (isRecording) {
      return { success: false, error: t("errorClearWhileRecording", [], "请先暂停录制，再清空步骤") };
    }

    const actions = await actionStore.readActions();
    const screenshotKeys = actions.flatMap(action => [
      action?.screenshotBeforeKey,
      action?.screenshotKey
    ]).filter(Boolean);

    await actionStore.clearActions();
    await chrome.storage.local.set({
      tabsMapping: {},
      nextPageNumber: 1,
      activeCaseId: null,
      [ORIGIN_KEY]: null
    });
    const cleanup = await deleteScreenshots(screenshotKeys);
    notifyStepsUpdated();
    return { success: true, cleanupPending: !!cleanup?.pending };
  }

  function nextPageNumberFor(pages) {
    return Math.max(
      pages.length + 1,
      ...pages.map(page => {
        const match = /^page(\d+)$/.exec(page.name);
        return match ? Number(match[1]) + 1 : 1;
      })
    );
  }

  /**
   * Reads one case's steps, flagging the index entry when they turn out to be
   * unloadable. Without that write-back the panel would keep offering a record
   * that fails every time it is clicked.
   */
  async function readDetailOrFlag(caseId, serialized = false) {
    const detail = await caseStore.readDetail(caseId);
    if (isReadableCase(detail)) return { detail };
    const flag = () => caseStore.markUnreadable(caseId);
    // Loading is already on the case queue. Queries must enqueue only their
    // write-back, otherwise they can overwrite an index committed by a save.
    if (serialized) await flag();
    else await queueCaseWrite(flag);
    return {
      error: t(
        "errorCaseSchemaUnsupported",
        [],
        "该用例由不兼容的旧版本保存，无法加载。请删除后重新录制。"
      )
    };
  }

  /** Loads a saved case's complete steps into the recording workspace. */
  async function loadCase(caseId) {
    await caseStoreReady();
    const { isRecording } = await chrome.storage.local.get("isRecording");
    if (isRecording) {
      return { success: false, error: t("errorCaseChangeWhileRecording", [], "录制进行中，无法切换用例") };
    }

    const entry = await caseStore.readEntry(caseId);
    if (!entry) return { success: false, error: t("errorCaseNotFound", [], "用例不存在") };
    const { detail, error } = await readDetailOrFlag(caseId, true);
    if (error) return { success: false, error };

    const actions = detail.actions;
    await actionStore.replaceActions(structuredClone(actions));
    await chrome.storage.local.set({
      tabsMapping: {},
      nextPageNumber: nextPageNumberFor(collectPages(actions)),
      activeCaseId: caseId,
      [ORIGIN_KEY]: originFor(entry, actions)
    });
    notifyStepsUpdated();
    return { success: true, case: entry, stepCount: actions.length };
  }

  /** Full steps for one case: loading, read-only preview and export. */
  async function getDetails(caseId) {
    await caseStoreReady();
    const entry = await caseStore.readEntry(caseId);
    if (!entry) return { success: false, error: t("errorCaseNotFound", [], "用例不存在") };
    const { detail, error } = await readDetailOrFlag(caseId);
    if (error) return { success: false, error };

    return {
      success: true,
      case: {
        id: entry.id,
        name: entry.name,
        createdAt: entry.createdAt,
        stepCount: entry.stepCount,
        lineage: entry.lineage || null,
        actions: detail.actions,
        pages: detail.pages,
        kind: entry.kind || null,
        ...(detail.composition ? { composition: detail.composition } : {}),
        ...(detail.flowEdges ? { flowEdges: detail.flowEdges } : {})
      }
    };
  }

  /** Stores a validated, already-remapped portable package without loading it. */
  async function importCases(records) {
    const blocked = await blockedReason();
    if (blocked) return { success: false, error: blocked };
    if (!Array.isArray(records) || records.length === 0 || records.length > 200) {
      return { success: false, error: t("errorInvalidCasePackage", [], "用例包内容无效") };
    }

    const existingIds = new Set((await caseStore.readIndex()).map(entry => entry.id));
    const incomingIds = new Set();
    let totalSteps = 0;
    for (const record of records) {
      const validId = typeof record?.id === "string" && /^case_import_[a-z0-9_-]+$/i.test(record.id);
      const validName = typeof record?.name === "string" && record.name.trim() && record.name.length <= 120;
      const validShape = Array.isArray(record?.actions) && Array.isArray(record?.pages);
      totalSteps += validShape ? record.actions.length : 0;
      if (
        !validId || !validName || !validShape || record.actions.length > 10000 ||
        existingIds.has(record.id) || incomingIds.has(record.id)
      ) {
        return { success: false, error: t("errorInvalidCasePackage", [], "用例包内容无效") };
      }
      incomingIds.add(record.id);
    }
    if (totalSteps > 50000) {
      return { success: false, error: t("errorCasePackageTooLarge", [], "用例包过大，无法导入") };
    }

    // A package may contain only a selected child. Such a case is promoted to a
    // root by the page before it gets here; accepting an external parent id would
    // create a misleading relation to an unrelated local case with the same id.
    const validRecords = records.map(record => {
      const parentId = record.lineage?.parentCaseId;
      return {
        id: record.id,
        name: record.name.trim(),
        createdAt: Number(record.createdAt) || Date.now(),
        actions: structuredClone(record.actions),
        pages: structuredClone(record.pages),
        lineage: parentId && incomingIds.has(parentId) ? structuredClone(record.lineage) : null
      };
    });
    const entries = await caseStore.writeCases(validRecords);
    return { success: true, importedCount: entries.length, cases: entries };
  }

  async function listFolders() {
    await caseStoreReady();
    return { success: true, folders: await caseStore.readFolders() };
  }

  function folderDepth(folders, folderId) {
    if (!folderId) return 0;
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    let depth = 0;
    let current = byId.get(folderId);
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      depth++;
      current = current.parentId ? byId.get(current.parentId) : null;
    }
    return depth;
  }

  async function createFolder(name, parentId = null) {
    const blocked = await blockedReason();
    if (blocked) return { success: false, error: blocked };

    const normalized = typeof name === "string" ? name.trim() : "";
    if (!normalized || normalized.length > 80) {
      return { success: false, error: t("errorInvalidFolderName", [], "请输入 1 至 80 个字符的文件夹名称") };
    }
    const folders = await caseStore.readFolders();
    const normalizedParentId = typeof parentId === "string" && parentId ? parentId : null;
    if (normalizedParentId && !folders.some(folder => folder.id === normalizedParentId)) {
      return { success: false, error: t("errorFolderNotFound", [], "文件夹不存在") };
    }
    if (folderDepth(folders, normalizedParentId) >= 3) {
      return { success: false, error: t("errorFolderDepthLimit", [], "文件夹最多支持三级") };
    }
    const duplicate = folders.some(folder =>
      (folder.parentId || null) === normalizedParentId &&
      folder.name.toLocaleLowerCase() === normalized.toLocaleLowerCase()
    );
    if (duplicate) {
      return { success: false, error: t("errorFolderNameExists", [], "已存在同名文件夹") };
    }

    const folder = {
      id: generateFolderId(),
      name: normalized,
      createdAt: Date.now(),
      parentId: normalizedParentId
    };
    await caseStore.writeFolder(folder);
    return { success: true, folder };
  }

  async function updateFolder(folderId, changes) {
    const blocked = await blockedReason();
    if (blocked) return { success: false, error: blocked };
    if (typeof folderId !== "string" || !folderId) {
      return { success: false, error: t("errorFolderNotFound", [], "文件夹不存在") };
    }

    const isPlainObject = changes !== null && typeof changes === "object"
      && [Object.prototype, null].includes(Object.getPrototypeOf(changes));
    const hasName = isPlainObject && Object.hasOwn(changes, "name");
    const hasParentId = isPlainObject && Object.hasOwn(changes, "parentId");
    const name = hasName && typeof changes.name === "string" ? changes.name.trim() : "";
    if (
      !isPlainObject || Reflect.ownKeys(changes).some(key => key !== "name" && key !== "parentId") ||
      (hasName && (!name || name.length > 80)) ||
      (hasParentId && changes.parentId !== null &&
        (typeof changes.parentId !== "string" || !changes.parentId.trim()))
    ) {
      return { success: false, error: t("errorInvalidFolderUpdate", [], "文件夹更新参数无效") };
    }

    const folders = await caseStore.readFolders();
    const folder = folders.find(item => item.id === folderId);
    if (!folder) return { success: false, error: t("errorFolderNotFound", [], "文件夹不存在") };

    const parentId = hasParentId ? changes.parentId : (folder.parentId || null);
    if (parentId && !folders.some(item => item.id === parentId)) {
      return { success: false, error: t("errorFolderNotFound", [], "文件夹不存在") };
    }
    const updated = { ...folder, name: hasName ? name : folder.name, parentId };
    if (updated.name === folder.name && parentId === (folder.parentId || null)) {
      return { success: true, folder };
    }

    if (parentId !== (folder.parentId || null)) {
      const subtreeIds = caseStore.descendantFolderIds(folders, folderId);
      if (subtreeIds.has(parentId)) {
        return { success: false, error: t("errorFolderMoveCycle", [], "不能将文件夹移入自身或其子文件夹") };
      }
      // Check every descendant at its new depth, not just the moved folder.
      const movedFolders = folders.map(item => item.id === folderId ? updated : item);
      if (movedFolders.some(item => subtreeIds.has(item.id) && folderDepth(movedFolders, item.id) > 3)) {
        return { success: false, error: t("errorFolderDepthLimit", [], "文件夹最多支持三级") };
      }
    }
    const duplicate = folders.some(item =>
      item.id !== folderId && (item.parentId || null) === parentId &&
      item.name.toLocaleLowerCase() === updated.name.toLocaleLowerCase()
    );
    if (duplicate) {
      return { success: false, error: t("errorFolderNameExists", [], "已存在同名文件夹") };
    }

    await caseStore.writeFolder(updated);
    return { success: true, folder: updated };
  }

  async function removeFolder(folderId) {
    const blocked = await blockedReason();
    if (blocked) return { success: false, error: blocked };
    if (typeof folderId !== "string" || !folderId) {
      return { success: false, error: t("errorFolderNotFound", [], "文件夹不存在") };
    }

    const result = await caseStore.removeFolder(folderId);
    if (!result.removed) return { success: false, error: t("errorFolderNotFound", [], "文件夹不存在") };
    if (result.caseCount > 0) {
      return {
        success: false,
        error: t("errorFolderNotEmpty", [result.caseCount], `文件夹中仍有 ${result.caseCount} 个用例，请先移出或删除这些用例`),
        caseCount: result.caseCount
      };
    }
    return { success: true, removedCount: result.removedCount };
  }

  async function renameCase(caseId, name) {
    const blocked = await blockedReason();
    if (blocked) return { success: false, error: blocked };
    if (typeof name !== "string" || !name.trim() || name.length > 120) {
      return { success: false, error: t("errorInvalidCaseName", [], "请输入 1–120 个字符的用例名称") };
    }
    const index = await caseStore.readIndex();
    const entry = index.find(item => item.id === caseId);
    if (!entry) return { success: false, error: t("errorCaseNotFound", [], "用例不存在") };
    const renamed = { ...entry, name: name.trim() };
    const origin = await readOrigin();
    await chrome.storage.local.set({
      [caseStore.INDEX_KEY]: index.map(item => item.id === caseId ? renamed : item),
      ...(origin?.caseId === caseId && !origin.deleted
        ? { [ORIGIN_KEY]: { ...origin, caseNameSnapshot: renamed.name } } : {})
    });
    return { success: true, case: renamed };
  }

  async function moveToFolder(caseIds, folderId) {
    const blocked = await blockedReason();
    if (blocked) return { success: false, error: blocked };

    const ids = [...new Set(Array.isArray(caseIds) ? caseIds.filter(id => typeof id === "string" && id) : [])];
    if (ids.length === 0) {
      return { success: false, error: t("errorNoCasesToMove", [], "请选择要移动的用例") };
    }
    const targetFolderId = typeof folderId === "string" && folderId ? folderId : null;
    const [folders, index] = await Promise.all([caseStore.readFolders(), caseStore.readIndex()]);
    if (targetFolderId && !folders.some(folder => folder.id === targetFolderId)) {
      return { success: false, error: t("errorFolderNotFound", [], "文件夹不存在") };
    }
    const existingIds = new Set(index.map(entry => entry.id));
    if (ids.some(id => !existingIds.has(id))) {
      return { success: false, error: t("errorCaseNotFound", [], "用例不存在") };
    }

    const movedCount = await caseStore.moveCasesToFolder(ids, targetFolderId);
    return { success: true, movedCount };
  }

  /**
   * What deleting these cases would actually free, as counts.
   *
   * Read-only, and deliberately counts rather than bytes: the step count is
   * already in the index and the screenshot keys are already the case's media
   * list, so this reads no blobs at all. Summing bytes would mean reading every
   * screenshot just to fill in a dialog, and it would produce a number the user
   * has no way to check -- "78 screenshots" is something they can match against
   * what they just recorded.
   *
   * The count that matters is not how many screenshots the cases hold, but how
   * many nobody else holds. A case continued from another shares its
   * predecessor's blobs, so deleting it can free nothing at all, and that is the
   * surprise this preview exists to remove.
   */
  async function previewRemoval(caseIds) {
    const ids = [...new Set(Array.isArray(caseIds) ? caseIds.filter(id => typeof id === "string" && id) : [])];
    if (ids.length === 0) return { success: false, error: t("errorNoCasesToDelete", [], "请选择要删除的用例") };

    const index = await caseStore.readIndex();
    const idSet = new Set(ids);
    const selected = index.filter(entry => idSet.has(entry.id));
    if (selected.length === 0) return { success: false, error: t("errorCaseNotFound", [], "用例不存在") };

    const [screenshotKeys, retainedKeys] = await Promise.all([
      caseStore.readCaseScreenshotKeys(ids),
      readReferencedScreenshotKeys({ excludingCaseIds: ids })
    ]);

    return {
      success: true,
      caseCount: selected.length,
      stepCount: selected.reduce((total, entry) => total + (Number(entry.stepCount) || 0), 0),
      screenshotCount: screenshotKeys.length,
      deletableScreenshotCount: screenshotKeys.filter(key => !retainedKeys.has(key)).length
    };
  }

  async function removeCases(caseIds) {
    const blocked = await blockedReason();
    if (blocked) return { success: false, error: blocked };

    const ids = [...new Set(Array.isArray(caseIds) ? caseIds.filter(id => typeof id === "string" && id) : [])];
    if (ids.length === 0) return { success: false, error: t("errorNoCasesToDelete", [], "请选择要删除的用例") };
    const index = await caseStore.readIndex();
    const existingIds = new Set(index.map(entry => entry.id));
    if (ids.some(id => !existingIds.has(id))) {
      return { success: false, error: t("errorCaseNotFound", [], "用例不存在") };
    }

    const { activeCaseId } = await chrome.storage.local.get("activeCaseId");
    const origin = await readOrigin();
    const idSet = new Set(ids);
    const wasActive = idSet.has(activeCaseId);
    const { removed, screenshotKeys } = await caseStore.removeCases(ids);

    if (wasActive) {
      // The workspace is this case, unmodified, so deleting the case deletes what
      // is on screen. The panel says so before asking for confirmation.
      await actionStore.clearActions();
      await chrome.storage.local.set({
        activeCaseId: null,
        tabsMapping: {},
        nextPageNumber: 1,
        [ORIGIN_KEY]: null
      });
    } else if (origin?.caseId && idSet.has(origin.caseId)) {
      // An unsaved workspace derived from this case. Its steps are the user's own
      // work and stay; only the pointer becomes a tombstone, so a later save can
      // still explain where it came from by name.
      await chrome.storage.local.set({ [ORIGIN_KEY]: tombstone(origin) });
    }
    // Runs after both the index and the workspace are up to date, because the
    // reference check reads them to decide what is still in use.
    const cleanup = await deleteScreenshots(screenshotKeys);
    return { success: true, deletedCount: removed.length, cleanupPending: !!cleanup?.pending };
  }

  async function removeCase(caseId) {
    return removeCases([caseId]);
  }

  /**
   * History metadata only. Deliberately no `actions`: the side panel renders
   * names and step counts, and shipping every step through the message channel
   * to build that list is what the split store exists to avoid. Callers that
   * need steps ask for one case at a time via `getDetails`.
   */
  async function list() {
    await caseStoreReady();
    const [index, data, currentStepCount] = await Promise.all([
      caseStore.readIndex(),
      chrome.storage.local.get("activeCaseId"),
      actionStore.countActions()
    ]);

    return {
      success: true,
      cases: index.map(entry => ({
        id: entry.id,
        name: entry.name,
        createdAt: entry.createdAt,
        stepCount: entry.stepCount,
        isActive: entry.id === data.activeCaseId,
        // Lets the panel mark a record as unloadable up front rather than
        // failing only once the user clicks it.
        readable: entry.readable !== false,
        folderId: entry.folderId || null
      })),
      currentStepCount,
      hasUnsavedChanges: currentStepCount > 0 && !data.activeCaseId
    };
  }

  /**
   * Case mutations are serialized.
   *
   * They all read the index, change it, and write it back, so two of them in
   * flight at once can drop one another's entry -- a saved case silently missing
   * from the history. The queue is applied at the boundary only, because the
   * inner functions call each other: `createNew` banks the workspace through
   * `autoSaveWorkspace`, and re-entering the queue there would deadlock.
   *
   * Reads stay unqueued so opening the history panel cannot end up waiting behind
   * a large save.
   */
  return {
    autoSave: () => queueCaseWrite(autoSaveWorkspace),
    clearWorkspace: () => queueCaseWrite(clearWorkspace),
    createFolder: (name, parentId) => queueCaseWrite(() => createFolder(name, parentId)),
    createNew: () => queueCaseWrite(createNewCase),
    getDetails,
    importMany: records => queueCaseWrite(() => importCases(records)),
    list,
    listFolders,
    load: caseId => queueCaseWrite(() => loadCase(caseId)),
    moveToFolder: (caseIds, folderId) => queueCaseWrite(() => moveToFolder(caseIds, folderId)),
    // Unqueued like the other reads: it changes nothing, and a confirmation dialog
    // must not have to wait behind a large save to appear.
    previewRemoval,
    rename: (caseId, name) => queueCaseWrite(() => renameCase(caseId, name)),
    remove: caseId => queueCaseWrite(() => removeCase(caseId)),
    removeMany: caseIds => queueCaseWrite(() => removeCases(caseIds)),
    removeFolder: folderId => queueCaseWrite(() => removeFolder(folderId)),
    save: (name, snapshot, folderId) => queueCaseWrite(() => saveCase(name, snapshot, folderId)),
    updateFolder: (id, changes) => queueCaseWrite(() => updateFolder(id, changes))
  };
}

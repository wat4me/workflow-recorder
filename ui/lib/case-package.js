/** Portable, re-importable case packages for sharing recorded flows. */
(function () {
  if (globalThis.RecorderCasePackage) return;

  const { t } = globalThis.RecorderI18n;
  const { MESSAGE } = globalThis.WorkflowRecorderProtocol;
  const { sendRuntimeMessage } = globalThis.RecorderBridge;
  const { sanitizeExportName, triggerDownload } = globalThis.RecorderExport;
  const FORMAT = "workflow-recorder-case-package";
  const VERSION = 1;
  const MANIFEST_PATH = "workflow-recorder-case-package.json";
  // Packages exported before the project rename keep their original format ID.
  const LEGACY_FORMAT = "semantic-workflow-recorder-case-package";
  const LEGACY_MANIFEST_PATH = `${LEGACY_FORMAT}.json`;
  const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
  const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
  const MAX_ASSET_BYTES = 25 * 1024 * 1024;
  const MAX_ENTRIES = 5000;

  function packageError(key, fallback) {
    return new Error(t(key, [], fallback));
  }

  function extensionFor(type) {
    if (type === "image/png") return "png";
    if (type === "image/webp") return "webp";
    return "jpg";
  }

  function uniqueToken() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, "");
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }

  /** Exports selected saved cases with their actions, lineage and image blobs. */
  async function exportCasePackage(cases, archiveName) {
    const archive = await buildCasePackage(cases, { asBlob: true });
    if (!archive) return;
    const fallbackName = cases.length === 1
      ? cases[0].name
      : t("sharedCasePackage", [], "共享用例包");
    triggerDownload(
      archive,
      `${sanitizeExportName(archiveName || fallbackName)}.swrcase`
    );
  }

  async function buildCasePackage(cases, { asBlob = false } = {}) {
    const selected = (cases || []).filter(item => Array.isArray(item?.actions));
    if (selected.length === 0) return null;

    const writer = globalThis.RecorderArchiveStream.createWriter();
    const assets = [];
    const assetBySourceKey = new Map();

    async function attachAsset(action, keyField, assetField) {
      const sourceKey = action[keyField];
      delete action[keyField];
      if (!sourceKey) return;

      let assetId = assetBySourceKey.get(sourceKey);
      if (!assetId) {
        const blob = await globalThis.RecorderBridge.getBlob(sourceKey);
        if (!blob) {
          if (keyField === "screenshotKey") {
            action.screenshotStatus = "failed";
            action.screenshotErrorReason = "captureFailed";
          }
          return;
        }
        assetId = `asset-${String(assets.length + 1).padStart(6, "0")}`;
        const type = /^image\/(?:jpeg|png|webp)$/.test(blob.type) ? blob.type : "image/jpeg";
        const path = `media/${assetId}.${extensionFor(type)}`;
        await writer.add(path, blob);
        assets.push({ id: assetId, path, type, size: blob.size });
        assetBySourceKey.set(sourceKey, assetId);
      }
      action[assetField] = assetId;
    }

    try {
      const packagedCases = [];
      for (const source of selected) {
        const actions = [];
        for (const sourceAction of source.actions) {
          const action = structuredClone(sourceAction);
          await attachAsset(action, "screenshotBeforeKey", "screenshotBeforeAsset");
          await attachAsset(action, "screenshotKey", "screenshotAsset");
          actions.push(action);
        }
        packagedCases.push({
          id: String(source.id || `case-${packagedCases.length + 1}`),
          name: String(source.name || t("unnamedCase", [], "未命名用例")).slice(0, 120),
          createdAt: Number(source.createdAt) || Date.now(),
          lineage: source.lineage || null,
          pages: Array.isArray(source.pages) ? structuredClone(source.pages) : [],
          actions
        });
      }

      const manifest = {
        format: FORMAT,
        version: VERSION,
        appVersion: chrome.runtime.getManifest().version,
        exportedAt: new Date().toISOString(),
        cases: packagedCases,
        assets
      };
      await writer.add(MANIFEST_PATH, globalThis.fflate.strToU8(JSON.stringify(manifest)), true);
      const archive = writer.finish();
      // Keep the programmatic byte-array API; browser downloads use Blob directly.
      return asBlob ? archive : new Uint8Array(await archive.arrayBuffer());
    } catch (error) { writer.abort(); throw error; }
  }

  function parseManifest(files) {
    const legacy = !files[MANIFEST_PATH] && !!files[LEGACY_MANIFEST_PATH];
    const bytes = files[legacy ? LEGACY_MANIFEST_PATH : MANIFEST_PATH];
    if (!bytes) throw packageError("errorInvalidCasePackage", "这不是有效的流程录制用例包");
    let manifest;
    try {
      manifest = JSON.parse(globalThis.fflate.strFromU8(bytes));
    } catch (_) {
      throw packageError("errorInvalidCasePackage", "这不是有效的流程录制用例包");
    }
    if (manifest?.format !== (legacy ? LEGACY_FORMAT : FORMAT) || manifest.version !== VERSION) {
      throw packageError("errorUnsupportedCasePackage", "用例包版本不受支持");
    }
    if (!Array.isArray(manifest.cases) || manifest.cases.length === 0 || manifest.cases.length > 200) {
      throw packageError("errorInvalidCasePackage", "这不是有效的流程录制用例包");
    }
    return manifest;
  }

  function prepareImport(manifest, files) {
    const stamp = uniqueToken();
    const assetsById = new Map();
    for (const asset of manifest.assets || []) {
      if (
        !asset || typeof asset.id !== "string" || assetsById.has(asset.id) ||
        !/^media\/[a-z0-9._-]+$/i.test(asset.path || "") ||
        !/^image\/(?:jpeg|png|webp)$/.test(asset.type || "") ||
        !files[asset.path] || files[asset.path].size > MAX_ASSET_BYTES
      ) {
        throw packageError("errorInvalidCasePackage", "这不是有效的流程录制用例包");
      }
      assetsById.set(asset.id, {
        key: files[asset.path].key,
        type: asset.type
      });
    }

    const sourceCaseIds = new Set();
    const caseIdMap = new Map();
    manifest.cases.forEach((source, index) => {
      const id = String(source?.id || "");
      if (!id || sourceCaseIds.has(id) || !Array.isArray(source.actions) || !Array.isArray(source.pages)) {
        throw packageError("errorInvalidCasePackage", "这不是有效的流程录制用例包");
      }
      sourceCaseIds.add(id);
      caseIdMap.set(id, `case_import_${stamp}_${index + 1}`);
    });

    const actionIdMap = new Map();
    let actionCounter = 0;
    manifest.cases.forEach(source => source.actions.forEach((action, index) => {
      const sourceId = typeof action?.id === "string" && action.id
        ? action.id
        : `${source.id}:${index}`;
      if (!actionIdMap.has(sourceId)) {
        actionIdMap.set(sourceId, `step_import_${stamp}_${++actionCounter}`);
      }
    }));

    const referencedAssets = new Set();
    let totalSteps = 0;
    const importedAt = Date.now();
    const cases = manifest.cases.map((source, caseIndex) => {
      totalSteps += source.actions.length;
      if (source.actions.length > 10000 || totalSteps > 50000) {
        throw packageError("errorCasePackageTooLarge", "用例包过大，无法导入");
      }
      const actions = source.actions.map((sourceAction, actionIndex) => {
        const action = structuredClone(sourceAction);
        const oldActionId = typeof action.id === "string" && action.id
          ? action.id
          : `${source.id}:${actionIndex}`;
        action.id = actionIdMap.get(oldActionId);
        delete action.screenshotBeforeKey;
        delete action.screenshotKey;

        if (action.screenshotBeforeAsset) {
          const asset = assetsById.get(action.screenshotBeforeAsset);
          if (!asset) throw packageError("errorInvalidCasePackage", "这不是有效的流程录制用例包");
          referencedAssets.add(action.screenshotBeforeAsset);
          action.screenshotBeforeKey = asset.key;
        }
        if (action.screenshotAsset) {
          const asset = assetsById.get(action.screenshotAsset);
          if (!asset) throw packageError("errorInvalidCasePackage", "这不是有效的流程录制用例包");
          referencedAssets.add(action.screenshotAsset);
          action.screenshotKey = asset.key;
          action.screenshotStatus = "captured";
          delete action.screenshotError;
          delete action.screenshotErrorReason;
          delete action.screenshotSkippedReason;
        }
        delete action.screenshotBeforeAsset;
        delete action.screenshotAsset;
        return action;
      });

      const sourceParentId = source.lineage?.parentCaseId;
      let lineage = null;
      if (sourceParentId && caseIdMap.has(sourceParentId)) {
        lineage = structuredClone(source.lineage);
        lineage.parentCaseId = caseIdMap.get(sourceParentId);
        if (lineage.forkedFromActionId) {
          lineage.forkedFromActionId = actionIdMap.get(lineage.forkedFromActionId) || null;
        }
      }
      return {
        id: caseIdMap.get(source.id),
        name: String(source.name || t("unnamedCase", [], "未命名用例")).trim().slice(0, 120),
        createdAt: importedAt + caseIndex,
        lineage,
        pages: structuredClone(source.pages),
        actions
      };
    });

    return {
      cases,
      assets: [...referencedAssets].map(id => assetsById.get(id))
    };
  }

  /** Imports a shared package into history without replacing the open workspace. */
  async function importCasePackage(file) {
    const media = globalThis.RecorderMediaStore;
    const run = () => importCasePackageUnlocked(file);
    try {
      return await (media.withWriteLock ? media.withWriteLock(run) : run());
    } finally {
      // Retry deletions deferred by the publication lock, after references are
      // committed or staged blobs have been rolled back.
      await sendRuntimeMessage({ action: MESSAGE.cleanupScreenshots, force: true }).catch(() => {});
    }
  }

  async function importCasePackageUnlocked(file) {
    if (!file || file.size <= 0) throw packageError("errorInvalidCasePackage", "这不是有效的流程录制用例包");
    if (file.size > MAX_ARCHIVE_BYTES) throw packageError("errorCasePackageTooLarge", "用例包过大，无法导入");

    const files = Object.create(null);
    const stagedKeys = [];
    const stamp = uniqueToken();
    try {
      await globalThis.RecorderArchiveStream.readEntries(file, {
        maxEntries: MAX_ENTRIES, maxBytes: MAX_UNPACKED_BYTES, maxEntryBytes: MAX_ASSET_BYTES,
        keep: name => name === MANIFEST_PATH || name === LEGACY_MANIFEST_PATH || /^media\/[a-z0-9._-]+$/i.test(name),
        onEntry: async (name, blob) => {
          if (name === MANIFEST_PATH || name === LEGACY_MANIFEST_PATH) {
            files[name] = new Uint8Array(await blob.arrayBuffer());
          } else {
            const key = `import:${stamp}:asset-${stagedKeys.length + 1}`;
            const type = name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg";
            stagedKeys.push(key);
            files[name] = { key, size: blob.size, type };
            await globalThis.RecorderMediaStore.putBlob(key, new Blob([blob], { type }));
          }
        }
      });
      const prepared = prepareImport(parseManifest(files), files);
      for (const asset of prepared.assets) {
        const blob = await globalThis.RecorderMediaStore.getBlob(asset.key);
        if (blob.type !== asset.type) {
          await globalThis.RecorderMediaStore.putBlob(asset.key, new Blob([blob], { type: asset.type }));
        }
      }
      const retained = new Set(prepared.assets.map(asset => asset.key));
      await globalThis.RecorderMediaStore.deleteBlobs(stagedKeys.filter(key => !retained.has(key)));
      let response = await sendRuntimeMessage({ action: MESSAGE.importCases, cases: prepared.cases }, 60000);
      if (!response?.success) {
        // If the response was lost after the atomic storage commit, do not roll
        // back image blobs the newly imported cases already reference.
        const check = await sendRuntimeMessage({ action: MESSAGE.listCases }, 15000);
        const present = new Set((check?.cases || []).map(item => item.id));
        if (check?.success && prepared.cases.every(item => present.has(item.id))) {
          response = { success: true, importedCount: prepared.cases.length };
        }
      }
      if (!response?.success) throw new Error(response?.error || t("importCasesFailed", [], "导入用例失败"));
      return { importedCount: response.importedCount || prepared.cases.length, renamedCount: response.renamedCount || 0 };
    } catch (error) {
      await globalThis.RecorderMediaStore.deleteBlobs(stagedKeys).catch(() => {});
      throw error;
    }
  }

  globalThis.RecorderCasePackage = {
    exportCasePackage,
    buildCasePackage,
    importCasePackage,
    packageFormat: FORMAT,
    packageVersion: VERSION
  };
})();

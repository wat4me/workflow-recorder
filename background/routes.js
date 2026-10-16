import "../shared/protocol.js";

const { MESSAGE } = globalThis.WorkflowRecorderProtocol;

/** Builds the message boundary from application services. */
export function createApplicationRoutes({
  accessibility,
  actionLog,
  actionStore,
  cases,
  drafts,
  mediaCleanup,
  notifyStepsUpdated,
  queueAction,
  queueRecordingTransition,
  screenshots,
  session,
  sidePanel,
  storeReady,
  loadLocaleMessages
}) {
  const guarded = (request, callback) => request.workspaceDraftId && drafts
    ? queueRecordingTransition(async () => { await drafts.assertActive(request.workspaceDraftId); return callback(); })
    : callback();
  return {
    [MESSAGE.setSidePanelLayout]: async request => {
      const result = await sidePanel.setLayout(request);
      if (result.success && request.open && drafts) return queueRecordingTransition(() => drafts.activate(request.tabId));
      return result;
    },
    [MESSAGE.prepareSidePanelForTab]: async request => {
      if (drafts) await queueRecordingTransition(() => drafts.activate(request.tabId));
      return sidePanel.prepareForTab(request.tabId);
    },
    [MESSAGE.getDraftState]: request => queueRecordingTransition(() => drafts.read(request.tabId)),
    [MESSAGE.selectDraft]: request => queueRecordingTransition(() => drafts.activate(request.tabId, request.draftId)),
    [MESSAGE.getActions]: request => queueRecordingTransition(async () => {
      if (Number.isInteger(request.scopeTabId) && drafts) {
        const state = await drafts.read(request.scopeTabId);
        if (request.workspaceDraftId && request.workspaceDraftId !== state.draftId) throw new Error("草稿已切换，请重试");
        return { success: true, actions: state.actions };
      }
      return { success: true, actions: await actionStore.readActions() };
    }),
    [MESSAGE.getSchemaState]: async () => ({ success: true, ...(await storeReady) }),
    [MESSAGE.getLocaleMessages]: async request => ({
      success: true,
      messages: await loadLocaleMessages(request.language)
    }),
    [MESSAGE.manualScreenshot]: request => guarded(request, () => screenshots.handleManual(request.tabId)),
    [MESSAGE.getScreenshotState]: () => screenshots.getState(),
    [MESSAGE.toggleRecording]: (request, sender) => queueRecordingTransition(async () => {
      if (request.start && Number.isInteger(request.rootTabId) && drafts) await drafts.activate(request.rootTabId);
      if (drafts) await drafts.assertActive(request.workspaceDraftId);
      return session.toggle(request.start, sender.tab, request.rootTabId, request.recordingMode);
    }),

    [MESSAGE.newCase]: () => cases.createNew(),
    [MESSAGE.clearSteps]: request => guarded(request, () => cases.clearWorkspace()),
    [MESSAGE.saveCase]: request => guarded(request, () => cases.save(request.name, !!request.snapshot, request.folderId)),
    [MESSAGE.loadCase]: request => queueRecordingTransition(async () => {
      if (Number.isInteger(request.tabId) && drafts) await drafts.activate(request.tabId);
      return cases.load(request.caseId);
    }),
    [MESSAGE.renameCase]: request => cases.rename(request.caseId, request.name),
    [MESSAGE.deleteCase]: request => cases.remove(request.caseId),
    [MESSAGE.deleteCases]: request => cases.removeMany(request.caseIds),
    [MESSAGE.previewCaseDeletion]: request => cases.previewRemoval(request.caseIds),
    [MESSAGE.listCases]: () => cases.list(),
    [MESSAGE.getCaseDetails]: request => cases.getDetails(request.caseId),
    [MESSAGE.importCases]: request => cases.importMany(request.cases),
    [MESSAGE.listCaseFolders]: () => cases.listFolders(),
    [MESSAGE.createCaseFolder]: request => cases.createFolder(request.name, request.parentId),
    [MESSAGE.updateCaseFolder]: request => cases.updateFolder(request.folderId, request.changes),
    [MESSAGE.deleteCaseFolder]: request => cases.removeFolder(request.folderId),
    [MESSAGE.moveCasesToFolder]: request => cases.moveToFolder(request.caseIds, request.folderId),

    [MESSAGE.deleteStep]: request => guarded(request, () => queueAction(() => actionLog.deleteStep(request.index))),
    [MESSAGE.deleteSteps]: request => guarded(request, () => queueAction(() => actionLog.deleteSteps(request.actionIds))),
    [MESSAGE.cleanupScreenshots]: request => mediaCleanup.cleanupOrphans({ force: !!request.force }),
    [MESSAGE.logAction]: (request, sender) => {
      const beforeFrameData = screenshots?.snapshotFrameData?.(sender.tab?.id);
      const captured = accessibility?.captureAction(request.payload, sender);
      return queueAction(async () => {
        console.log("[Background] Received logAction:", request.payload?.type, "from tab:", sender.tab?.id);
        await actionLog.log(captured ? await captured : request.payload, sender.tab, { beforeFrameData,
          frameId: sender.frameId, documentId: sender.documentId });
        notifyStepsUpdated();
        return { success: true };
      });
    },
    [MESSAGE.logClickAction]: (request, sender) => {
      const beforeFrameData = screenshots?.snapshotFrameData?.(sender.tab?.id);
      const captured = accessibility?.captureAction(request.payload, sender);
      return queueAction(async () => actionLog.logClick({ ...request,
        payload: captured ? await captured : request.payload }, sender, { beforeFrameData }));
    }
  };
}

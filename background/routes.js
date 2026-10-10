import "../shared/protocol.js";

const { MESSAGE } = globalThis.WorkflowRecorderProtocol;

/** Builds the message boundary from application services. */
export function createApplicationRoutes({
  actionLog,
  actionStore,
  cases,
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
  return {
    [MESSAGE.setSidePanelLayout]: request => sidePanel.setLayout(request),
    [MESSAGE.prepareSidePanelForTab]: request => sidePanel.prepareForTab(request.tabId),
    [MESSAGE.getActions]: async () => ({ success: true, actions: await actionStore.readActions() }),
    [MESSAGE.getSchemaState]: async () => ({ success: true, ...(await storeReady) }),
    [MESSAGE.getLocaleMessages]: async request => ({
      success: true,
      messages: await loadLocaleMessages(request.language)
    }),
    [MESSAGE.manualScreenshot]: request => screenshots.handleManual(request.tabId),
    [MESSAGE.getScreenshotState]: () => screenshots.getState(),
    [MESSAGE.toggleRecording]: (request, sender) => queueRecordingTransition(() => session.toggle(
      request.start,
      sender.tab,
      request.rootTabId,
      request.recordingMode
    )),

    [MESSAGE.newCase]: () => cases.createNew(),
    [MESSAGE.clearSteps]: () => cases.clearWorkspace(),
    [MESSAGE.saveCase]: request => cases.save(request.name, !!request.snapshot, request.folderId),
    [MESSAGE.loadCase]: request => cases.load(request.caseId),
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

    [MESSAGE.deleteStep]: request => queueAction(() => actionLog.deleteStep(request.index)),
    [MESSAGE.deleteSteps]: request => queueAction(() => actionLog.deleteSteps(request.actionIds)),
    [MESSAGE.cleanupScreenshots]: request => mediaCleanup.cleanupOrphans({ force: !!request.force }),
    [MESSAGE.logAction]: (request, sender) => queueAction(async () => {
      console.log("[Background] Received logAction:", request.payload?.type, "from tab:", sender.tab?.id);
      await actionLog.log(request.payload, sender.tab);
      notifyStepsUpdated();
      return { success: true };
    }),
    [MESSAGE.logClickAction]: (request, sender) => queueAction(() => actionLog.logClick(request, sender))
  };
}

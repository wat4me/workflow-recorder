import * as actionStore from "./actions.js";
import { screenshotKeysOf, readEntry } from "./case-store.js";
import { tombstone } from "./workspace-origin.js";

export const DRAFT_INDEX_KEY = "recordingDraftIndex";
export const ACTIVE_DRAFT_KEY = "activeRecordingDraftId";
const detailKey = id => `recordingDraft:${id}`;
const mediaKey = id => `recordingDraftMedia:${id}`;
const STATE_KEYS = ["isRecording", "recordingTabIds", "tabsMapping", "resumableScope", "nextPageNumber",
  "activeCaseId", "workspaceOrigin", "recordingCaptureSettings", "screenshotCaptureState"];
const emptyState = () => ({ isRecording: false, recordingTabIds: [], tabsMapping: {}, resumableScope: null,
  nextPageNumber: 1, activeCaseId: null, workspaceOrigin: null, recordingCaptureSettings: null });
const uniqueTabs = ids => [...new Set((ids || []).filter(Number.isInteger))];
const scopeTabs = state => uniqueTabs([...(state.recordingTabIds || []), ...(state.resumableScope?.tabIds || [])]);

export async function readDraftMediaKeys() {
  const stored = await chrome.storage.local.get([DRAFT_INDEX_KEY, ACTIVE_DRAFT_KEY]);
  const keys = (stored[DRAFT_INDEX_KEY] || []).filter(entry => entry.id !== stored[ACTIVE_DRAFT_KEY]).map(entry => mediaKey(entry.id));
  const media = keys.length ? await chrome.storage.local.get(keys) : {};
  return new Set(keys.flatMap(key => media[key] || []));
}

/** The live workspace stays incremental; only inactive drafts store a snapshot.
 * Call activate under the recording-transition queue. Case writes are serialized
 * separately so a save/clear cannot interleave the workspace swap. */
export function createDraftManager({ session, queueCaseWrite, drainRegistrations, notifyStepsUpdated }) {
  async function readState() {
    return chrome.storage.local.get([...STATE_KEYS, DRAFT_INDEX_KEY, ACTIVE_DRAFT_KEY]);
  }

  async function activate(tabId, requestedDraftId = null) {
    const tab = await chrome.tabs.get(tabId);
    if (!/^(https?|file):/i.test(tab.url || "")) throw new Error("目标页面不可录制");
    await drainRegistrations();
    let state = await readState();
    let index = state[DRAFT_INDEX_KEY] || [];
    let currentId = state[ACTIVE_DRAFT_KEY];
    const associated = index.find(entry => entry.tabIds?.includes(tabId));
    const currentScope = scopeTabs(state);
    const targetId = requestedDraftId || associated?.id || (currentScope.includes(tabId) ? currentId : null);
    if (requestedDraftId && !index.some(entry => entry.id === requestedDraftId)) throw new Error("草稿不存在，请刷新后重试");
    if (currentId && targetId === currentId &&
        (!requestedDraftId || associated?.id === currentId || currentScope.includes(tabId))) {
      // Opening a recorded child must neither pause its parent nor split it off.
      return queueCaseWrite(async () => {
        state = await readState();
        index = state[DRAFT_INDEX_KEY] || [];
        const tabs = uniqueTabs([...currentScope, tabId]);
        index = index.map(entry => entry.id === currentId
          ? { ...entry, tabIds: uniqueTabs([...(entry.tabIds || []), ...tabs]) }
          : { ...entry, tabIds: (entry.tabIds || []).filter(id => !tabs.includes(id)) });
        await chrome.storage.local.set({ [DRAFT_INDEX_KEY]: index });
        return { success: true, draftId: currentId, switched: false };
      });
    }
    if (state.isRecording) await session.toggle(false);
    return queueCaseWrite(async () => {
      state = await readState();
      index = state[DRAFT_INDEX_KEY] || [];
      currentId = state[ACTIVE_DRAFT_KEY];
      const actions = await actionStore.readActions();
      // Adopt the old single workspace without losing or misassigning its steps.
      if (!currentId && actions.length) {
        let tabs = scopeTabs(state);
        if (!tabs.length) {
          const firstUrl = actions.find(action => action.url)?.url;
          tabs = (await chrome.tabs.query({})).filter(item => item.url === firstUrl).map(item => item.id).slice(0, 1);
        }
        currentId = `draft_${crypto.randomUUID()}`;
        index.push({ id: currentId, tabIds: tabs, title: actions[0].title || "Recovered draft", url: actions[0].url || "", stepCount: actions.length });
      }
      // Re-evaluate after adopting legacy data so its original tab resumes it.
      const selectedId = requestedDraftId || index.find(entry => entry.tabIds?.includes(tabId))?.id || null;
      const nextId = selectedId || `draft_${crypto.randomUUID()}`;
      const currentState = Object.fromEntries(STATE_KEYS.map(key => [key, state[key] ?? emptyState()[key] ?? null]));
      const writes = {};
      if (currentId && currentId !== nextId) {
        writes[detailKey(currentId)] = { actions, state: { ...currentState, isRecording: false, recordingTabIds: [] } };
        writes[mediaKey(currentId)] = screenshotKeysOf(actions);
        index = index.map(entry => entry.id === currentId ? { ...entry,
          tabIds: uniqueTabs([...(entry.tabIds || []), ...scopeTabs(state)]), stepCount: actions.length, updatedAt: Date.now() } : entry);
      }
      let snapshot = null;
      if (nextId === currentId) snapshot = { actions, state: currentState };
      else if (selectedId) snapshot = (await chrome.storage.local.get(detailKey(nextId)))[detailKey(nextId)];
      if (selectedId && nextId !== currentId && !snapshot) throw new Error("草稿数据不可读取，原录制已保留");
      if (!selectedId) index.push({ id: nextId, tabIds: [tabId], title: tab.title || tab.url, url: tab.url, stepCount: 0, updatedAt: Date.now() });
      index = index.map(entry => entry.id === nextId
        ? { ...entry, tabIds: uniqueTabs([...(entry.tabIds || []), tabId]) }
        : { ...entry, tabIds: (entry.tabIds || []).filter(id => id !== tabId) });
      const previousAt = Number(state.screenshotCaptureState?.updatedAt) || 0;
      const nextState = { ...emptyState(), ...(snapshot?.state || {}), isRecording: false, recordingTabIds: [],
        screenshotCaptureState: { busy: false, kind: null, activeActionId: null, pendingCount: 0, updatedAt: Math.max(Date.now(), previousAt + 1) } };
      // A closed tab or a new browser session can reuse old numeric tab IDs.
      // Only bindings that still belong to this draft may be resumed.
      const boundTabs = new Set(index.find(entry => entry.id === nextId).tabIds);
      if (nextState.resumableScope) nextState.resumableScope = {
        tabIds: (nextState.resumableScope.tabIds || []).filter(id => boundTabs.has(id)),
        tabsMapping: Object.fromEntries(Object.entries(nextState.resumableScope.tabsMapping || {}).filter(([id]) => boundTabs.has(Number(id))))
      };
      nextState.tabsMapping = Object.fromEntries(Object.entries(nextState.tabsMapping || {}).filter(([id]) => boundTabs.has(Number(id))));
      if (nextState.activeCaseId && !(await readEntry(nextState.activeCaseId))) nextState.activeCaseId = null;
      if (nextState.workspaceOrigin?.caseId && !(await readEntry(nextState.workspaceOrigin.caseId))) {
        nextState.workspaceOrigin = tombstone(nextState.workspaceOrigin);
      }
      const publish = () => actionStore.replaceActions(snapshot?.actions || [], { ...writes, ...nextState,
        [DRAFT_INDEX_KEY]: index, [ACTIVE_DRAFT_KEY]: nextId,
        [detailKey(nextId)]: null, [mediaKey(nextId)]: [] });
      if (globalThis.RecorderMediaStore?.withWriteLock) await globalThis.RecorderMediaStore.withWriteLock(publish);
      else await publish();
      notifyStepsUpdated();
      return { success: true, draftId: nextId, switched: nextId !== currentId };
    });
  }

  async function read(tabId) {
    const state = await readState();
    const index = state[DRAFT_INDEX_KEY] || [];
    const activeId = state[ACTIVE_DRAFT_KEY];
    const entry = (!Number.isInteger(tabId) ? index.find(item => item.id === activeId) : null)
      || index.find(item => item.tabIds?.includes(tabId))
      || (scopeTabs(state).includes(tabId) ? index.find(item => item.id === activeId) : null);
    let actions = [], selectedState = emptyState();
    if ((entry && entry.id === activeId) || !Number.isInteger(tabId)) {
      actions = await actionStore.readActions(); selectedState = state;
    } else if (entry) {
      const snapshot = (await chrome.storage.local.get(detailKey(entry.id)))[detailKey(entry.id)];
      actions = snapshot?.actions || []; selectedState = snapshot?.state || emptyState();
    }
    return { success: true, actions, state: selectedState, draftId: entry?.id || null,
      active: entry?.id === activeId, drafts: index.map(item => ({ ...item, stepCount: item.id === entry?.id ? actions.length : item.stepCount })) };
  }

  async function assertActive(id) {
    if (!id) return;
    if ((await chrome.storage.local.get(ACTIVE_DRAFT_KEY))[ACTIVE_DRAFT_KEY] !== id) {
      throw new Error("当前草稿已切换，请回到目标页面重新打开侧边栏后重试");
    }
  }

  async function unbind(tabId = null) {
    return queueCaseWrite(async () => {
      const stored = await chrome.storage.local.get(DRAFT_INDEX_KEY);
      const index = (stored[DRAFT_INDEX_KEY] || []).map(entry => ({ ...entry,
        tabIds: tabId === null ? [] : (entry.tabIds || []).filter(id => id !== tabId) }));
      await chrome.storage.local.set({ [DRAFT_INDEX_KEY]: index,
        ...(tabId === null ? { resumableScope: null, recordingTabIds: [], isRecording: false, tabsMapping: {} } : {}) });
    });
  }
  return { activate, read, assertActive, unbind };
}

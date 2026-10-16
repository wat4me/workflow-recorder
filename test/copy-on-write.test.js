/**
 * Copy-on-write for steps inherited from a saved case.
 *
 * Merging a run of keystrokes into the preceding `type` step is the one place a
 * recorded step's meaning changes after the fact. When that step came from a saved
 * case it still carries that case's action id, so editing it in place would leave
 * two different steps claiming to be the same one.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

function createStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    local: {
      get(keys) {
        if (keys === null || keys === undefined) return Promise.resolve(structuredClone(data));
        const names = Array.isArray(keys) ? keys : [keys];
        const result = {};
        for (const name of names) {
          if (Object.prototype.hasOwnProperty.call(data, name)) result[name] = structuredClone(data[name]);
        }
        return Promise.resolve(result);
      },
      set(values) {
        for (const [key, value] of Object.entries(values)) data[key] = structuredClone(value);
        return Promise.resolve();
      },
      remove(keys) {
        for (const name of Array.isArray(keys) ? keys : [keys]) delete data[name];
        return Promise.resolve();
      }
    }
  };
}

const TAB = { id: 1, windowId: 1, url: "https://example.test/", title: "Example" };
const FIELD = { tagName: "input", id: "user", domPath: "body>form>input#user" };

function typeStep(id, value, overrides = {}) {
  return {
    id,
    type: "type",
    pageName: "page1",
    timestamp: 1,
    value,
    target: { ...FIELD },
    ...overrides
  };
}

function seedWorkspace(storage, actions) {
  storage.data.actionOrder = actions.map(item => item.id);
  for (const item of actions) storage.data[`action:${item.id}`] = structuredClone(item);
}

function readSteps(storage) {
  return (storage.data.actionOrder || []).map(id => storage.data[`action:${id}`]);
}

async function setup() {
  const storage = createStorage({
    schemaVersion: 2,
    caseIndex: [],
    isRecording: true,
    recordingTabIds: [1],
    tabsMapping: { 1: "page1" },
    nextPageNumber: 2
  });
  globalThis.chrome = { storage, i18n: { getUILanguage: () => "en-US" } };

  const suffix = `?t=${Math.random()}`;
  const { createActionLog } = await import(`../background/recording/action-log.js${suffix}`);
  const { createCaseManager } = await import(`../background/store/cases.js${suffix}`);

  const scheduled = [];
  const actionLog = createActionLog({
    t: (key, subs, fallback) => fallback,
    scope: {
      waitForBrowserContextChange: async () => null,
      findBrowserContextChange: () => null
    },
    screenshots: { schedule: actionId => scheduled.push(actionId) },
    mediaCleanup: { deleteUnreferenced: async () => ({ deletedCount: 0, pending: false }) },
    notifyStepsUpdated: () => {}
  });
  const cases = createCaseManager({
    t: (key, subs, fallback) => fallback,
    notifyStepsUpdated: () => {},
    queueCaseWrite: fn => fn(),
    caseStoreReady: async () => ({ ok: true, writable: true, version: 2 }),
    deleteScreenshots: async () => ({ deletedCount: 0, pending: false })
  });

  return { actionLog, cases, storage, scheduled };
}

/** Types more into the same field, which the worker folds into the last step. */
function typeMore(actionLog, value) {
  return actionLog.log(
    { type: "type", pageName: "page1", timestamp: 2, value, target: { ...FIELD } },
    TAB
  );
}

test("input merging separates frames, documents, URLs and targets without paths", async () => {
  for (const variant of ["same", "frame", "document", "url", "missing-path"]) {
    const { actionLog, storage } = await setup();
    storage.data.recordingCaptureSettings = { screenshots: false };
    const target = variant === "missing-path" ? { tagName: "input" } : { ...FIELD };
    const first = typeStep("s1", "first", { target, frameId: 1, documentId: "doc-a", url: "https://example.test/a",
      screenshotSkippedReason: "capture-disabled" });
    seedWorkspace(storage, [first]);
    await actionLog.log({ type: "type", value: "second", timestamp: 2, target,
      url: variant === "url" ? "https://example.test/b" : first.url }, TAB, {
      frameId: variant === "frame" ? 2 : 1, documentId: variant === "document" ? "doc-b" : "doc-a"
    });
    const steps = readSteps(storage);
    assert.equal(steps.length, variant === "same" ? 1 : 2, variant);
    assert.equal(steps[0].value, variant === "same" ? "second" : "first", variant);
  }
});

test("editing an inherited step copies it to a new id first", async () => {
  const { actionLog, cases, storage, scheduled } = await setup();
  seedWorkspace(storage, [
    typeStep("s1", "adm", { screenshotKey: "screenshot:s1:a", screenshotStatus: "captured" })
  ]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  await typeMore(actionLog, "admin");

  const steps = readSteps(storage);
  assert.equal(steps.length, 1);
  assert.notEqual(steps[0].id, "s1");
  assert.equal(steps[0].originActionId, "s1");
  assert.equal(steps[0].value, "admin");
  // The old record is gone, and the copy holds the same position.
  assert.equal(storage.data["action:s1"], undefined);
  assert.deepEqual(storage.data.actionOrder, [steps[0].id]);
  // The screenshot comes along so the card keeps showing an image while the
  // re-capture runs; the re-capture writes a new key rather than overwriting it.
  assert.equal(steps[0].screenshotKey, "screenshot:s1:a");
  assert.equal(steps[0].screenshotStatus, "pending");
  // The capture is scheduled against the id the change actually landed on.
  assert.deepEqual(scheduled, [steps[0].id]);

  // The case it came from is untouched.
  const detail = await cases.getDetails(parent.case.id);
  assert.deepEqual(detail.case.actions.map(item => item.id), ["s1"]);
  assert.equal(detail.case.actions[0].value, "adm");
});

test("a copied step is not copied again on the next keystroke", async () => {
  const { actionLog, cases, storage } = await setup();
  seedWorkspace(storage, [typeStep("s1", "a")]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  await typeMore(actionLog, "ab");
  const copiedId = readSteps(storage)[0].id;
  await typeMore(actionLog, "abc");

  const steps = readSteps(storage);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].id, copiedId, "the second edit must patch the copy in place");
  assert.equal(steps[0].value, "abc");
  assert.equal(steps[0].originActionId, "s1");
});

test("a step the workspace recorded itself is edited in place", async () => {
  const { actionLog, storage, scheduled } = await setup();
  seedWorkspace(storage, [typeStep("own", "a")]);

  await typeMore(actionLog, "ab");

  const steps = readSteps(storage);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].id, "own");
  assert.equal(steps[0].value, "ab");
  assert.equal("originActionId" in steps[0], false);
  assert.deepEqual(scheduled, ["own"]);
});

test("the copy makes the saved relation a modification, with the right counts", async () => {
  const { actionLog, cases, storage } = await setup();
  seedWorkspace(storage, [typeStep("s1", "a"), typeStep("s2", "b", { target: { tagName: "input", id: "pass", domPath: "body>form>input#pass" } })]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  // Edits the *first* inherited step, so nothing before it is shared either.
  seedWorkspace(storage, [storage.data["action:s1"]]);
  await typeMore(actionLog, "admin");
  const child = await cases.save("Edited");

  const lineage = storage.data.caseIndex.find(item => item.id === child.case.id).lineage;
  assert.equal(lineage.parentCaseId, parent.case.id);
  assert.equal(lineage.relation, "modified");
  assert.equal(lineage.inheritedStepCount, 0);
  assert.equal(lineage.forkedFromActionId, null);
});

test("appending after a copy still counts the untouched prefix as inherited", async () => {
  const { actionLog, cases, storage } = await setup();
  const first = typeStep("s1", "a", { target: { tagName: "input", id: "one", domPath: "body>input#one" } });
  seedWorkspace(storage, [first, typeStep("s2", "b")]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  // Edits the last inherited step only; the first stays shared.
  await typeMore(actionLog, "bc");
  const child = await cases.save("Edited tail");

  const lineage = storage.data.caseIndex.find(item => item.id === child.case.id).lineage;
  assert.equal(lineage.relation, "modified");
  assert.equal(lineage.inheritedStepCount, 1);
  assert.equal(lineage.forkedFromActionId, "s1");
});

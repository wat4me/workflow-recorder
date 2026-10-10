/**
 * Case lineage: what a derived case records about where it came from.
 *
 * The rules under test are the ones that decide whether two cases can still be
 * said to share a prefix, and they have to keep holding after the parent is
 * renamed, deleted, or partly edited in the workspace.
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

function step(id, overrides = {}) {
  return {
    id,
    type: "click",
    pageName: "page1",
    timestamp: 1,
    target: { tagName: "button", id: `btn-${id}`, domPath: `body>button#btn-${id}` },
    ...overrides
  };
}

function seedWorkspace(storage, actions) {
  storage.data.actionOrder = actions.map(item => item.id);
  for (const item of actions) storage.data[`action:${item.id}`] = structuredClone(item);
}

async function setup(initial = {}) {
  const storage = createStorage({ schemaVersion: 2, caseIndex: [], ...initial });
  globalThis.chrome = { storage, i18n: { getUILanguage: () => "en-US" } };

  const suffix = `?t=${Math.random()}`;
  const { createCaseManager } = await import(`../background/store/cases.js${suffix}`);
  const origin = await import(`../background/store/workspace-origin.js${suffix}`);
  const signature = await import(`../background/store/step-signature.js${suffix}`);

  const cases = createCaseManager({
    t: (key, subs, fallback) => fallback,
    notifyStepsUpdated: () => {},
    queueCaseWrite: fn => fn(),
    caseStoreReady: async () => ({ ok: true, writable: true, version: 2 }),
    deleteScreenshots: async () => ({ deletedCount: 0, pending: false })
  });

  return { cases, storage, origin, signature };
}

function entryFor(storage, caseId) {
  return storage.data.caseIndex.find(item => item.id === caseId);
}

test("a workspace that was never loaded from a case saves as a root", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1")]);

  const saved = await cases.save("Root");
  assert.equal(entryFor(storage, saved.case.id).lineage, undefined);
});

test("continuing a loaded case records the parent, the fork point and the counts", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1"), step("s2")]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  // Continue: two more steps on top of the two inherited ones.
  seedWorkspace(storage, [step("s1"), step("s2"), step("s3"), step("s4")]);
  const child = await cases.save("Admin approval");

  const lineage = entryFor(storage, child.case.id).lineage;
  assert.equal(lineage.version, 1);
  assert.equal(lineage.parentCaseId, parent.case.id);
  assert.equal(lineage.parentCaseNameSnapshot, "Login");
  assert.equal(lineage.inheritedStepCount, 2);
  assert.equal(lineage.forkedFromActionId, "s2");
  assert.equal(lineage.relation, "continued");
  assert.equal(entryFor(storage, child.case.id).stepCount, 4);
});

test("two cases continued from the same parent are siblings, not a chain", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1"), step("s2")]);
  const parent = await cases.save("Login");

  await cases.load(parent.case.id);
  seedWorkspace(storage, [step("s1"), step("s2"), step("b1")]);
  const first = await cases.save("Admin");

  // Loading the parent again is what makes the next save a sibling: a plain save
  // moves the baseline forward, which is how A -> B -> D is built instead.
  await cases.load(parent.case.id);
  seedWorkspace(storage, [step("s1"), step("s2"), step("c1"), step("c2")]);
  const second = await cases.save("User");

  assert.equal(entryFor(storage, first.case.id).lineage.parentCaseId, parent.case.id);
  assert.equal(entryFor(storage, second.case.id).lineage.parentCaseId, parent.case.id);
  assert.equal(entryFor(storage, second.case.id).lineage.inheritedStepCount, 2);
});

test("a plain save moves the baseline forward so the next save chains", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1")]);
  const first = await cases.save("A");

  seedWorkspace(storage, [step("s1"), step("s2")]);
  const second = await cases.save("B");

  assert.equal(entryFor(storage, second.case.id).lineage.parentCaseId, first.case.id);
  assert.equal(entryFor(storage, second.case.id).lineage.inheritedStepCount, 1);
});

test("a snapshot leaves the baseline alone, so snapshots are siblings", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1"), step("s2")]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  seedWorkspace(storage, [step("s1"), step("s2"), step("s3")]);
  const firstSnapshot = await cases.save("Snapshot 1", true);
  seedWorkspace(storage, [step("s1"), step("s2"), step("s3"), step("s4")]);
  const secondSnapshot = await cases.save("Snapshot 2", true);

  // Both point at the loaded case, not at each other.
  assert.equal(entryFor(storage, firstSnapshot.case.id).lineage.parentCaseId, parent.case.id);
  assert.equal(entryFor(storage, secondSnapshot.case.id).lineage.parentCaseId, parent.case.id);
  assert.equal(storage.data.activeCaseId, parent.case.id);
});

test("deleting an inherited step makes the relation a modification", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1"), step("s2"), step("s3")]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  // The middle inherited step is gone, so only the first one is still shared.
  seedWorkspace(storage, [step("s1"), step("s3"), step("new")]);
  const child = await cases.save("Trimmed");

  const lineage = entryFor(storage, child.case.id).lineage;
  assert.equal(lineage.relation, "modified");
  assert.equal(lineage.inheritedStepCount, 1);
  assert.equal(lineage.forkedFromActionId, "s1");
});

test("a workspace sharing nothing with its origin reports no fork point", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1")]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  seedWorkspace(storage, [step("unrelated")]);
  const child = await cases.save("Different");

  const lineage = entryFor(storage, child.case.id).lineage;
  assert.equal(lineage.relation, "modified");
  assert.equal(lineage.inheritedStepCount, 0);
  assert.equal(lineage.forkedFromActionId, null);
});

test("an inherited step that kept its id but changed meaning is not counted as shared", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1", { type: "type", value: "admin" }), step("s2")]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  // Edited in place without copy-on-write. Nothing should do this, which is the
  // point: if some future edit path forgets, the signature check catches it rather
  // than reporting an edited step as untouched.
  seedWorkspace(storage, [step("s1", { type: "type", value: "guest" }), step("s2")]);
  const child = await cases.save("Guest");

  assert.equal(entryFor(storage, child.case.id).lineage.relation, "modified");
  assert.equal(entryFor(storage, child.case.id).lineage.inheritedStepCount, 0);
});

test("re-capturing a screenshot does not make a step look edited", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1", { screenshotKey: "screenshot:s1:a", screenshotStatus: "captured" })]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  // Same step, new screenshot: a different key, a different capture time, and a
  // status that moved. None of it is what the step means.
  seedWorkspace(storage, [
    step("s1", {
      screenshotKey: "screenshot:s1:b",
      screenshotStatus: "captured",
      screenshotCapturedAt: 999,
      screenshotSource: "manual"
    }),
    step("s2")
  ]);
  const child = await cases.save("Recaptured");

  const lineage = entryFor(storage, child.case.id).lineage;
  assert.equal(lineage.relation, "continued");
  assert.equal(lineage.inheritedStepCount, 1);
});

test("deleting the origin keeps the unsaved workspace and leaves a tombstone", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1")]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  // Continuing clears the active-case marker: the workspace no longer matches a
  // saved case, which is exactly the situation the origin exists to describe.
  seedWorkspace(storage, [step("s1"), step("s2")]);
  storage.data.activeCaseId = null;

  assert.equal((await cases.remove(parent.case.id)).success, true);
  assert.deepEqual(storage.data.actionOrder, ["s1", "s2"]);
  assert.equal(storage.data.workspaceOrigin.deleted, true);
  assert.equal(storage.data.workspaceOrigin.caseNameSnapshot, "Login");

  // Saving still explains where the work came from, by name.
  const child = await cases.save("Orphaned");
  const lineage = entryFor(storage, child.case.id).lineage;
  assert.equal(lineage.parentCaseId, parent.case.id);
  assert.equal(lineage.parentCaseNameSnapshot, "Login");
  assert.equal(entryFor(storage, parent.case.id), undefined);
});

test("deleting the loaded, unmodified case clears the workspace and its origin", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1")]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  assert.equal((await cases.remove(parent.case.id)).success, true);
  assert.deepEqual(storage.data.actionOrder, []);
  assert.equal(storage.data.activeCaseId, null);
  assert.equal(storage.data.workspaceOrigin, null);
});

test("deleting an unrelated case leaves the workspace origin alone", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1")]);
  const parent = await cases.save("Login");
  seedWorkspace(storage, [step("x1")]);
  const unrelated = await cases.save("Other");
  await cases.load(parent.case.id);

  await cases.remove(unrelated.case.id);
  assert.equal(storage.data.workspaceOrigin.caseId, parent.case.id);
  assert.equal(storage.data.workspaceOrigin.deleted, undefined);
});

test("creating a new case banks the work with its lineage, then drops the origin", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1")]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  seedWorkspace(storage, [step("s1"), step("s2")]);
  storage.data.activeCaseId = null;

  assert.equal((await cases.createNew()).success, true);
  const banked = storage.data.caseIndex.find(item => item.id !== parent.case.id);
  assert.equal(banked.lineage.parentCaseId, parent.case.id);
  assert.equal(banked.lineage.inheritedStepCount, 1);
  assert.equal(storage.data.workspaceOrigin, null);
  assert.deepEqual(storage.data.actionOrder, []);
});

test("the origin snapshot is compact and does not carry step content", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [step("s1", { target: { tagName: "button", domPath: "a".repeat(400) } })]);
  const parent = await cases.save("Login");
  await cases.load(parent.case.id);

  const snapshot = storage.data.workspaceOrigin.originalActions;
  assert.deepEqual(Object.keys(snapshot[0]).sort(), ["actionId", "signature"]);
  // A fingerprint, not the signature it stands for: the origin is rewritten on
  // every load, and full signatures include DOM paths.
  assert.ok(snapshot[0].signature.length < 20);
});

test("signatures ignore capture fields and timing but follow the payload", async () => {
  const { signature } = await setup();
  const base = step("s1", { type: "type", value: "admin" });

  assert.equal(
    signature.signatureOf(base),
    signature.signatureOf({ ...base, timestamp: 999, screenshotKey: "k", screenshotStatus: "failed" })
  );
  assert.notEqual(signature.signatureOf(base), signature.signatureOf({ ...base, value: "guest" }));
  assert.notEqual(signature.signatureOf(base), signature.signatureOf({ ...base, pageName: "page2" }));
  assert.notEqual(signature.signatureOf(base), signature.signatureOf({ ...base, type: "click" }));
});

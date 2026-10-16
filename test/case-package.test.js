/** Portable case package export/import round trip. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const fflate = require("fflate");

function loadPackage(blobs = new Map()) {
  let downloaded = null;
  let importedCases = null;
  const storedMedia = new Map();
  const anchor = { click() {}, remove() {}, href: "", download: "" };
  const context = {
    Blob,
    Uint8Array,
    Date,
    Math,
    structuredClone,
    crypto: { randomUUID: () => "11111111-2222-4333-8444-555555555555" },
    URL: {
      createObjectURL(blob) {
        downloaded = { blob, filename: anchor.download };
        return "blob:test";
      },
      revokeObjectURL() {}
    },
    document: {
      body: { appendChild() {} },
      createElement() { return anchor; }
    },
    setTimeout(callback) { callback(); },
    fflate,
    chrome: { runtime: { getManifest: () => ({ version: "1.0.0" }) } },
    RecorderI18n: { t: (key, substitutions, fallback) => fallback },
    RecorderBridge: {
      getBlob: async key => blobs.get(key) || null,
      sendRuntimeMessage: async message => {
        if (message.action === "importCases") {
          importedCases = structuredClone(message.cases);
          return { success: true, importedCount: message.cases.length };
        }
        if (message.action === "listCases") {
          return { success: true, cases: (importedCases || []).map(item => ({ id: item.id })) };
        }
        return { success: false };
      }
    },
    RecorderMediaStore: {
      async putBlob(key, blob) { storedMedia.set(key, blob); },
      async getBlob(key) { return storedMedia.get(key); },
      async deleteBlobs(keys) { keys.forEach(key => storedMedia.delete(key)); }
    },
    StepDocGenerator: { generate: () => "# workflow\n" }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "shared", "protocol.js"), "utf8"), context);
  for (const relative of ["ui/lib/archive-stream.js", "ui/lib/export.js", "ui/lib/case-package.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", relative), "utf8"), context);
  }
  return {
    api: context.RecorderCasePackage,
    downloaded: () => downloaded && { blob: downloaded.blob, filename: anchor.download },
    importedCases: () => importedCases,
    storedMedia
  };
}

test("a shared parent/child package round-trips actions, lineage and deduplicated media", async () => {
  const blobs = new Map([
    ["shared-before", new Blob(["before"], { type: "image/jpeg" })],
    ["shared-after", new Blob(["after"], { type: "image/jpeg" })]
  ]);
  const harness = loadPackage(blobs);
  const inherited = {
    id: "step_shared",
    type: "click",
    pageName: "page1",
    screenshotBeforeKey: "shared-before",
    screenshotBeforeHighlight: { coordinateSpace: "top-viewport", x: 20, y: 30, width: 40, height: 50,
      viewportWidth: 1920, viewportHeight: 1080 },
    screenshotKey: "shared-after",
    screenshotStatus: "captured"
  };
  await harness.api.exportCasePackage([
    {
      id: "case_parent",
      name: "Parent",
      createdAt: 1,
      lineage: null,
      pages: [{ name: "page1", url: "https://example.test" }],
      actions: [inherited]
    },
    {
      id: "case_child",
      name: "Child",
      createdAt: 2,
      lineage: {
        parentCaseId: "case_parent",
        forkedFromActionId: "step_shared",
        inheritedStepCount: 1,
        addedStepCount: 1,
        relation: "continued"
      },
      pages: [{ name: "page1", url: "https://example.test" }],
      actions: [inherited, { id: "step_child", type: "type", pageName: "page1" }]
    }
  ], "team-flow");

  const archive = harness.downloaded();
  assert.equal(archive.filename, "team-flow.swrcase");
  const files = fflate.unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
  const manifest = JSON.parse(fflate.strFromU8(files["workflow-recorder-case-package.json"]));
  assert.equal(manifest.format, "workflow-recorder-case-package");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.cases.length, 2);
  assert.equal(manifest.assets.length, 2, "shared screenshots should appear once in the package");
  assert.equal(manifest.cases[0].actions[0].screenshotKey, undefined);
  assert.equal(manifest.cases[0].actions[0].screenshotAsset, "asset-000002");

  const result = await harness.api.importCasePackage({
    size: archive.blob.size,
    arrayBuffer: () => archive.blob.arrayBuffer()
  });
  assert.equal(result.importedCount, 2);
  const imported = harness.importedCases();
  assert.equal(imported.length, 2);
  assert.match(imported[0].id, /^case_import_/);
  assert.equal(imported[1].lineage.parentCaseId, imported[0].id);
  assert.equal(imported[1].lineage.forkedFromActionId, imported[0].actions[0].id);
  assert.equal(imported[1].actions[0].id, imported[0].actions[0].id);
  assert.equal(imported[1].actions[0].screenshotKey, imported[0].actions[0].screenshotKey);
  assert.equal(harness.storedMedia.size, 2);
  assert.deepEqual(imported[0].actions[0].screenshotBeforeHighlight, inherited.screenshotBeforeHighlight);
});

test("a validation failure rolls back streamed media staged before the manifest", async () => {
  const harness = loadPackage();
  const manifest = { format: "workflow-recorder-case-package", version: 1,
    assets: [{ id: "present", path: "media/present.jpg", type: "image/jpeg" }],
    cases: [{ id: "case", name: "Invalid", pages: [], actions: [{ id: "step", screenshotAsset: "missing" }] }] };
  const bytes = fflate.zipSync({ "media/present.jpg": new Uint8Array([1, 2, 3]),
    "workflow-recorder-case-package.json": fflate.strToU8(JSON.stringify(manifest)) });
  const source = new Blob([bytes]);
  await assert.rejects(harness.api.importCasePackage({ size: source.size,
    slice: (...args) => source.slice(...args), arrayBuffer: () => assert.fail("whole-file read") }), /有效的流程录制用例包/);
  assert.equal(harness.storedMedia.size, 0);
  assert.equal(harness.importedCases(), null);
});

test("buildCasePackage returns the archive without starting a browser download", async () => {
  const harness = loadPackage();
  const archive = await harness.api.buildCasePackage([{
    id: "case-build",
    name: "Build only",
    actions: [{ type: "click" }],
    pages: []
  }]);
  assert.ok(archive instanceof Uint8Array);
  assert.equal(harness.downloaded(), null);
  const files = fflate.unzipSync(archive);
  const manifest = JSON.parse(fflate.strFromU8(files["workflow-recorder-case-package.json"]));
  assert.equal(manifest.cases[0].id, "case-build");
});

test("a regular zip is rejected without writing any media", async () => {
  const harness = loadPackage();
  const bytes = fflate.zipSync({ "notes.txt": fflate.strToU8("not a case") });
  await assert.rejects(
    harness.api.importCasePackage({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }),
    /有效的流程录制用例包/
  );
  assert.equal(harness.storedMedia.size, 0);
  assert.equal(harness.importedCases(), null);
});

test("packages exported before the project rename remain importable", async () => {
  const harness = loadPackage();
  const bytes = fflate.zipSync({
    "semantic-workflow-recorder-case-package.json": fflate.strToU8(JSON.stringify({
      format: "semantic-workflow-recorder-case-package", version: 1, appVersion: "1.0.0",
      cases: [{ id: "old-case", name: "Old export", createdAt: 1, pages: [],
        actions: [{ id: "old-step", type: "click", pageName: "page1", screenshotAsset: "old-image" }] }],
      assets: [{ id: "old-image", path: "media/old-image.jpg", type: "image/jpeg", size: 3 }]
    })),
    "media/old-image.jpg": new Uint8Array([1, 2, 3])
  });
  const result = await harness.api.importCasePackage({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer });
  assert.equal(result.importedCount, 1);
  assert.equal(harness.importedCases()[0].name, "Old export");
  assert.equal(harness.storedMedia.size, 1);
});

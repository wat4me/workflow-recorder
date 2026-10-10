/** Paired before/after screenshot export. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { strFromU8, unzipSync, zipSync } = require("fflate");

function loadExport(blobs) {
  let downloaded = null;
  const anchor = {
    click() {},
    remove() {},
    href: "",
    download: ""
  };
  const context = {
    Blob,
    Uint8Array,
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
    fflate: { strToU8: require("fflate").strToU8, zipSync },
    RecorderI18n: { t: (key, subs, fallback) => fallback },
    RecorderBridge: { getBlob: async key => blobs.get(key) || null },
    StepDocGenerator: { generate: () => "# Recorded workflow\n" }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "ui", "lib", "export.js"), "utf8"),
    context
  );
  return {
    api: context.RecorderExport,
    downloaded: () => downloaded && { ...downloaded, filename: anchor.download }
  };
}

test("one step exports its before and after frames as a labelled pair", async () => {
  const blobs = new Map([
    ["before-key", new Blob(["before-frame"], { type: "image/jpeg" })],
    ["after-key", new Blob(["after-frame"], { type: "image/jpeg" })]
  ]);
  const { api, downloaded } = loadExport(blobs);

  await api.exportWorkflow([{
    id: "step_1",
    type: "click",
    screenshotBeforeKey: "before-key",
    screenshotKey: "after-key"
  }], "paired-capture");

  const archive = downloaded();
  assert.ok(archive);
  assert.equal(archive.filename, "paired-capture.zip");
  const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
  assert.equal(strFromU8(files["paired-capture/screenshots/step-001-click-before.jpg"]), "before-frame");
  assert.equal(strFromU8(files["paired-capture/screenshots/step-001-click-after.jpg"]), "after-frame");

  const markdown = strFromU8(files["paired-capture/paired-capture.md"]);
  assert.match(markdown, /Step 1 before: screenshots\/step-001-click-before\.jpg/);
  assert.match(markdown, /Step 1 after: screenshots\/step-001-click-after\.jpg/);
});

test("a legacy step with one frame still exports cleanly", async () => {
  const blobs = new Map([
    ["after-key", new Blob(["after-frame"], { type: "image/jpeg" })]
  ]);
  const { api, downloaded } = loadExport(blobs);

  await api.exportWorkflow([{
    id: "step_1",
    type: "navigate",
    screenshotKey: "after-key"
  }], "legacy-capture");

  const files = unzipSync(new Uint8Array(await downloaded().blob.arrayBuffer()));
  assert.ok(files["legacy-capture/screenshots/step-001-navigate-after.jpg"]);
  assert.equal(files["legacy-capture/screenshots/step-001-navigate-before.jpg"], undefined);
});

test("a recording made without screenshots still exports its document", async () => {
  const { api, downloaded } = loadExport(new Map());

  await api.exportWorkflow([
    { id: "step_1", type: "navigate", pageName: "page1", url: "https://example.test/", screenshotSkippedReason: "capture-disabled" },
    { id: "step_2", type: "click", pageName: "page1", screenshotSkippedReason: "capture-disabled" }
  ], "no-screenshots");

  const files = unzipSync(new Uint8Array(await downloaded().blob.arrayBuffer()));
  // The document is the whole point of the export, so it has to be there even when
  // there is not a single image to reference.
  const markdown = strFromU8(files["no-screenshots/no-screenshots.md"]);
  assert.match(markdown, /Recorded workflow/);
  assert.doesNotMatch(markdown, /## Step screenshots/);
  assert.deepEqual(Object.keys(files).filter(name => name.includes("/screenshots/")), []);
});

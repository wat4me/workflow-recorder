const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const fflate = require("fflate");

function load() {
  const context = { Blob, Uint8Array, setTimeout, fflate };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../ui/lib/archive-stream.js"), "utf8"), context);
  return context.RecorderArchiveStream;
}

test("ZIP streams preserve media bytes, drain writes, and never read an entire input file", async () => {
  const { createWriter, readEntries } = load();
  const source = new Uint8Array(190000).map((_, index) => index * 71 % 251);
  const writer = createWriter();
  await writer.add("media/frame.jpg", new Blob([source]));
  await writer.add("manifest.json", fflate.strToU8('{"ok":true}'), true);
  const blob = writer.finish();
  const results = [];
  let writing = 0;
  await readEntries({ size: blob.size, slice: (...args) => {
    assert.equal(writing, 0, "input must wait for publication backpressure");
    assert.ok(args[1] - args[0] <= 16384);
    return blob.slice(...args);
  }, arrayBuffer() { assert.fail("whole-file read"); } }, {
    keep: () => true, maxEntries: 10, maxBytes: 1000000, maxEntryBytes: 300000,
    onEntry: async (name, data) => {
      writing++;
      await new Promise(resolve => setTimeout(resolve, 2));
      results.push([name, new Uint8Array(await data.arrayBuffer())]);
      writing--;
    }
  });
  assert.equal(results.length, 2);
  assert.deepEqual(results[0][1], source);
  assert.equal(fflate.strFromU8(results[1][1]), '{"ok":true}');
});

test("streaming extraction rejects actual expansion beyond the per-entry bound", async () => {
  const { readEntries } = load();
  const archive = fflate.zipSync({ "media/bomb.jpg": new Uint8Array(1000000) });
  // Lie in the local header; actual decoded bytes must still be counted.
  new DataView(archive.buffer).setUint32(22, 1, true);
  await assert.rejects(readEntries(new Blob([archive]), {
    keep: () => true, maxEntries: 10, maxBytes: 2000000, maxEntryBytes: 50000,
    onEntry: () => assert.fail("oversized entry must not be published")
  }), /too large/);
});

test("streaming extraction waits for all outstanding writes before rejecting", async () => {
  const { readEntries } = load();
  const archive = fflate.zipSync({ "one": new Uint8Array([1]), "two": new Uint8Array([2]) });
  let secondFinished = false;
  await assert.rejects(readEntries(new Blob([archive]), {
    keep: () => true, maxEntries: 10, maxBytes: 10000, maxEntryBytes: 1000,
    onEntry: async name => {
      if (name === "one") throw new Error("write failed");
      await new Promise(resolve => setTimeout(resolve, 10));
      secondFinished = true;
    }
  }), /write failed/);
  assert.equal(secondFinished, true);
});

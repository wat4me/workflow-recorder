const assert = require("node:assert/strict");
const test = require("node:test");

test("a 10,000-step list mounts a bounded window and reaches its last step", async () => {
  const { createVirtualWindow } = await import("../ui/lib/virtual-window.js");
  const model = createVirtualWindow();
  const keys = Array.from({ length: 10000 }, (_, index) => `step-${index}`);
  model.reset(keys, 100);
  const middle = model.range(500000, 720);
  assert.ok(middle.end - middle.start < 25);
  assert.ok(middle.before > 0 && middle.after > 0);
  const bottom = model.range(1060000 - 720, 720);
  assert.equal(bottom.end, 10000);
  assert.equal(bottom.after, 0);
  model.measure(keys[0], 300);
  const resized = model.range(500000, 720);
  assert.ok(resized.start < middle.start, "measured heights must affect scroll offsets");
  model.reset([keys[9999]], 100);
  assert.deepEqual(model.range(0, 720), { start: 0, end: 1, before: 0, after: 0 });
});

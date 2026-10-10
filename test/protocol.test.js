const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadProtocol(logged = []) {
  const context = { console: { debug: (...args) => logged.push(args) } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "shared", "protocol.js"), "utf8"),
    context
  );
  return context.WorkflowRecorderProtocol;
}

test("cross-context messages have one unique vocabulary", () => {
  const protocol = loadProtocol();
  const values = Object.values(protocol.MESSAGE);
  assert.equal(new Set(values).size, values.length);
  assert.equal(protocol.MESSAGE.toggleRecording, "toggleRecording");
  assert.equal(protocol.MESSAGE.moveCasesToFolder, "moveCasesToFolder");
  assert.equal(protocol.MESSAGE.deleteCases, "deleteCases");
  assert.equal(protocol.MESSAGE.deleteSteps, "deleteSteps");
  assert.equal(protocol.MESSAGE.agentJobUpdated, "agentJobUpdated");
});

test("Agent activity is defined by the shared protocol", () => {
  const protocol = loadProtocol();
  assert.equal(protocol.isAgentActive(protocol.AGENT_STATUS.running), true);
  assert.equal(protocol.isAgentActive(protocol.AGENT_STATUS.completed), false);
});

test("every gate that drops a click names its reason in one vocabulary", () => {
  const logged = [];
  const protocol = loadProtocol(logged);
  const reasons = Object.values(protocol.CLICK_SKIP_REASON);
  assert.equal(new Set(reasons).size, reasons.length);
  assert.equal(protocol.CLICK_SKIP_REASON.editableTarget, "editable-target");
  // The worker's own gate needs the cross-tab view, so the page never reports it.
  assert.equal(protocol.CLICK_SKIP_REASON.noObservableEffect, "no-observable-effect");

  protocol.reportClickSkipped(protocol.CLICK_SKIP_REASON.meaninglessTarget, { target: "div" });

  assert.equal(logged.length, 1);
  // A fixed prefix is what lets one console filter find every gate.
  assert.equal(logged[0][0], "[Workflow Recorder] click not recorded: meaningless-target");
  assert.deepEqual(logged[0][1], { target: "div" });
});

test("content and UI entry points load the protocol before consumers", () => {
  const root = path.join(__dirname, "..");
  const injection = fs.readFileSync(path.join(root, "background", "recording", "injection.js"), "utf8");
  const popupEntry = fs.readFileSync(path.join(root, "ui", "popup-entry.js"), "utf8");
  const consoleEntry = fs.readFileSync(path.join(root, "ui", "console-entry.js"), "utf8");
  assert.ok(injection.indexOf('"shared/protocol.js"') < injection.indexOf('"content/main.js"'));
  assert.match(popupEntry, /^import "\.\.\/shared\/protocol\.js";/);
  assert.match(consoleEntry, /^import "\.\.\/shared\/protocol\.js";/);
});

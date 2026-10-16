const assert = require("node:assert/strict");
const test = require("node:test");

const axNode = (overrides = {}) => ({ nodeId: "clicked", backendDOMNodeId: 42,
  role: { value: "button" }, name: { value: "Actual target" }, ...overrides });

test("AX summaries use the exact backend node, retain empty names and bound ancestor context", async () => {
  const { summarizeAX } = await import("../background/capture/accessibility.js");
  const nodes = [axNode({ nodeId: "other", backendDOMNodeId: 99, name: { value: "Wrong button" } }),
    axNode({ name: { value: "" }, parentId: "parent", properties: [
      { name: "disabled", value: { value: false } }, { name: "controls", value: { value: { huge: true } } }
    ] }),
    axNode({ nodeId: "parent", backendDOMNodeId: 1, parentId: "root", name: { value: "Toolbar" } }),
    axNode({ nodeId: "root", backendDOMNodeId: 2, parentId: "parent" })];
  const result = summarizeAX(nodes, 42);
  assert.equal(result.status, "captured");
  assert.equal(result.name, "");
  assert.deepEqual(result.properties, { disabled: false });
  assert.equal(result.ancestors[0].name, "Toolbar");
  assert.equal(result.ancestors.length, 2, "cyclic data cannot grow indefinitely");
  assert.equal(result.backendDOMNodeId, undefined, "ephemeral node ids are not exported as locators");
  assert.equal(summarizeAX(nodes, 100).status, "unavailable");
  assert.equal(summarizeAX([axNode({ ignored: true })], 42).status, "ignored");
});

test("AX capture strips temporary references and releases remote node handles", async () => {
  const { createAccessibilityCollector } = await import("../background/capture/accessibility.js");
  const calls = [];
  const collector = createAccessibilityCollector({ scope: { isInScope: async () => true }, screencast: {
    has: () => true, contexts: () => [1], send: async (_, method, params) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") return { result: { objectId: "node-handle", subtype: "node" } };
      if (method === "DOM.describeNode") return { node: { backendNodeId: 42 } };
      if (method === "Accessibility.getPartialAXTree") return { nodes: [axNode()] };
      return {};
    }
  } });
  const target = { tagName: "button", accessibleName: "DOM hint", _axRef: "ax_test_1" };
  const result = await collector.captureAction({ type: "click", target }, { tab: { id: 10 } });
  assert.equal(result.target.accessibleName, "DOM hint");
  assert.equal(result.target._axRef, undefined);
  assert.equal(result.accessibility.name, "Actual target");
  assert.ok(calls.some(call => call.method === "Runtime.releaseObjectGroup"));
  assert.equal(target._axRef, "ax_test_1", "capture does not mutate the caller's DOM snapshot");
});

test("AX failure and out-of-scope requests preserve DOM evidence without guessing a name", async () => {
  const { createAccessibilityCollector } = await import("../background/capture/accessibility.js");
  for (const inScope of [true, false]) {
    let called = false;
    const collector = createAccessibilityCollector({ scope: { isInScope: async () => inScope }, screencast: {
      has: () => true, contexts: () => [1], send: async () => { called = true; throw new Error("closed"); }
    } });
    const result = await collector.captureAction({ target: { _axRef: "ax_test_2", id: "kept" } }, { tab: { id: 10 } });
    assert.equal(result.target.id, "kept");
    assert.equal(result.accessibility.status, "unavailable");
    assert.equal(result.accessibility.name, undefined);
    if (!inScope) assert.equal(called, false, "out-of-scope pages are never queried");
  }
});

test("ignored targets retain their identity and only expose bounded, useful ancestor evidence", async () => {
  const { createAccessibilityCollector } = await import("../background/capture/accessibility.js");
  for (const mode of ["useful", "generic", "disappeared"]) {
    const calls = [];
    let distance = 0;
    const collector = createAccessibilityCollector({ scope: { isInScope: async () => true }, screencast: {
      has: () => true, contexts: () => [1], send: async (_, method, params) => {
        calls.push({ method, params });
        if (method === "Runtime.evaluate") return { result: { objectId: "target", subtype: "node" } };
        if (method === "Runtime.callFunctionOn") {
          if (mode === "disappeared") throw new Error("detached");
          return { result: { objectId: `parent-${++distance}`, subtype: "node" } };
        }
        if (method === "DOM.describeNode") return { node: { backendNodeId: params.objectId === "target" ? 42 : 42 + distance } };
        if (method === "Accessibility.getPartialAXTree") return { nodes: [axNode({
          backendDOMNodeId: params.backendNodeId,
          ignored: params.backendNodeId === 42,
          role: { value: params.backendNodeId === 42 ? "none" : mode === "useful" ? "button" : "generic" },
          name: { value: mode === "useful" && params.backendNodeId !== 42 ? "More" : "" }
        })] };
        return {};
      }
    } });
    const result = await collector.captureAction({ target: { tagName: "span", _axRef: "ax_ignored" } }, { tab: { id: 10 } });
    assert.equal(result.target.tagName, "span");
    assert.equal(result.accessibility.status, "ignored");
    if (mode === "useful") {
      assert.equal(result.accessibility.relatedAncestor.name, "More");
      assert.equal(result.accessibility.relatedAncestor.distance, 1);
    } else assert.equal(result.accessibility.relatedAncestor, undefined);
    assert.equal(calls.filter(call => call.method === "Runtime.callFunctionOn").length, mode === "generic" ? 3 : 1);
    assert.ok(calls.filter(call => call.method === "Accessibility.getPartialAXTree").slice(1)
      .every(call => call.params.fetchRelatives === false));
    assert.equal(calls.at(-1).method, "Runtime.releaseObjectGroup");
  }
});

test("an AX query that never responds cannot block saving a step indefinitely", async () => {
  const { createAccessibilityCollector } = await import("../background/capture/accessibility.js");
  const collector = createAccessibilityCollector({ scope: { isInScope: async () => true }, screencast: {
    has: () => true, contexts: () => [1], send: () => new Promise(() => {})
  } });
  const result = await collector.captureAction({ target: { _axRef: "ax_test_3", id: "kept" } }, { tab: { id: 10 } });
  assert.equal(result.accessibility.reason, "timeout");
  assert.equal(result.target.id, "kept");
  assert.equal(result.accessibility.diagnostics.stage, "Runtime.evaluate");
  assert.equal(result.accessibility.diagnostics.contextsTried, 1);
  assert.ok(result.accessibility.diagnostics.elapsedMs >= 450);
});

test("AX lookup reuses the matching context per document and falls back after replacement", async () => {
  const { createAccessibilityCollector } = await import("../background/capture/accessibility.js");
  let contextIds = [1, 2, 3];
  let matching = 3;
  const tried = [];
  const collector = createAccessibilityCollector({ scope: { isInScope: async () => true }, screencast: {
    has: () => true, contexts: () => contextIds, send: async (_, method, params) => {
      if (method === "Runtime.evaluate") {
        tried.push(params.contextId);
        return { result: params.contextId === matching ? { objectId: "exact-token-node", subtype: "node" } : {} };
      }
      if (method === "DOM.describeNode") return { node: { backendNodeId: 42 } };
      if (method === "Accessibility.getPartialAXTree") return { nodes: [axNode()] };
      return {};
    }
  } });
  let counter = 0;
  const capture = async documentId => {
    tried.length = 0;
    const result = await collector.captureAction({ target: { _axRef: `ax_context_${++counter}` } },
      { tab: { id: 10 }, frameId: 0, documentId });
    assert.equal(result.accessibility.status, "captured");
    return [...tried];
  };
  assert.deepEqual(await capture("doc-a"), [1, 2, 3]);
  assert.deepEqual(await capture("doc-a"), [3]);
  assert.deepEqual(await capture("doc-b"), [1, 2, 3], "a different document cannot inherit the hint");
  matching = 2;
  assert.deepEqual(await capture("doc-a"), [3, 1, 2], "the hint must still resolve the exact token");
  contextIds = [1, 4];
  matching = 4;
  assert.deepEqual(await capture("doc-a"), [1, 4], "destroyed contexts are not queried");
});

test("slow object cleanup cannot turn captured AX evidence into a timeout or exhaust capacity", async () => {
  const { createAccessibilityCollector } = await import("../background/capture/accessibility.js");
  let releases = 0;
  const collector = createAccessibilityCollector({ scope: { isInScope: async () => true }, screencast: {
    has: () => true, contexts: () => [1], send: async (_, method) => {
      if (method === "Runtime.evaluate") return { result: { objectId: "target", subtype: "node" } };
      if (method === "DOM.describeNode") return { node: { backendNodeId: 42 } };
      if (method === "Accessibility.getPartialAXTree") return { nodes: [axNode()] };
      if (method === "Runtime.releaseObjectGroup") { releases++; return new Promise(() => {}); }
      return {};
    }
  } });
  for (let index = 0; index < 17; index++) {
    const result = await collector.captureAction({ target: { _axRef: `ax_slow_cleanup_${index}` } }, { tab: { id: 1 } });
    assert.equal(result.accessibility.status, "captured");
    assert.equal(result.accessibility.name, "Actual target");
  }
  assert.equal(releases, 17, "cleanup is still requested for every remote object group");
});

test("query timeouts release admission slots and late responses still release remote objects", async () => {
  const { createAccessibilityCollector } = await import("../background/capture/accessibility.js");
  let stall = true;
  const late = [];
  let releases = 0;
  const collector = createAccessibilityCollector({ scope: { isInScope: async () => true }, screencast: {
    has: () => true, contexts: () => [1], send: async (_, method) => {
      if (method === "Runtime.evaluate") {
        if (stall) return new Promise(resolve => late.push(resolve));
        return { result: { objectId: "node", subtype: "node" } };
      }
      if (method === "DOM.describeNode") return { node: { backendNodeId: 42 } };
      if (method === "Accessibility.getPartialAXTree") return { nodes: [axNode()] };
      if (method === "Runtime.releaseObjectGroup") releases++;
      return {};
    }
  } });
  const capture = index => collector.captureAction({ target: { _axRef: `ax_recovery_${index}` } }, { tab: { id: 1 } });
  const timedOut = await Promise.all(Array.from({ length: 16 }, (_, index) => capture(index)));
  assert.ok(timedOut.every(result => result.accessibility.reason === "timeout"));
  stall = false;
  assert.equal((await capture(16)).accessibility.status, "captured", "a temporary stall cannot disable AX for the session");
  for (const resolve of late) resolve({ result: { objectId: "late-node", subtype: "node" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases, 17);
});

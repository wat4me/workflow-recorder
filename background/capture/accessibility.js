/** Browser-computed AX evidence, kept separate from DOM-derived semantics. */
const MAX_CONTEXTS = 32;
const MAX_PENDING = 16;
const MAX_CONTEXT_HINTS = 64;
const TIMEOUT_MS = 500;
const STATES = new Set(["disabled", "checked", "expanded", "pressed", "selected", "required",
  "readonly", "focusable", "focused", "editable", "multiline", "hasPopup", "level", "invalid"]);
const unavailable = reason => ({ source: "chrome-accessibility", status: "unavailable", reason });
const text = value => typeof value === "string" ? value.slice(0, 300) : "";
const useful = node => node.status === "captured" && (node.name || (node.role && !["none", "generic", "RootWebArea"].includes(node.role)));

export function summarizeAX(nodes, backendNodeId) {
  const target = nodes.find(node => node.backendDOMNodeId === backendNodeId);
  if (!target) return unavailable("node-not-found");
  const summarize = node => ({
    role: text(node.role?.value), name: text(node.name?.value),
    ...(node.description ? { description: text(node.description.value) } : {}),
    ...(node.value && ["string", "number", "boolean"].includes(typeof node.value.value)
      ? { value: typeof node.value.value === "string" ? text(node.value.value) : node.value.value } : {}),
    properties: Object.fromEntries((node.properties || []).filter(item => STATES.has(item.name))
      .map(item => [item.name, typeof item.value?.value === "string" ? text(item.value.value) : item.value?.value])
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)))
  });
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const ancestors = [];
  const seen = new Set([target.nodeId]);
  let parent = byId.get(target.parentId);
  while (parent && ancestors.length < 3 && !seen.has(parent.nodeId)) {
    seen.add(parent.nodeId);
    ancestors.push({ ...summarize(parent), ignored: !!parent.ignored });
    parent = byId.get(parent.parentId);
  }
  return { source: "chrome-accessibility", status: target.ignored ? "ignored" : "captured",
    ...summarize(target), ancestors,
    ...(target.ignored ? { ignoredReasons: (target.ignoredReasons || []).slice(0, 8).map(item => text(item.name)) } : {}) };
}

export function createAccessibilityCollector({ screencast, scope }) {
  let pending = 0;
  const contextHints = new Map();
  async function captureNode(token, tabId, documentKey) {
    if (typeof token !== "string" || !/^ax_[a-z0-9_]{1,100}$/i.test(token)) return unavailable("missing-node-reference");
    if (pending >= MAX_PENDING) return unavailable("busy");
    pending++;
    const group = `workflow-ax-${token}`;
    let expired = false;
    let usedTransport = false;
    let timer;
    const startedAt = Date.now();
    let stage = "scope-check";
    let contextsTried = 0;
    const timeoutResult = () => ({ ...unavailable("timeout"), diagnostics: {
      stage, contextsTried, elapsedMs: Date.now() - startedAt
    } });
    const send = (method, params) => {
      stage = method;
      return screencast.send(tabId, method, params);
    };
    const read = async () => {
      try {
        if (!(await scope.isInScope(tabId))) return unavailable("out-of-scope");
        if (!screencast.has(tabId)) return unavailable("debugger-unavailable");
        const contexts = screencast.contexts(tabId);
        const hint = contextHints.get(documentKey);
        const candidates = contexts.includes(hint)
          ? [hint, ...contexts.filter(id => id !== hint)] : contexts;
        for (const contextId of candidates.slice(0, MAX_CONTEXTS)) {
          if (expired) return timeoutResult();
          let result;
          try {
            usedTransport = true;
            contextsTried++;
            result = await send("Runtime.evaluate", {
              contextId, objectGroup: group, silent: true,
              expression: `(() => { const refs = globalThis.__workflowAXTargets; const node = refs?.get(${JSON.stringify(token)}); refs?.delete(${JSON.stringify(token)}); return node; })()`
            });
          } catch { continue; } // A frame can navigate between context enumeration and lookup.
          const objectId = result.result?.objectId;
          if (!objectId || result.result?.subtype !== "node") continue;
          if (expired) return timeoutResult();
          // A hint only changes lookup order. The exact temporary token still
          // proves node identity, including after a context is replaced.
          contextHints.delete(documentKey);
          if (contextHints.size >= MAX_CONTEXT_HINTS) contextHints.delete(contextHints.keys().next().value);
          contextHints.set(documentKey, contextId);
          const { node } = await send("DOM.describeNode", { objectId });
          if (expired) return timeoutResult();
          const { nodes = [] } = await send("Accessibility.getPartialAXTree", {
            backendNodeId: node.backendNodeId, fetchRelatives: true
          });
          const summary = summarizeAX(nodes, node.backendNodeId);
          if (summary.status === "ignored") {
            // Ignored AX nodes often omit parentId. Walk the actual DOM chain
            // instead, and label any useful result as related ancestor evidence.
            let parentObjectId = objectId;
            for (let distance = 1; distance <= 3 && !expired; distance++) {
              try {
                const parent = await send("Runtime.callFunctionOn", {
                  objectId: parentObjectId, objectGroup: group, silent: true,
                  functionDeclaration: "function() { return this.parentElement || this.getRootNode()?.host || null; }"
                });
                if (parent.result?.subtype !== "node" || !parent.result.objectId || expired) break;
                parentObjectId = parent.result.objectId;
                const { node: parentNode } = await send("DOM.describeNode", { objectId: parentObjectId });
                if (expired) break;
                const { nodes: parentNodes = [] } = await send("Accessibility.getPartialAXTree", {
                  backendNodeId: parentNode.backendNodeId, fetchRelatives: false
                });
                const candidate = summarizeAX(parentNodes, parentNode.backendNodeId);
                if (useful(candidate)) { summary.relatedAncestor = { ...candidate, distance }; break; }
              } catch { break; } // Preserve the original ignored result if an ancestor disappears.
            }
          }
          return { ...summary, capturedAt: Date.now(), timing: "event-best-effort" };
        }
        return unavailable("node-unavailable");
      } catch { return unavailable("query-failed"); }
      finally {
        // Also releases objects returned after the caller's deadline elapsed.
        // Dispatch cleanup without making captured evidence wait for its reply.
        // A stalled release must not consume the query deadline or pending slot.
        if (usedTransport) screencast.send(tabId, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
      }
    };
    try {
      return await Promise.race([read(), new Promise(resolve => {
        timer = setTimeout(() => { expired = true; resolve(timeoutResult()); }, TIMEOUT_MS);
      })]);
    } finally {
      clearTimeout(timer);
      // Admission follows the bounded capture lifetime, not a CDP promise that
      // may settle much later. read() still cleans up its late remote handles.
      pending--;
    }
  }

  // Called before entering the serialized action queue, while the target is still
  // most likely present. Each route retains its queue position while AX resolves.
  async function captureAction(payload, sender) {
    if (!payload) return payload;
    const cleaned = { ...payload };
    const reads = new Map();
    const documentKey = JSON.stringify([sender.tab?.id, sender.frameId ?? 0, sender.documentId ?? null]);
    for (const field of ["target", "source"]) {
      if (!payload[field]) continue;
      const { _axRef, ...dom } = payload[field];
      cleaned[field] = dom;
      if (!reads.has(_axRef)) reads.set(_axRef, captureNode(_axRef, sender.tab?.id, documentKey));
      cleaned[field === "target" ? "accessibility" : "sourceAccessibility"] = reads.get(_axRef);
    }
    for (const field of ["accessibility", "sourceAccessibility"]) {
      if (cleaned[field]) cleaned[field] = await cleaned[field];
    }
    return cleaned;
  }
  return { captureAction };
}

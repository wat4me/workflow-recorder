/** One DOM-effect window per user intent, independent of worker/write latency. */
(function () {
  if (globalThis.RecorderClickEffects) return;
  const WINDOW_MS = 1200;

  function create({ onFinish }) {
    const observations = new Map();
    let active = null;

    function visibility(element) {
      if (!element?.isConnected) return "detached";
      const style = window.getComputedStyle(element);
      return `${style.display === "none"}|${["hidden", "collapse"].includes(style.visibility)}|${!!element.hidden}`;
    }

    function finish(observation, changed, reason, evidence = []) {
      if (!observation || observation.done) return;
      observation.done = true;
      clearTimeout(observation.timer);
      observation.result = { changed, reason, observedAt: Date.now(),
        interrupted: reason === "next-interaction" || reason === "viewport-resize" };
      onFinish?.(observation, evidence);
      observation.target = null;
      observation.visibility.clear();
      for (const resolve of observation.waiters) resolve(observation.result);
      observation.waiters = [];
      if (active === observation) active = null;
    }

    function begin(id, target, baseline) {
      interrupt("next-interaction");
      const observation = { id, target, baseline, startedAt: Date.now(), deadline: Date.now() + WINDOW_MS,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
        strong: !!globalThis.RecorderTargeting?.hasClickSemantics(target),
        visibility: new Map(), waiters: [], done: false };
      for (let element = target; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
        observation.visibility.set(element, visibility(element));
      }
      observation.timer = setTimeout(() => finish(observation, false, "timeout"), WINDOW_MS);
      observations.set(id, observation);
      active = observation;
      while (observations.size > 64) observations.delete(observations.keys().next().value);
    }

    function relevant(record, observation) {
      const node = record.target;
      const target = observation.target;
      const related = node === target || !!target?.contains?.(node);
      if (record.type === "attributes") {
        const name = record.attributeName;
        // MutationObserver also reports setAttribute(name, existingValue).
        if (record.oldValue === node.getAttribute(name)) return false;
        if (name === "class" || name === "style") {
          if (observation.visibility.has(node) && observation.visibility.get(node) !== visibility(node)) return true;
          // Colour/focus/animation/layout updates are not proof of an action.
          if (name === "style") return false;
          return observation.strong && related;
        }
        if (name === "value") return false;
        return observation.strong || related;
      }
      if (record.type === "characterData") return observation.strong || related;
      if (record.type === "childList") {
        // Keep JS-only open/close controls, including removal of their ancestor.
        return [...record.addedNodes, ...record.removedNodes].some(item =>
          item.nodeType === 1 && !["SCRIPT", "STYLE", "LINK", "META"].includes(item.tagName)) ||
          ((observation.strong || related) && (record.addedNodes.length > 0 || record.removedNodes.length > 0));
      }
      return false;
    }

    function observe(records) {
      if (!active) return;
      // A site's resize handler can mutate DOM before our resize listener runs
      // in the isolated world. Check the dimensions at the mutation itself.
      if (window.innerWidth !== active.viewportWidth || window.innerHeight !== active.viewportHeight) {
        return finish(active, false, "viewport-resize");
      }
      if (Date.now() > active.deadline) return finish(active, false, "timeout");
      const evidence = records.filter(record => relevant(record, active));
      if (evidence.length) finish(active, true, "dom-effect", evidence);
    }

    function interrupt(reason = "next-interaction") { finish(active, false, reason); }

    function wait(id) {
      const observation = observations.get(id);
      if (!observation) return Promise.resolve({ changed: false, reason: "unknown-click" });
      if (observation.done) return Promise.resolve(observation.result);
      return new Promise(resolve => observation.waiters.push(resolve));
    }

    return { begin, observe, interrupt, wait, stop: () => { interrupt("stopped"); observations.clear(); } };
  }

  globalThis.RecorderClickEffects = { create };
})();

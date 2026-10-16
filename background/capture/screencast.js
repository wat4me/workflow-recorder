/**
 * JPEG quality of the frames Chrome pushes. Not a user setting any more: see the
 * header of capture-settings.js for what measuring the sharpness presets showed.
 */
const SCREENCAST_JPEG_QUALITY = 75;

/** CDP screencast sessions and latest-frame cache for recorded tabs. */
export function createScreencastManager() {
  const sessions = new Map();
  const contexts = new Map();
  const starts = new Map();
  const waiters = new Map();

  function target(tabId) {
    return { tabId };
  }

  function send(tabId, method, params = {}) {
    return chrome.debugger.sendCommand(target(tabId), method, params);
  }

  async function start(tabId, plan = {}) {
    if (!Number.isInteger(tabId) || sessions.has(tabId)) return;
    if (starts.has(tabId)) return starts.get(tabId);

    const promise = (async () => {
      try {
        await chrome.debugger.attach(target(tabId), "1.3");
        contexts.set(tabId, new Set());
        await send(tabId, "Runtime.enable");
        await send(tabId, "Page.enable");
        if (plan.screenshots !== false) {
          await send(tabId, "Page.startScreencast", {
            format: "jpeg",
            // No scaling ceiling: each tab is captured at its current native viewport
            // resolution and naturally follows later window resizes. Chrome applies a
            // ceiling as a downscale and never a stretch, so passing one would be
            // safe -- there is simply no longer any reason to.
            quality: SCREENCAST_JPEG_QUALITY,
            // Fewer frames to encode, acknowledge and decode. Memory is flat across
            // 2/4/6, so this is a CPU and CDP-traffic setting, not a memory one, and
            // it is deliberately not exposed to the user.
            everyNthFrame: Number.isInteger(plan.frameStride) ? plan.frameStride : 2
          });
        }
        sessions.set(tabId, { frame: null, screenshots: plan.screenshots !== false });
      } catch (error) {
        sessions.delete(tabId);
        contexts.delete(tabId);
        try {
          await chrome.debugger.detach(target(tabId));
        } catch (detachError) {}
        throw error;
      } finally {
        starts.delete(tabId);
      }
    })();
    starts.set(tabId, promise);
    return promise;
  }

  async function stop(tabId) {
    if (starts.has(tabId)) {
      try {
        await starts.get(tabId);
      } catch (error) {}
    }
    if (!sessions.has(tabId)) return;
    const session = sessions.get(tabId);
    sessions.delete(tabId);
    contexts.delete(tabId);
    rejectWaiters(tabId, new Error("Screencast stopped"));
    try {
      if (session.screenshots) await send(tabId, "Page.stopScreencast");
    } catch (error) {}
    try {
      await chrome.debugger.detach(target(tabId));
    } catch (error) {}
  }

  async function stopAll() {
    await Promise.all([...new Set([...sessions.keys(), ...starts.keys()])].map(stop));
  }

  async function getFrame(tabId, afterAt = 0, timeoutMs = 800) {
    if (starts.has(tabId)) await starts.get(tabId);
    const session = sessions.get(tabId);
    if (!session) throw new Error(`Screencast is not active for tab ${tabId}`);
    if (session.frame?.at >= afterAt) {
      return session.frame;
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        afterAt,
        resolve,
        reject,
        timer: setTimeout(() => {
          removeWaiter(tabId, waiter);
          reject(new Error(`Timed out waiting for screencast frame for tab ${tabId}`));
        }, timeoutMs)
      };
      const tabWaiters = waiters.get(tabId) || [];
      tabWaiters.push(waiter);
      waiters.set(tabId, tabWaiters);
    });
  }

  function getLatestFrame(tabId) {
    return sessions.get(tabId)?.frame || null;
  }

  function removeWaiter(tabId, waiter) {
    const remaining = (waiters.get(tabId) || []).filter(item => item !== waiter);
    if (remaining.length > 0) waiters.set(tabId, remaining);
    else waiters.delete(tabId);
  }

  function resolveWaiters(tabId, frame) {
    const pending = waiters.get(tabId) || [];
    pending.forEach(waiter => {
      if (frame.at < waiter.afterAt) return;
      clearTimeout(waiter.timer);
      removeWaiter(tabId, waiter);
      waiter.resolve(frame);
    });
  }

  function rejectWaiters(tabId, error) {
    (waiters.get(tabId) || []).forEach(waiter => {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    });
    waiters.delete(tabId);
  }

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!Number.isInteger(source.tabId)) return;
    const worlds = contexts.get(source.tabId);
    if (method === "Runtime.executionContextCreated" && params.context?.auxData?.isDefault === false) {
      worlds?.add(params.context.id);
    }
    if (method === "Runtime.executionContextDestroyed") worlds?.delete(params.executionContextId);
    if (method === "Runtime.executionContextsCleared") worlds?.clear();
    if (method !== "Page.screencastFrame") return;
    const tabId = source.tabId;
    // ACK immediately so Chrome can continue pushing frames without backpressure.
    send(tabId, "Page.screencastFrameAck", { sessionId: params.sessionId }).catch(error => {
      console.warn(`[Screencast] Failed to acknowledge frame for tab ${tabId}:`, error.message);
    });

    const session = sessions.get(tabId);
    if (!session) return;
    const frame = {
      at: Date.now(),
      data: params.data,
      metadata: params.metadata || null,
      sessionId: params.sessionId
    };
    session.frame = frame;
    resolveWaiters(tabId, frame);
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (!Number.isInteger(source.tabId)) return;
    sessions.delete(source.tabId);
    contexts.delete(source.tabId);
    rejectWaiters(source.tabId, new Error(`Debugger detached: ${reason}`));
  });

  return {
    send,
    contexts: tabId => [...(contexts.get(tabId) || [])],
    getFrame,
    getLatestFrame,
    has: tabId => sessions.has(tabId) || starts.has(tabId),
    start,
    stop,
    stopAll
  };
}

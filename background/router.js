/**
 * Message dispatch.
 *
 * This used to be a ~100 line if-chain inside the onMessage listener, where each
 * branch repeated the `return true` / error-shaping dance and it was easy to add
 * a handler that forgot one of them. Handlers are now a plain name -> function
 * map: they return a value or a promise, and the shared wrapper does the rest.
 *
 * Every handler is treated as async and every message keeps the channel open.
 * That is uniform rather than optimal, and it is the safe direction to be wrong
 * in: a dropped channel surfaces as a silent timeout in the panel.
 */
export function registerMessageRouter(handlers) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const handler = handlers[request?.action];
    if (!handler) return false;

    Promise.resolve()
      .then(() => handler(request, sender))
      .then(sendResponse, error => {
        console.error(`[Background] ${request.action} failed:`, error);
        sendResponse({ success: false, error: error?.message || String(error) });
      });
    return true;
  });
}

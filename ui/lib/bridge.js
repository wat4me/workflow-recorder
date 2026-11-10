/**
 * The panels' only channel to the Service Worker and to stored media.
 *
 * Everything goes through sendRuntimeMessage so a suspended or crashed worker
 * surfaces as a timed-out response object rather than a promise that never
 * settles and a button that stays disabled forever.
 */
(function () {
  if (globalThis.RecorderBridge) return;

  const { t } = globalThis.RecorderI18n;
  const { MESSAGE } = globalThis.WorkflowRecorderProtocol;
  const DEFAULT_TIMEOUT_MS = 15000;

  function messageError(error) {
    if (/message (?:port|channel) closed before a response|receiving end does not exist/i.test(error)) {
      return t("messageConnectionClosed", [], "扩展消息连接已中断。请等待页面加载完成后重试。");
    }
    return error;
  }

  function sendRuntimeMessage(message, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise(resolve => {
      let settled = false;
      const finish = response => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      };
      const timer = setTimeout(() => finish({
        success: false,
        error: t("messageTimeout", [], "插件响应超时，请重试")
      }), timeoutMs);

      try {
        chrome.runtime.sendMessage(message, response => {
          const error = chrome.runtime.lastError;
          if (error) {
            finish({ success: false, error: messageError(error.message) });
            return;
          }
          if (response?.success === false && response.error) {
            finish({ ...response, error: messageError(response.error) });
            return;
          }
          finish(response ?? { success: false, error: t("emptyMessageResponse", [], "插件未返回处理结果") });
        });
      } catch (error) {
        finish({ success: false, error: messageError(error.message) });
      }
    });
  }

  /**
   * Steps are stored as one key per action, so the Service Worker assembles the
   * ordered list. Panels must not reconstruct that layout themselves.
   */
  async function readActions() {
    const response = await sendRuntimeMessage({ action: MESSAGE.getActions });
    // Null rather than an empty list when the worker cannot be reached: a
    // timeout must not read as "this workspace has no steps".
    return response?.success ? response.actions || [] : null;
  }

  /** Screenshot blobs. Resolves null rather than throwing: a missing screenshot
   * degrades one card, it does not break the step list. */
  async function getBlob(key) {
    try {
      return await globalThis.RecorderMediaStore.getBlob(key);
    } catch (error) {
      console.error("[IndexedDB] Error fetching blob:", error);
      return null;
    }
  }

  globalThis.RecorderBridge = { getBlob, readActions, sendRuntimeMessage };
})();

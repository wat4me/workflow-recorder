import "../../shared/protocol.js";
import { createAgentJobStore, STORAGE_KEY } from "./job-store.js";
import { HOST_NAME, NATIVE_MESSAGE, PROTOCOL_VERSION } from "./protocol.js";

const { MESSAGE } = globalThis.WorkflowRecorderProtocol;
const REQUEST_TIMEOUT_MS = 30_000;

export function createNativeAgentController(options = {}) {
  const runtime = options.runtime || chrome.runtime;
  const storage = options.storage || chrome.storage.local;
  const hostName = options.hostName || HOST_NAME;
  const jobStore = createAgentJobStore(storage);
  let port = null;
  let helloPromise = null;
  let requestCounter = 0;
  const pending = new Map();

  function requestId() {
    requestCounter += 1;
    return `extension-${Date.now().toString(36)}-${requestCounter}`;
  }

  function broadcast(message) {
    runtime.sendMessage({ action: MESSAGE.agentJobUpdated, message }).catch(() => {});
  }

  function disconnect(reason) {
    port = null;
    helloPromise = null;
    for (const [, request] of pending) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    pending.clear();
    jobStore.markDisconnected(reason).catch(() => {});
    broadcast({ type: "native.disconnected", error: reason });
  }

  function attach() {
    if (port) return port;
    const nextPort = runtime.connectNative(hostName);
    port = nextPort;
    nextPort.onMessage.addListener(message => {
      jobStore.persistMessage(message).then(() => broadcast(message)).catch(() => broadcast(message));
      const request = pending.get(message?.requestId);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.requestId);
      if (message.error) {
        const error = new Error(message.error.message);
        error.code = message.error.code;
        error.layer = message.error.layer;
        request.reject(error);
      } else {
        request.resolve(message);
      }
    });
    nextPort.onDisconnect.addListener(() => {
      const reason = runtime.lastError?.message || "Native Messaging Host disconnected";
      if (port === nextPort) disconnect(reason);
    });
    return nextPort;
  }

  function request(type, payload, jobId = null, timeoutMs = REQUEST_TIMEOUT_MS) {
    const currentPort = attach();
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId(),
      jobId,
      type,
      payload,
      error: null
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.requestId);
        reject(new Error(`Native Host ${type} 请求超时`));
      }, timeoutMs);
      pending.set(message.requestId, { resolve, reject, timer });
      try {
        currentPort.postMessage(message);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(message.requestId);
        reject(error);
      }
    });
  }

  async function connect() {
    if (helloPromise) return helloPromise;
    helloPromise = request(NATIVE_MESSAGE.hello, {
      client: "workflow-recorder-extension",
      clientVersion: runtime.getManifest().version,
      protocolVersions: [PROTOCOL_VERSION],
      capabilities: ["chunked-swrcase", "job-events", "job-cancel"]
    }).then(response => response.payload).catch(error => {
      helloPromise = null;
      throw error;
    });
    return helloPromise;
  }

  async function createJob(requestPayload) {
    await connect();
    const response = await request(NATIVE_MESSAGE.createJob, {
      provider: requestPayload.provider,
      skill: requestPayload.skill || "test-base",
      timeoutMs: requestPayload.timeoutMs,
      workspacePath: requestPayload.workspacePath,
      input: {
        fileName: requestPayload.fileName,
        totalBytes: requestPayload.totalBytes,
        sha256: requestPayload.sha256
      }
    });
    await jobStore.associateJob(response.payload.jobId, {
      clientCaseId: requestPayload.caseId,
      clientCaseName: requestPayload.caseName,
      provider: requestPayload.provider,
      workspacePath: requestPayload.workspacePath || null,
      status: response.payload.status
    });
    return response;
  }

  async function uploadChunk(requestPayload) {
    await connect();
    return request(NATIVE_MESSAGE.uploadChunk, requestPayload.chunk, requestPayload.jobId);
  }

  async function commitAndStart(requestPayload) {
    await connect();
    await request(NATIVE_MESSAGE.commitInput, requestPayload.commit, requestPayload.jobId, 120_000);
    return request(NATIVE_MESSAGE.startJob, { mode: requestPayload.mode || "plan" }, requestPayload.jobId);
  }

  async function cancel(jobId) {
    await connect();
    return request(NATIVE_MESSAGE.cancelJob, {}, jobId);
  }

  async function followup(requestPayload) {
    await connect();
    return request(NATIVE_MESSAGE.followup, {
      message: requestPayload.message,
      mode: requestPayload.mode
    }, requestPayload.jobId, 60_000);
  }

  async function query(jobId) {
    await connect();
    return request(NATIVE_MESSAGE.jobStatus, {}, jobId);
  }

  return {
    connect,
    createJob,
    uploadChunk,
    commitAndStart,
    followup,
    cancel,
    query,
    readJobs: jobStore.readJobs,
    recoverInterruptedJobs: jobStore.recoverInterruptedJobs
  };
}

export { HOST_NAME, PROTOCOL_VERSION, STORAGE_KEY };

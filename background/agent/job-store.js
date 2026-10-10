import "../../shared/protocol.js";
import { NATIVE_MESSAGE } from "./protocol.js";

const { ACTIVE_AGENT_STATUSES, AGENT_STATUS } = globalThis.WorkflowRecorderProtocol;
export const STORAGE_KEY = "recorderAgentJobs";
const MAX_EVENTS = 100;
const MAX_JOBS = 20;
const MAX_EVENT_TEXT = 16 * 1024;

export function createAgentJobStore(storage) {
  let queue = Promise.resolve();

  async function readJobs() {
    const result = await storage.get(STORAGE_KEY);
    return result[STORAGE_KEY] || {};
  }

  function limitJobs(jobs) {
    return Object.fromEntries(Object.entries(jobs)
      .sort(([, left], [, right]) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .slice(0, MAX_JOBS));
  }

  function trimEvent(event) {
    const copy = structuredClone(event);
    if (typeof copy?.data?.text === "string" && copy.data.text.length > MAX_EVENT_TEXT) {
      copy.data.text = copy.data.text.slice(-MAX_EVENT_TEXT);
      copy.data.truncated = true;
    }
    return copy;
  }

  function persistMessage(message) {
    if (!message?.jobId) return Promise.resolve();
    queue = queue.then(async () => {
      const jobs = await readJobs();
      const current = jobs[message.jobId] || { jobId: message.jobId, events: [] };
      const next = {
        ...current,
        ...(message.payload || {}),
        jobId: message.jobId,
        messageType: message.type,
        error: message.error || null,
        updatedAt: Date.now()
      };
      if (message.type === NATIVE_MESSAGE.jobEvent) {
        next.events = [...(current.events || []), trimEvent(message.payload)].slice(-MAX_EVENTS);
      }
      await storage.set({ [STORAGE_KEY]: limitJobs({ ...jobs, [message.jobId]: next }) });
    });
    return queue;
  }

  function associateJob(jobId, metadata) {
    queue = queue.then(async () => {
      const jobs = await readJobs();
      jobs[jobId] = { ...(jobs[jobId] || { jobId, events: [] }), ...metadata, updatedAt: Date.now() };
      await storage.set({ [STORAGE_KEY]: limitJobs(jobs) });
    });
    return queue;
  }

  async function failActiveJobs(reason, phase, code, layer) {
    const jobs = await readJobs();
    let changed = false;
    for (const job of Object.values(jobs)) {
      if (!ACTIVE_AGENT_STATUSES.has(job.status)) continue;
      job.connection = phase === "disconnected" ? "disconnected" : job.connection;
      job.connectionError = phase === "disconnected" ? reason : job.connectionError;
      job.status = AGENT_STATUS.failed;
      job.phase = phase;
      job.error = { code, message: reason, layer, retryable: true };
      job.updatedAt = Date.now();
      changed = true;
    }
    if (changed) await storage.set({ [STORAGE_KEY]: limitJobs(jobs) });
    return changed;
  }

  return {
    associateJob,
    markDisconnected: reason => failActiveJobs(reason, "disconnected", "HOST_DISCONNECTED", "protocol"),
    persistMessage,
    readJobs,
    recoverInterruptedJobs: () => failActiveJobs(
      "扩展后台已重启，原任务连接已中断，请重新提交",
      "background-restarted",
      "BACKGROUND_RESTARTED",
      "bridge"
    )
  };
}

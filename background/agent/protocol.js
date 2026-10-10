export const PROTOCOL_VERSION = "1.0";
export const HOST_NAME = "com.workflow_recorder.agent_bridge";

export const NATIVE_MESSAGE = Object.freeze({
  hello: "hello",
  createJob: "job.create",
  uploadChunk: "job.input.chunk",
  commitInput: "job.input.commit",
  startJob: "job.start",
  cancelJob: "job.cancel",
  followup: "job.followup",
  jobStatus: "job.status",
  jobEvent: "job.event"
});

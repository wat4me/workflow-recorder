const assert = require("node:assert/strict");
const test = require("node:test");

function createStorage() {
  const values = {};
  return {
    values,
    async get(key) {
      return { [key]: structuredClone(values[key]) };
    },
    async set(entry) {
      Object.assign(values, structuredClone(entry));
    }
  };
}

function createPort() {
  let onMessage;
  let onDisconnect;
  return {
    posted: [],
    onMessage: { addListener(listener) { onMessage = listener; } },
    onDisconnect: { addListener(listener) { onDisconnect = listener; } },
    postMessage(message) { this.posted.push(message); },
    receive(message) { onMessage(message); },
    disconnect() { onDisconnect(); }
  };
}

test("background Native Agent negotiates hello and persists job updates", async () => {
  const storage = createStorage();
  const port = createPort();
  const broadcasts = [];
  const runtime = {
    lastError: null,
    getManifest: () => ({ version: "1.0.0" }),
    connectNative: () => port,
    sendMessage: async message => broadcasts.push(message)
  };
  const module = await import(`../background/agent/native-agent.js?test=${Math.random()}`);
  assert.equal(module.HOST_NAME, "com.workflow_recorder.agent_bridge");
  const controller = module.createNativeAgentController({ runtime, storage, hostName: "test.host" });
  const helloPromise = controller.connect();
  assert.equal(port.posted[0].type, "hello");
  assert.equal(port.posted[0].protocolVersion, "1.0");
  assert.equal(port.posted[0].payload.client, "workflow-recorder-extension");
  port.receive({
    protocolVersion: "1.0",
    requestId: port.posted[0].requestId,
    jobId: null,
    type: "hello.result",
    payload: { protocolVersion: "1.0", maxChunkBytes: 262144 },
    error: null
  });
  assert.deepEqual(await helloPromise, { protocolVersion: "1.0", maxChunkBytes: 262144 });

  const jobPromise = controller.createJob({
    provider: "zcode",
    workspacePath: "D:\\project\\selected",
    skill: "test-base",
    caseId: "case-1",
    caseName: "Case one",
    fileName: "case.swrcase",
    totalBytes: 10,
    sha256: "a".repeat(64)
  });
  await new Promise(resolve => setImmediate(resolve));
  const request = port.posted.at(-1);
  assert.equal(request.type, "job.create");
  assert.equal(request.payload.input.fileName, "case.swrcase");
  assert.equal(request.payload.workspacePath, "D:\\project\\selected");
  port.receive({
    protocolVersion: "1.0",
    requestId: request.requestId,
    jobId: "job-1",
    type: "job.created",
    payload: { jobId: "job-1", inputId: "input-1", status: "awaiting-input" },
    error: null
  });
  const created = await jobPromise;
  assert.equal(created.payload.jobId, "job-1");
  assert.equal(storage.values.recorderAgentJobs["job-1"].clientCaseId, "case-1");
  assert.equal(storage.values.recorderAgentJobs["job-1"].workspacePath, "D:\\project\\selected");

  port.receive({
    protocolVersion: "1.0",
    requestId: "event-1",
    jobId: "job-1",
    type: "job.event",
    payload: {
      sequence: 1,
      timestamp: new Date().toISOString(),
      category: "stdout",
      level: "info",
      data: { text: "progress" }
    },
    error: null
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(storage.values.recorderAgentJobs["job-1"].events.length, 1);
  assert.equal(broadcasts.at(-1).action, "agentJobUpdated");
});

test("background Native Agent does not reconnect after a protocol disconnect without active work", async () => {
  const storage = createStorage();
  const port = createPort();
  const runtime = {
    lastError: null,
    getManifest: () => ({ version: "1.0.0" }),
    connectNative: () => port,
    sendMessage: async () => {}
  };
  const module = await import(`../background/agent/native-agent.js?test=${Math.random()}`);
  const controller = module.createNativeAgentController({ runtime, storage });
  const promise = controller.connect();
  const request = port.posted[0];
  port.receive({ protocolVersion: "1.0", requestId: request.requestId, jobId: null, type: "hello.result", payload: {}, error: null });
  await promise;
  port.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(Object.keys(storage.values).length, 0);
  assert.equal(typeof controller.connect, "function");
});

test("background Native Agent marks active jobs failed after host disconnect or worker restart", async () => {
  const storage = createStorage();
  storage.values.recorderAgentJobs = {
    "job-running": { jobId: "job-running", status: "running", updatedAt: 1, events: [] }
  };
  const port = createPort();
  const runtime = {
    lastError: { message: "host exited" },
    getManifest: () => ({ version: "1.0.0" }),
    connectNative: () => port,
    sendMessage: async () => {}
  };
  const module = await import(`../background/agent/native-agent.js?test=${Math.random()}`);
  const controller = module.createNativeAgentController({ runtime, storage });
  const hello = controller.connect();
  const request = port.posted[0];
  port.receive({ protocolVersion: "1.0", requestId: request.requestId, jobId: null, type: "hello.result", payload: {}, error: null });
  await hello;
  port.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(storage.values.recorderAgentJobs["job-running"].status, "failed");
  assert.equal(storage.values.recorderAgentJobs["job-running"].error.code, "HOST_DISCONNECTED");

  storage.values.recorderAgentJobs["job-restart"] = {
    jobId: "job-restart", status: "awaiting-input", updatedAt: 2, events: []
  };
  await controller.recoverInterruptedJobs();
  assert.equal(storage.values.recorderAgentJobs["job-restart"].status, "failed");
  assert.equal(storage.values.recorderAgentJobs["job-restart"].error.code, "BACKGROUND_RESTARTED");
});

test("background Native Agent forwards job.followup to the selected run", async () => {
  const storage = createStorage();
  const port = createPort();
  const runtime = {
    lastError: null,
    getManifest: () => ({ version: "1.0.0" }),
    connectNative: () => port,
    sendMessage: async () => {}
  };
  const module = await import(`../background/agent/native-agent.js?test=${Math.random()}`);
  const controller = module.createNativeAgentController({ runtime, storage });
  const hello = controller.connect();
  const helloRequest = port.posted[0];
  port.receive({ protocolVersion: "1.0", requestId: helloRequest.requestId, jobId: null, type: "hello.result", payload: {}, error: null });
  await hello;
  const followupPromise = controller.followup({ jobId: "job-1", mode: "plan", message: "补充地址" });
  await new Promise(resolve => setImmediate(resolve));
  const request = port.posted.at(-1);
  assert.equal(request.type, "job.followup");
  assert.equal(request.jobId, "job-1");
  assert.equal(request.payload.message, "补充地址");
  port.receive({
    protocolVersion: "1.0", requestId: request.requestId, jobId: "job-1", type: "job.status",
    payload: { jobId: "job-1", status: "running", attempt: 2 }, error: null
  });
  assert.equal((await followupPromise).payload.attempt, 2);
});

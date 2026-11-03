import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  NodeFS.readFileSync(NodePath.join(here, "codexMultiAgentWire.json"), "utf8"),
);
const script = JSON.parse(NodeFS.readFileSync(process.env.GOAT_CODEX_COLLAB_SCRIPT, "utf8"));

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const soak = process.env.GOAT_CODEX_MOCK_SOAK === "1";
const lifecycleLog = process.env.GOAT_SOAK_PROVIDER_LIFECYCLE_LOG;
const lifecycle = (event, extra = {}) => {
  if (lifecycleLog)
    NodeFS.appendFileSync(
      lifecycleLog,
      `${JSON.stringify({
        event,
        pid: process.pid,
        instance: process.env.GOAT_SOAK_PROVIDER_INSTANCE ?? "codex",
        at: new Date().toISOString(),
        ...extra,
      })}\n`,
    );
};
if (lifecycleLog) {
  lifecycle("start");
  process.on("exit", (code) => lifecycle("exit", { code }));
}
const soakSessions = new Map();
const latencyText =
  process.env.GOAT_CODEX_MOCK_LATENCIES_MS ??
  process.env.GOAT_CODEX_MOCK_LATENCY_MS ??
  "0,20000,45000";
const latencies = latencyText.split(",").map(Number);
const turnMs = Number(process.env.GOAT_CODEX_MOCK_TURN_MS ?? "70000");
if (
  soak &&
  (latencyText.split(",").some((n) => !/^\d+$/.test(n)) ||
    latencies.length > 100 ||
    latencies.some((n) => !Number.isInteger(n) || n < 0 || n > 45000) ||
    !Number.isInteger(turnMs) ||
    turnMs < 0 ||
    turnMs > 3600000)
) {
  throw new Error("invalid soak latency or turn duration");
}
let latencyIndex = 0;
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });
function soakRequest(message) {
  const { id, method, params = {} } = message;
  if (method === "thread/start" || method === "thread/resume") {
    const threadId = method === "thread/start" ? NodeCrypto.randomUUID() : params.threadId;
    if (typeof threadId !== "string" || soakSessions.size >= 10000) {
      write({ id, error: { code: -32000, message: "invalid thread or session limit" } });
      return true;
    }
    const result = structuredClone(fixture.responses.threadStart);
    result.thread.id = threadId;
    result.thread.sessionId = threadId;
    result.thread.path = null;
    result.thread.cwd = params.cwd ?? result.thread.cwd;
    result.cwd = result.thread.cwd;
    result.instructionSources = [];
    soakSessions.set(threadId, { active: null });
    lifecycle("session", { thread: threadId });
    write({ id, result });
    return true;
  }
  if (method === "turn/start") {
    const threadId = params.threadId;
    const session = soakSessions.get(threadId);
    if (!session || session.active) {
      write({ id, error: { code: -32000, message: "unknown or busy thread" } });
      return true;
    }
    if (
      lifecycleLog &&
      Array.isArray(params.input) &&
      params.input.some((item) => item?.text === "GOAT_SOAK_EXIT")
    )
      process.exit(1);
    const turnId = NodeCrypto.randomUUID();
    const itemId = NodeCrypto.randomUUID();
    const turn = { ...fixture.responses.turnStart.turn, id: turnId };
    const delay = latencies[latencyIndex++ % latencies.length];
    const active = { start: null, interval: null, finish: null, responded: false, requestId: id };
    session.active = active;
    const sidecar = (event) => {
      if (lifecycleLog)
        NodeFS.appendFileSync(
          `${lifecycleLog}.codex-turns`,
          `${JSON.stringify({ event, threadId, turnId, requestId: id, delay, at: new Date().toISOString() })}\n`,
        );
    };
    sidecar("scheduled");
    active.start = setTimeout(() => {
      write({ id, result: { turn } });
      active.responded = true;
      sidecar("started");
      notify("turn/started", { threadId, turn });
      notify("item/started", {
        threadId,
        turnId,
        startedAtMs: Date.now(),
        item: { type: "agentMessage", id: itemId, text: "" },
      });
      let output = "";
      const delta = () => {
        output += "soak ok ";
        notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: "soak ok " });
      };
      delta();
      active.interval = setInterval(delta, 10000);
      active.finish = setTimeout(() => {
        clearInterval(active.interval);
        notify("item/completed", {
          threadId,
          turnId,
          completedAtMs: Date.now(),
          item: { type: "agentMessage", id: itemId, text: output },
        });
        notify("turn/completed", { threadId, turn: { ...turn, status: "completed" } });
        session.active = null;
        sidecar("completed");
      }, turnMs);
    }, delay);
    return true;
  }
  if (method === "turn/interrupt") {
    const session = soakSessions.get(params.threadId);
    if (session?.active) {
      clearTimeout(session.active.start);
      clearInterval(session.active.interval);
      clearTimeout(session.active.finish);
      if (!session.active.responded)
        write({
          id: session.active.requestId,
          error: { code: -32000, message: "turn interrupted" },
        });
      session.active = null;
    }
    write({ id, result: {} });
    return true;
  }
  if (method === "account/rateLimits/read") {
    write({ id, result: { rateLimits: {} } });
    return true;
  }
  return false;
}
let turnStartCount = 0;
let activeTurn;
const openServerRequests = new Map();
const rl = NodeReadline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = message;
  if (soak && soakRequest(message)) return;
  if (openServerRequests.has(id)) {
    // Match real Codex's resolved item ID so the runtime closes the corresponding approval card.
    const request = openServerRequests.get(id);
    openServerRequests.delete(id);
    NodeFS.appendFileSync(
      `${process.env.GOAT_CODEX_COLLAB_SCRIPT}.approvalResponses`,
      `${JSON.stringify({ id, label: request.label, result: message.result ?? null })}\n`,
    );
    write({
      jsonrpc: "2.0",
      method: "serverRequest/resolved",
      params: {
        threadId: script.rootThreadId,
        requestId: request.itemId ?? request.label,
      },
    });
    return;
  }
  if (method === undefined && script.serverRequests?.some((request) => request.id === id)) {
    NodeFS.appendFileSync(
      `${process.env.GOAT_CODEX_COLLAB_SCRIPT}.responses`,
      `${JSON.stringify({ id, result: message.result, error: message.error })}\n`,
    );
    if (script.completeTurnOnServerResponse && activeTurn) {
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: script.rootThreadId,
          turn: { ...activeTurn, status: "completed" },
        },
      });
    }
    return;
  }
  if (method === "initialize") {
    write({
      id,
      result: {
        userAgent: "t3-collab-mock/0.0.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }
  if (method === "account/read") {
    write({
      id,
      result: { account: script.account ?? { type: "apiKey" }, requiresOpenaiAuth: false },
    });
    return;
  }
  if (method === "account/rateLimits/read" && script.failRateLimitsRead) {
    write({ id, error: { code: -32000, message: "usage unavailable" } });
    return;
  }
  if (method === "account/rateLimitResetCredit/consume" && script.resetCreditOutcome) {
    write({ id, result: { outcome: script.resetCreditOutcome } });
    return;
  }
  if (method === "skills/list" || method === "model/list") {
    write({ id, result: { data: [] } });
    return;
  }
  if (method === "thread/start") {
    write({ id, result: fixture.responses.threadStart });
    return;
  }
  if (method === "thread/inject_items" && script.recordRequests) {
    NodeFS.appendFileSync(
      `${process.env.GOAT_CODEX_COLLAB_SCRIPT}.requests`,
      `${JSON.stringify({ method, params: message.params })}\n`,
    );
    write({ id, result: {} });
    return;
  }
  if (method === "thread/resume") {
    if (script.recordRequests) {
      NodeFS.appendFileSync(
        `${process.env.GOAT_CODEX_COLLAB_SCRIPT}.requests`,
        `${JSON.stringify({ method, params: message.params })}\n`,
      );
    }
    const threadId = message.params?.threadId;
    const childSnapshot = script.childResumeSnapshots?.[threadId];
    if (script.resumeRequestMarker) {
      write({
        jsonrpc: "2.0",
        method: "serverRequest/resolved",
        params: {
          threadId: script.rootThreadId,
          requestId: script.resumeRequestMarker,
        },
      });
    }
    if (childSnapshot?.hang) {
      return;
    }
    if (childSnapshot?.error) {
      write({ id, error: { code: -32000, message: childSnapshot.error } });
      return;
    }
    if (childSnapshot) {
      write({
        id,
        result: {
          ...fixture.responses.threadStart,
          model: childSnapshot.model,
          reasoningEffort: childSnapshot.reasoningEffort,
          thread: {
            ...fixture.responses.threadStart.thread,
            id: threadId,
            sessionId: threadId,
          },
        },
      });
      for (const notification of childSnapshot.notifications ?? []) {
        write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
      }
      return;
    }
    write({ id, result: fixture.responses.threadStart });
    return;
  }
  if (method === "turn/start") {
    const turnId = script.turnIds?.[turnStartCount];
    const turn = turnId
      ? { ...fixture.responses.turnStart.turn, id: turnId }
      : fixture.responses.turnStart.turn;
    activeTurn = turn;
    turnStartCount += 1;
    write({ id, result: { ...fixture.responses.turnStart, turn } });
    const rootThreadId = script.rootThreadId;
    if (script.onlyFirstTurnStarts !== true || turnStartCount === 1) {
      write({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId: rootThreadId, turn },
      });
    }
    for (const notification of script.notifications) {
      write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
    }
    for (const [index, request] of (script.serverRequests ?? []).entries()) {
      if (request.id !== undefined) {
        write({ jsonrpc: "2.0", id: request.id, method: request.method, params: request.params });
        continue;
      }
      const requestId = 9000 + index;
      const label = request.label ?? `approval-${requestId}`;
      openServerRequests.set(requestId, { label, itemId: request.params?.itemId });
      const params = JSON.parse(
        JSON.stringify(request.params)
          .replaceAll("${threadId}", String(rootThreadId))
          .replaceAll("${turnId}", String(turn.id)),
      );
      write({ jsonrpc: "2.0", id: requestId, method: request.method, params });
    }
    if (script.holdTurnOpen !== true) {
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: rootThreadId,
          turn: { ...turn, status: "completed" },
        },
      });
    }
    return;
  }
  if (method === "turn/interrupt") {
    const target = message.params?.threadId;
    NodeFS.appendFileSync(
      `${process.env.GOAT_CODEX_COLLAB_SCRIPT}.interrupts`,
      `${JSON.stringify({ threadId: target, turnId: message.params?.turnId })}\n`,
    );
    if (
      script.expectedActiveTurnId &&
      message.params?.threadId === script.rootThreadId &&
      message.params?.turnId !== script.expectedActiveTurnId
    ) {
      write({
        id,
        error: {
          code: -32000,
          message: `expected active turn id ${message.params?.turnId} but found ${script.expectedActiveTurnId}`,
        },
      });
      return;
    }
    if (script.failInterruptFor && script.failInterruptFor === target) {
      write({ id, error: { code: -32000, message: "thread already closed" } });
      return;
    }
    if (script.hangInterruptFor && script.hangInterruptFor === target) {
      return;
    }
    write({ id, result: {} });
    return;
  }
  if (id !== undefined) {
    if (soak) write({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
    else write({ id, result: {} });
  }
});

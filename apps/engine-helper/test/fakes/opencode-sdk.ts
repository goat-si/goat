// Offline SDK double. Scripts use the prompt text; no credentials or network.
export const calls: Array<{ method: string; args: unknown }> = [];
export let sendEvent: (type: string, properties: unknown) => Promise<void> = async () => { throw new Error("no fake session"); };
let sequence = 0;
let statusGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let statusReached: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let promptGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let promptReached: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let abortGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let abortReached: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let abortTarget: string | undefined;
let abortFailure: string | undefined;
let history: Array<{ info: { id: string; role: "user" | "assistant" } }> = [];
let health = { healthy: true, version: "1.15.13" };
const servers: Array<{ exit?: () => void }> = [];
const children = new Map<string, string[]>();
const nativePermissions = new Map<string, Array<{ permission: string; pattern: string; action: "allow" | "ask" | "deny" }>>();
const nativeMetadata = new Map<string, Record<string, unknown>>();
const nativeStatuses = new Map<string, "idle" | "busy">();
let mcpStatus: "connected" | "failed" | "disabled" | "needs_auth" | "missing" = "connected";
export function reset() { calls.length = 0; servers.length = 0; children.clear(); nativePermissions.clear(); nativeMetadata.clear(); nativeStatuses.clear(); mcpStatus = "connected"; statusGate = undefined; statusReached = undefined; promptGate = undefined; promptReached = undefined; abortGate = undefined; abortReached = undefined; abortTarget = undefined; abortFailure = undefined; history = []; health = { healthy: true, version: "1.15.13" }; }
export function setHistory(value: typeof history) { history = value; }
export function setHealth(value: typeof health) { health = value; }
export function setChildren(parent: string, ids: string[]) { children.set(parent, ids); }
export function setNativePermission(id: string, rules: Array<{ permission: string; pattern: string; action: "allow" | "ask" | "deny" }>) { nativePermissions.set(id, rules); }
export function setNativeMetadata(id: string, metadata: Record<string, unknown>) { nativeMetadata.set(id, metadata); }
export function setNativeStatus(id: string, status: "idle" | "busy") { nativeStatuses.set(id, status); }
export function setMcpStatus(status: typeof mcpStatus) { mcpStatus = status; }
export function failAbort(sessionID: string) { abortFailure = sessionID; }
export function holdAbort(sessionID: string) {
  abortTarget = sessionID; abortGate = Promise.withResolvers<void>(); abortReached = Promise.withResolvers<void>();
  return { reached: abortReached.promise, release: () => abortGate?.resolve() };
}
export function holdStatus() {
  statusGate = Promise.withResolvers<void>(); statusReached = Promise.withResolvers<void>();
  return { reached: statusReached.promise, release: () => statusGate?.resolve() };
}
export function holdPrompt() {
  promptGate = Promise.withResolvers<void>(); promptReached = Promise.withResolvers<void>();
  return { reached: promptReached.promise, release: () => promptGate?.resolve() };
}
export function crashServer(index: number) { servers[index]?.exit?.(); }
export async function startFakeServer() {
  const state: { exit?: () => void } = {}; servers.push(state);
  return { url: "http://127.0.0.1:1", close() {}, onExit(callback: () => void) { state.exit = callback; } };
}
export function createOpencodeClient() {
  const queue: Array<{ event: unknown; acknowledged?: () => void }> = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  let active = false;
  const push = (type: string, properties: unknown, acknowledged?: () => void) => { queue.push({ event: { type, properties, id: `event-${++sequence}` }, ...(acknowledged ? { acknowledged } : {}) }); wake?.(); };
  sendEvent = (type, properties) => new Promise<void>((resolve) => push(type, properties, resolve));
  async function* stream() {
    while (!stopped) {
      if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
      while (queue.length) { const entry = queue.shift()!; yield entry.event; entry.acknowledged?.(); }
    }
  }
  const data = <T>(value: T) => ({ data: value });
  const emitFinish = (sessionID: string, messageID: string, customText?: string) => {
    const assistant = `assistant-${messageID}`; const partID = `part-${messageID}`;
    push("message.updated", { sessionID, info: { id: assistant, sessionID, role: "assistant", parentID: messageID, time: {} } });
    push("message.part.updated", { sessionID, part: { id: partID, sessionID, messageID: assistant, type: "text", text: customText ?? "Hello" } });
    if (customText === undefined) push("message.part.delta", { sessionID, messageID: assistant, partID, field: "text", delta: " world" });
    push("message.part.updated", { sessionID, part: { id: `tool-${messageID}`, sessionID, messageID: assistant, type: "tool", callID: `call-${messageID}`, tool: "bash", state: { status: "completed", input: { command: "pwd" }, output: "", title: "Working directory", time: { start: 1, end: 2 } } } });
    push("message.updated", { sessionID, info: { id: assistant, sessionID, role: "assistant", parentID: messageID, time: { completed: 2 } } });
    active = false; push("session.idle", { sessionID });
  };
  return {
    global: { async health() { calls.push({ method: "global.health", args: {} }); return data(health); } },
    event: { async subscribe(_p: unknown, options: { signal?: AbortSignal }) { options.signal?.addEventListener("abort", () => { stopped = true; wake?.(); }); return { stream: stream() }; } },
    session: {
      async create(args: unknown) { calls.push({ method: "create", args }); return data({ id: "session-fake" }); },
      async get(args: { sessionID: string }) { calls.push({ method: "get", args }); return data({ id: args.sessionID, permission: nativePermissions.get(args.sessionID) ?? [], metadata: nativeMetadata.get(args.sessionID) }); },
      async messages() { calls.push({ method: "messages", args: {} }); return data(history); },
      async children(args: { sessionID: string }) { calls.push({ method: "children", args }); return data((children.get(args.sessionID) ?? []).map((id) => ({ id, permission: nativePermissions.get(id) ?? [], metadata: nativeMetadata.get(id) }))); },
      async update(args: unknown) { calls.push({ method: "update", args }); return data({}); },
      async status() { statusReached?.resolve(); if (statusGate) await statusGate.promise; return data({ "session-fake": { type: active ? "busy" : "idle" }, ...Object.fromEntries([...nativeStatuses].map(([id, type]) => [id, { type }])) }); },
      async promptAsync(args: { sessionID: string; messageID: string; model?: { providerID: string; modelID: string }; parts: Array<{ type?: string; text?: string; url?: string }> }, options?: { signal?: AbortSignal; throwOnError?: boolean }) {
        calls.push({ method: "prompt", args }); promptReached?.resolve(); if (promptGate) await promptGate.promise;
        if (options?.signal?.aborted) throw new Error("fake prompt aborted");
        const { sessionID, messageID } = args; const text = args.parts[0]?.text ?? "";
        if (text.includes("reject-prompt")) return { error: { name: "BadRequestError" }, response: new Response(null, { status: 400 }) };
        if (text.includes("fail-prompt")) return { error: new TypeError("fake reset", { cause: { code: "ECONNRESET" } }), response: undefined };
        active = true;
        if (text.includes("inline-events")) { emitFinish(sessionID, messageID); return data(undefined); }
        setImmediate(() => {
          push("message.updated", { sessionID, info: { id: messageID, sessionID, role: "user", time: {} } });
          push("session.status", { sessionID, status: { type: "busy" } });
          if (text.includes("approve")) push("permission.asked", { id: "request-1", sessionID, permission: "bash", patterns: ["*"], metadata: {}, always: [] });
          else if (text.includes("question")) push("question.asked", { id: "question-1", sessionID, questions: [{ header: "Color", question: "Choose", options: [{ label: "Blue", description: "Color" }] }] });
          else if (!text.includes("hold")) emitFinish(sessionID, messageID, text.includes("echo-attachment") ? `${text}\nFILE:${args.parts.find((part) => part.type === "file")?.url ?? "none"}\nMODEL:${args.model?.providerID}/${args.model?.modelID}` : undefined);
        });
        return data(undefined);
      },
      async abort(args: { sessionID: string }) { calls.push({ method: "abort", args }); if (args.sessionID === abortTarget) { abortReached?.resolve(); if (abortGate) await abortGate.promise; } if (args.sessionID === abortFailure) throw new Error("fake abort failure"); active = false; setImmediate(() => push("session.idle", args)); return data(true); },
    },
    mcp: { async add(args: unknown) { calls.push({ method: "mcp.add", args }); return data(mcpStatus === "missing" ? {} : { goat: mcpStatus === "failed" ? { status: mcpStatus, error: "synthetic failure" } : { status: mcpStatus } }); } },
    permission: { async reply(args: { requestID: string }) { calls.push({ method: "permission.reply", args }); emitFinish("session-fake", "answer"); return data(true); } },
    question: { async reply(args: unknown) { calls.push({ method: "question.reply", args }); emitFinish("session-fake", "question-answer"); return data(true); }, async reject(args: unknown) { calls.push({ method: "question.reject", args }); return data(true); } },
    provider: { async list() { return data({ all: [{ id: "test", name: "Test", models: { model: { id: "model", name: "Test model" } } }], connected: ["test"], default: { test: "model" } }); } },
  };
}

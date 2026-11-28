// Offline SDK double. Scripts use the prompt text; no credentials or network.
export const calls: Array<{ method: string; args: unknown }> = [];
let sequence = 0;
export function reset() { calls.length = 0; }
export async function startFakeServer() { return { url: "http://127.0.0.1:1", close() {} }; }
export function createOpencodeClient() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  let active = false;
  const push = (type: string, properties: unknown) => { queue.push({ type, properties, id: `event-${++sequence}` }); wake?.(); };
  async function* stream() {
    while (!stopped) {
      if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
      while (queue.length) yield queue.shift();
    }
  }
  const data = <T>(value: T) => ({ data: value });
  const emitFinish = (sessionID: string, messageID: string) => {
    const assistant = `assistant-${messageID}`; const partID = `part-${messageID}`;
    push("message.updated", { sessionID, info: { id: assistant, sessionID, role: "assistant", parentID: messageID, time: {} } });
    push("message.part.updated", { sessionID, part: { id: partID, sessionID, messageID: assistant, type: "text", text: "Hello" } });
    push("message.part.delta", { sessionID, messageID: assistant, partID, field: "text", delta: " world" });
    push("message.part.updated", { sessionID, part: { id: `tool-${messageID}`, sessionID, messageID: assistant, type: "tool", callID: `call-${messageID}`, tool: "bash", state: { status: "completed", input: { command: "pwd" }, output: "", title: "Working directory", time: { start: 1, end: 2 } } } });
    push("message.updated", { sessionID, info: { id: assistant, sessionID, role: "assistant", parentID: messageID, time: { completed: 2 } } });
    active = false; push("session.idle", { sessionID });
  };
  return {
    event: { async subscribe(_p: unknown, options: { signal?: AbortSignal }) { options.signal?.addEventListener("abort", () => { stopped = true; wake?.(); }); return { stream: stream() }; } },
    session: {
      async create(args: unknown) { calls.push({ method: "create", args }); return data({ id: "session-fake" }); },
      async get(args: { sessionID: string }) { calls.push({ method: "get", args }); return data({ id: args.sessionID }); },
      async update(args: unknown) { calls.push({ method: "update", args }); return data({}); },
      async status() { return data({ "session-fake": { type: active ? "busy" : "idle" } }); },
      async promptAsync(args: { sessionID: string; messageID: string; parts: Array<{ text: string }> }) {
        calls.push({ method: "prompt", args }); const { sessionID, messageID } = args; const text = args.parts[0]?.text ?? "";
        if (text.includes("fail-prompt")) throw new Error("fake error");
        active = true;
        setImmediate(() => {
          push("message.updated", { sessionID, info: { id: messageID, sessionID, role: "user", time: {} } });
          push("session.status", { sessionID, status: { type: "busy" } });
          if (text.includes("approve")) push("permission.asked", { id: "request-1", sessionID, permission: "bash", patterns: ["*"], metadata: {}, always: [] });
          else if (text.includes("question")) push("question.asked", { id: "question-1", sessionID, questions: [{ header: "Color", question: "Choose", options: [{ label: "Blue", description: "Color" }] }] });
          else if (!text.includes("hold")) emitFinish(sessionID, messageID);
        });
        return data(undefined);
      },
      async abort(args: { sessionID: string }) { calls.push({ method: "abort", args }); active = false; setImmediate(() => push("session.idle", args)); return data(true); },
    },
    mcp: { async add(args: unknown) { calls.push({ method: "mcp.add", args }); return data({}); } },
    permission: { async reply(args: { requestID: string }) { calls.push({ method: "permission.reply", args }); emitFinish("session-fake", "answer"); return data(true); } },
    question: { async reply(args: unknown) { calls.push({ method: "question.reply", args }); emitFinish("session-fake", "question-answer"); return data(true); }, async reject(args: unknown) { calls.push({ method: "question.reject", args }); return data(true); } },
    provider: { async list() { return data({ all: [{ id: "test", name: "Test", models: { model: { id: "model", name: "Test model" } } }], connected: ["test"], default: { test: "model" } }); } },
  };
}

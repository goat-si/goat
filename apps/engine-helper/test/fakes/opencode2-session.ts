import type { OpenCode2Runtime } from "../../src/engines/opencode2/runtime.ts";
import type { V2Event } from "@opencode/client";

type Recorded = { method: string; input: unknown };
export function scriptedRuntime(version = "2.0.28") {
  const calls: Recorded[] = []; const queue: V2Event[] = []; let notify: (() => void) | undefined; let stopped = false; let streamLost = false; let sequence = 0;
  let history: unknown[] = []; let models: unknown[] = []; let active: Record<string, { type: "running" }> = {}; let reconnectFailures = 0; let nativeDirectory: string | undefined;
  let nativeRequests: unknown[] = []; const nativeForms = new Map<string, unknown[]>();
  let mcpFailure = false, activeFailure = false, cancelFailure = false, updateFailure = false;
  const failure = Promise.withResolvers<Error | undefined>();
  let promptGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let promptReached: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let activeGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let activeReached: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let updateGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let updateReached: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let interruptGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let interruptReached: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let replyGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let replyReached: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let promptError: Error | undefined;
  const add = (method: string, input: unknown) => calls.push({ method, input });
  const emit = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    queue.push({ id: `event-${++sequence}`, created: sequence, type, data, durable: { aggregateID: "session-v2", seq: sequence, version: type.startsWith("session.tool.") ? 2 : 1 }, ...extra } as unknown as V2Event); notify?.();
  };
  async function* events() { while (!stopped) { if (!queue.length && !streamLost) await new Promise<void>((resolve) => { notify = resolve; }); notify = undefined; if (streamLost) { streamLost = false; throw new Error("synthetic stream loss"); } while (queue.length) yield queue.shift()!; } }
  const client = {
    model: { async list() { add("model.list", {}); return { data: models, location: { directory: "/tmp" } }; } },
    permission: { request: { async list() { return { data: nativeRequests }; } }, async reply(input: unknown) { add("permission.reply", input); replyReached?.resolve(); if (replyGate) await replyGate.promise; } },
    mcp: { async add(input: unknown) { add("mcp.add", input); if (mcpFailure) throw new Error("synthetic mcp failure"); }, async remove(input: unknown) { add("mcp.remove", input); } },
    session: {
      async create(input: unknown) { add("session.create", input); return { id: "session-v2" }; },
      async get(input: unknown) { add("session.get", input); return { id: "session-v2", ...(nativeDirectory ? { location: { directory: nativeDirectory } } : {}) }; },
      async move(input: unknown) { add("session.move", input); },
      async active() { add("session.active", {}); activeReached?.resolve(); if (activeGate) await activeGate.promise; if (activeFailure) throw new Error("synthetic active failure"); return active; },
      async update(input: unknown) { add("session.update", input); updateReached?.resolve(); if (updateGate) await updateGate.promise; if (updateFailure) throw new Error("synthetic-secret-token"); },
      async switchModel(input: unknown) { add("session.switchModel", input); },
      async prompt(input: { id: string; text: string; delivery?: string }) { add("session.prompt", input); promptReached?.resolve(); if (promptGate) await promptGate.promise; if (promptError) throw promptError; return { id: input.id, sessionID: "session-v2", type: "user" }; },
      async interrupt(input: unknown) { add("session.interrupt", input); interruptReached?.resolve(); if (interruptGate) await interruptGate.promise; return { interrupted: true }; },
      inbox: { async list() { return []; }, async cancel(input: unknown) { add("session.inbox.cancel", input); if (cancelFailure) throw new Error("synthetic cancellation failure"); } },
      form: { async list(input: { sessionID: string }) { return nativeForms.get(input.sessionID) ?? []; }, async cancel(input: unknown) { add("session.form.cancel", input); }, async reply(input: unknown) { add("session.form.reply", input); } },
      instructions: { entry: { async put(input: unknown) { add("session.instructions.entry.put", input); } } },
    },
    message: { async list(input: unknown) { add("message.list", input); return { data: history, cursor: {} }; } },
  };
  const runtime = { client, version, events: { [Symbol.asyncIterator]: events }, failure: failure.promise, async reconnect() { add("reconnect", {}); if (reconnectFailures-- > 0) throw new Error("synthetic reconnect failure"); return { [Symbol.asyncIterator]: events }; }, async close() { add("close", {}); stopped = true; failure.resolve(undefined); notify?.(); } } as unknown as OpenCode2Runtime;
  return { runtime, calls, emit, breakStream() { streamLost = true; notify?.(); }, crash() { failure.resolve(new Error("synthetic crash")); }, setHistory(value: unknown[]) { history = value; }, setRequests(value: unknown[]) { nativeRequests = value; }, setForms(id: string, value: unknown[]) { nativeForms.set(id, value); }, setModels(value: unknown[]) { models = value; }, setActive(value: typeof active) { active = value; }, setNativeDirectory(value: string) { nativeDirectory = value; }, failReconnect(count: number) { reconnectFailures = count; }, failMcp(value: boolean) { mcpFailure = value; }, failActive(value: boolean) { activeFailure = value; }, failCancel(value: boolean) { cancelFailure = value; }, failUpdate(value: boolean) { updateFailure = value; }, failPrompt(error: Error | undefined) { promptError = error; }, holdReply() { const gate = Promise.withResolvers<void>(); const reached = Promise.withResolvers<void>(); replyGate = gate; replyReached = reached; return { reached: reached.promise, release: () => { gate.resolve(); replyGate = undefined; } }; }, holdActive() { const gate = Promise.withResolvers<void>(); const reached = Promise.withResolvers<void>(); activeGate = gate; activeReached = reached; return { reached: reached.promise, release: () => { gate.resolve(); activeGate = undefined; } }; }, holdUpdate() { const gate = Promise.withResolvers<void>(); const reached = Promise.withResolvers<void>(); updateGate = gate; updateReached = reached; return { reached: reached.promise, release: () => { gate.resolve(); updateGate = undefined; } }; }, holdPrompt() { const gate = Promise.withResolvers<void>(); const reached = Promise.withResolvers<void>(); promptGate = gate; promptReached = reached; return { reached: reached.promise, release: () => { gate.resolve(); promptGate = undefined; } }; }, holdInterrupt() { const gate = Promise.withResolvers<void>(); const reached = Promise.withResolvers<void>(); interruptGate = gate; interruptReached = reached; return { reached: reached.promise, release: () => { gate.resolve(); interruptGate = undefined; } }; } };
}

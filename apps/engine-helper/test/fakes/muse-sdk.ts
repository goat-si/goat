// A deterministic in-process MSP fixture; no CLI, credentials, or network.
export const calls: Array<{ method: string; params: any; options?: any }> = [];
export const launches: any[] = [];
export let closes = 0;
export let sendNotification: (method: string, params: any) => void = () => {};
export function reset() { calls.length = 0; launches.length = 0; closes = 0; }
export function spawnMspConnection(options: any) {
  launches.push(options);
  calls.push(options);
  let sequence = 0;
  let notification: (event: any) => void = () => {};
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const exited = new Promise<never>(() => {});
  let active: { sessionId: string; turnId: string; input: string } | undefined;
  const emit = (method: string, params: any) => notification({ method, params });
  sendNotification = emit;
  const complete = () => {
    if (!active) return;
    const { sessionId, turnId } = active;
    emit("item/started", { sessionId, turnId, item: { itemId: "message", turnId, kind: "agentMessage", revision: 1, status: "inProgress" } });
    emit("item/delta", { sessionId, turnId, itemId: "message", delta: "hello" });
    emit("item/completed", { sessionId, turnId, item: { itemId: "message", turnId, kind: "agentMessage", revision: 2, status: "completed", text: "hello" } });
    emit("item/completed", { sessionId, turnId, item: { itemId: "tool", turnId, kind: "toolCall", tool: "goat_call", args: '{"path":"thread.read"}', revision: 1, status: "completed", result: { summary: "Read thread" } } });
    emit("turn/completed", { sessionId, turnId, terminal: "completed" });
    active = undefined;
  };
  const connection = {
    closed,
    mintCommandId: () => `native-${++sequence}`,
    onNotification: (handler: typeof notification) => { notification = handler; },
    onProtocolError: (_handler: unknown) => {},
    onServerRequest: (_handler: unknown) => {},
    async request(method: string, params: any) {
      calls.push({ method, params });
      if (method === "model/list") return { providerId: "meta", models: [{ providerId: "meta", modelId: "muse-example", displayLabel: "Muse Example", isDefault: true, variants: ["low", "high"], defaultReasoningEffort: "high" }] };
      throw new Error("unexpected request");
    },
    async command(method: string, params: any, opts: any) {
      calls.push({ method, params, options: opts });
      if (method === "session/start" || method === "session/resume") return { session: { sessionId: params.sessionId, modelId: params.modelId } };
      if (method === "session/setApprovalMode" || method === "session/setModel") return {};
      if (method === "turn/start") {
        if (params.displayText === "start-fail") throw Object.assign(new Error("untrusted failure text"), { kind: "commandRejected" });
        if (params.displayText === "start-unknown") throw new Error("untrusted transport detail");
        const turnId = opts.commandId;
        active = { sessionId: params.sessionId, turnId, input: params.displayText };
        if (params.displayText === "hold") return { turnId };
        if (params.displayText === "approval") setImmediate(() => emit("approval/requested", { sessionId: params.sessionId, turnId, approvalId: "a1", currentRequirementId: { approvalId: "a1", sourceIndex: 0 }, subject: { kind: "shell", command: "list files" }, availableChoices: [{ choiceId: "yes", label: "Allow", decision: "approved", scope: "once" }, { choiceId: "no", label: "Deny", decision: "denied", scope: "once" }] }));
        else if (params.displayText === "question") setImmediate(() => emit("userInput/requested", { sessionId: params.sessionId, turnId, userInputId: "q1", questions: [{ id: "q", header: "Choice", question: "Choose", options: [{ label: "blue" }], selection: { mode: "single" } }] }));
        else if (params.displayText === "turn-fail") setImmediate(() => emit("turn/completed", { sessionId: params.sessionId, turnId, terminal: "failed", error: { message: "auth required" } }));
        else complete(); // deliberately before the command response
        return { turnId };
      }
      if (method === "turn/steer") return { turnId: params.expectedTurnId };
      if (method === "turn/interrupt") { emit("turn/completed", { sessionId: params.sessionId, turnId: params.turnId, terminal: "cancelled" }); active = undefined; return {}; }
      if (method === "approval/decide") { emit("approval/resolved", { sessionId: params.sessionId, turnId: active?.turnId, approvalId: params.approvalId }); setImmediate(complete); return {}; }
      if (method === "userInput/answer") { emit("userInput/settled", { sessionId: params.sessionId, turnId: active?.turnId, userInputId: params.userInputId }); setImmediate(complete); return {}; }
      throw new Error("unexpected command");
    },
  };
  return {
    async initialize(params: any) {
      calls.push(params);
      if (process.env.GOAT2_MUSE_FAKE_FAIL === "1") throw new Error("fixture failure");
      return { initializeResult: { schema: { version: 1 }, grantedCapabilities: ["sessionMcp"] }, connection, exited };
    },
    async close() { closes++; resolveClosed(); },
  };
}

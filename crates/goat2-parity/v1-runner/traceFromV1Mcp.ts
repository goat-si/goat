// Semantic trace for multi-thread / MCP parity scenarios from v1 stored events (global sequence
// order, orchestration_v2_events.sequence AUTOINCREMENT, 055_OrchestrationV2.ts:20-31), replay
// observations and MCP tool results. Tool results are placed after every stored event with a
// sequence at or below the watermark read when the call returned (a weaker contract than commit
// order: events committed between the call's completion and that read may precede it).
const MODE: Record<string, string> = { turn_start: "start", queued_turn: "queue", steer: "steer", promoted_queued_to_steer: "queue" };
const TERMINAL_TASK = new Set(["completed", "failed", "cancelled", "interrupted"]);

export function traceFromV1Mcp(input: {
  scenario: any; stored: readonly any[]; augmented: any; state: any;
  threadAliases: ReadonlyMap<string, string>; messageInputs: ReadonlyMap<string, string>;
  callMessages: ReadonlyMap<string, string>; callRuns: ReadonlyMap<string, string>;
  toolResults: ReadonlyArray<{ watermark: number; event: any }>;
  replayObserved: ReadonlyArray<{ readonly cursor: number; readonly label: string | undefined; readonly frame: any }>;
  failure?: string;
}) {
  const { scenario, augmented, state, threadAliases } = input;
  const sorted = [...input.stored].sort((a, b) => a.sequence - b.sequence);
  const semantic: Array<{ sequence: number; event: any }> = [];
  let incomplete: string | undefined;
  const alias = (threadId: string) => {
    const a = threadAliases.get(threadId);
    if (a === undefined) throw new Error("event on undeclared thread " + threadId);
    return a;
  };
  // Pre-scan: message aliases (scenario sends, thread.send results, task.create child runs) and
  // the input intent recorded on each user turn item.
  const messageAlias = new Map<string, string>([...input.messageInputs, ...input.callMessages]);
  const intent = new Map<string, string>();
  for (const { event } of sorted) {
    const p = event.payload;
    if ((event.type === "run.created" || event.type === "run.updated") && input.callRuns.has(p.id) && p.userMessageId) messageAlias.set(p.userMessageId, input.callRuns.get(p.id)!);
    if (event.type === "turn-item.updated" && p.type === "user_message" && p.messageId && p.inputIntent) intent.set(p.messageId, p.inputIntent);
  }
  const accepted = new Set<string>();
  const runAliases = new Map<string, string>();
  const runCount = new Map<string, number>();
  const statuses = new Map<string, string>();
  const attemptRuns = new Map<string, string>();
  const turnRuns = new Map<string, string>();
  const runThread = new Map<string, string>();
  const messageText = new Map<string, { thread: string; input: string; text: string }>();
  const childSeen = new Set<string>();
  const taskStatus = new Map<string, string>();
  // A steer response is an inbound response (id, no method) answering the latest matched outbound
  // turn/steer request with that id; recordings label frames freely, so labels are not evidence.
  const requestFor = (o: { cursor: number; frame: any }) => [...augmented.entries.slice(0, o.cursor)].reverse().find((e: any) => e.type === "expect_outbound" && e.frame?.id === o.frame.id);
  const steers = input.replayObserved.filter((o) => o.frame?.id !== undefined && o.frame?.method === undefined && requestFor(o)?.frame?.method === "turn/steer").map((o) => {
    const request = requestFor(o)!;
    const text = (request.frame.params?.input ?? []).filter((i: any) => i.type === "text").map((i: any) => i.text).join("");
    const completed = input.replayObserved.find((c) => c.frame?.method === "turn/completed" && c.frame?.params?.turn?.id === request.frame.params?.expectedTurnId);
    return { ok: o.frame.result !== undefined && o.frame.error === undefined, text, turnId: request.frame.params?.expectedTurnId, before: completed === undefined || o.cursor < completed.cursor, done: false };
  });
  const pendingSteer: Array<{ runId: string; thread: string; input: string; before: boolean; sequence: number }> = [];
  const resolveSteers = (sequence: number) => {
    for (const s of steers) {
      if (s.done || !s.ok) continue;
      const runId = turnRuns.get(s.turnId);
      if (runId === undefined) continue;
      const thread = alias(runThread.get(runId)!);
      // Agent-sent steers reach Codex with a sender note before the text (messageSenderNote.ts:16-18).
      const candidates = [...messageText.values()].filter((m) => m.thread === thread && s.text.endsWith(m.text));
      if (candidates.length === 0) continue;
      if (candidates.length > 1) throw new Error("steer text matches several inputs");
      s.done = true;
      pendingSteer.push({ runId, thread, input: candidates[0]!.input, before: s.before, sequence });
    }
  };
  const flush = (runId: string, before: boolean, sequence: number) => {
    for (const s of pendingSteer.filter((x) => x.runId === runId && x.before === before)) {
      semantic.push({ sequence, event: { kind: "steer.applied", thread: s.thread, run: runAliases.get(runId), input: s.input } });
      pendingSteer.splice(pendingSteer.indexOf(s), 1);
    }
  };
  const finish = (sequence: number, p: any, status: string, extra: object = {}) => {
    const run = runAliases.get(p.id);
    if (!run) throw new Error("unmapped run " + p.id);
    flush(p.id, true, sequence);
    semantic.push({ sequence, event: { kind: "run.finished", thread: alias(p.threadId ?? runThread.get(p.id)), run, status, ...extra } });
    flush(p.id, false, sequence);
  };
  for (const { event, sequence } of sorted) {
    const p = event.payload;
    if (event.type === "message.updated" && p.role === "user" && !accepted.has(p.id)) {
      accepted.add(p.id);
      const thread = alias(event.threadId);
      if (p.delegatedCompletion !== undefined || p.notification !== undefined) { incomplete = "delegated completion / notification input mapping is not implemented (message " + p.id + ")"; continue; }
      const inputAlias = messageAlias.get(p.id);
      if (inputAlias === undefined) throw new Error("unmapped user message " + p.id);
      const mode = MODE[intent.get(p.id) ?? ""];
      if (mode === undefined) throw new Error("no input intent for message " + p.id);
      const from = p.createdBy === "user" ? "user" : p.createdBy === "agent" ? "agent" : "system";
      messageText.set(p.id, { thread, input: inputAlias, text: p.text });
      semantic.push({ sequence, event: { kind: "input.accepted", thread, input: inputAlias, from, mode, text: p.text } });
    }
    if (event.type === "run-attempt.created" || event.type === "run-attempt.updated") attemptRuns.set(p.id, p.runId);
    if (event.type === "provider-turn.updated" && p.nativeTurnRef?.nativeId && p.runAttemptId) {
      const runId = attemptRuns.get(p.runAttemptId);
      if (runId === undefined) throw new Error("provider turn for unknown run attempt " + p.runAttemptId);
      turnRuns.set(p.nativeTurnRef.nativeId, runId);
    }
    resolveSteers(sequence);
    if (event.type === "run.created" || event.type === "run.updated") {
      runThread.set(p.id, event.threadId);
      const thread = alias(event.threadId);
      const old = statuses.get(p.id);
      statuses.set(p.id, p.status);
      const inputAlias = p.userMessageId ? messageAlias.get(p.userMessageId) : undefined;
      if (p.status === "queued" && old !== "queued") {
        if (!inputAlias) throw new Error("unmapped queued run input " + p.userMessageId);
        semantic.push({ sequence, event: { kind: "queue.changed", thread, input: inputAlias, op: "enqueued" } });
      }
      if (p.status === "cancelled" && old === "queued") {
        if (!inputAlias) throw new Error("unmapped cancelled run input " + p.userMessageId);
        semantic.push({ sequence, event: { kind: "queue.changed", thread, input: inputAlias, op: p.terminationCause?.kind === "queued_replaced" ? "promoted" : "cancelled" } });
      }
      if (p.status === "running" && !runAliases.has(p.id)) {
        if (!inputAlias) throw new Error("unmapped run input " + p.userMessageId);
        const n = (runCount.get(thread) ?? 0) + 1;
        runCount.set(thread, n);
        runAliases.set(p.id, "r" + n);
        semantic.push({ sequence, event: { kind: "run.started", thread, run: "r" + n, inputs: [inputAlias] } });
      }
      if (runAliases.has(p.id) && p.status !== old) {
        if (p.status === "completed") finish(sequence, { ...p, threadId: event.threadId }, "done");
        else if (p.status === "interrupted") finish(sequence, { ...p, threadId: event.threadId }, "interrupted");
        else if (p.status === "failed") finish(sequence, { ...p, threadId: event.threadId }, "failed");
        else if (p.status === "cancelled" && old !== "queued") finish(sequence, { ...p, threadId: event.threadId }, "cancelled", p.terminationCause?.kind ? { cause: p.terminationCause.kind } : {});
      }
    }
    if (event.type === "subagent.updated" && p.childThreadId) {
      const parent = alias(event.threadId);
      const child = alias(p.childThreadId);
      if (!childSeen.has(p.childThreadId)) {
        childSeen.add(p.childThreadId);
        semantic.push({ sequence, event: { kind: "child.started", thread: parent, child } });
      }
      const old = taskStatus.get(p.id);
      taskStatus.set(p.id, p.status);
      if (TERMINAL_TASK.has(p.status) && !TERMINAL_TASK.has(old ?? "")) semantic.push({ sequence, event: { kind: "child.reported", thread: parent, child, status: p.status } });
    }
  }
  for (const s of [...pendingSteer]) semantic.push({ sequence: Infinity, event: { kind: "steer.applied", thread: s.thread, run: runAliases.get(s.runId), input: s.input } });
  if (steers.some((s) => s.ok && !s.done)) throw new Error("successful turn/steer response could not be correlated to an input and run");
  // Merge tool results after the stored events at or below their watermark, in call order.
  const merged: any[] = [];
  const tools = [...input.toolResults];
  for (const item of semantic) {
    while (tools.length > 0 && tools[0]!.watermark < item.sequence) merged.push(tools.shift()!.event);
    merged.push(item.event);
  }
  for (const t of tools) merged.push(t.event);
  const events = merged.map((event, i) => ({ seq: i + 1, ...event }));
  const reason = state.failure ? String(state.failure) : input.failure;
  const outboundChecked = augmented.entries.slice(0, state.cursor).filter((e: any) => e.type === "expect_outbound" && e.parityOriginal === true).length;
  const streamName = Object.keys(scenario.streams)[0];
  return {
    v: 1, target: "v1", scenario: scenario.name,
    outcome: reason ? { outcome: "error", reason } : incomplete ? { outcome: "incomplete", reason: incomplete } : { outcome: "ok" },
    events,
    streams: { [streamName!]: { consumedAll: state.cursor === augmented.entries.length, outboundChecked, outboundMismatches: reason ? [reason] : [] } },
    incomplete: incomplete !== undefined,
  };
}

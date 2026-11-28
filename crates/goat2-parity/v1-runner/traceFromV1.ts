export function traceFromV1(scenario: any, stored: readonly any[], augmented: any, state: any, threadId: string, messageInputs: ReadonlyMap<string, string>, failure?: string) {
  const events: any[] = [];
  const sendByInput = new Map(scenario.steps.filter((step: any) => step.do === "send").map((step: any) => [step.input, step]));
  const thread = scenario.steps.find((step: any) => step.thread)?.thread;
  const messageAliases = new Map<string, string>();
  const runAliases = new Map<string, string>();
  const statuses = new Map<string, string>();
  const pendingQueuedMessages = new Set<string>();
  const queuedRunMessages = new Map<string, string>();
  const emit = (event: any) => events.push({seq: events.length + 1, ...event});
  for (const {event} of [...stored].sort((a, b) => a.sequence - b.sequence)) {
    const p = event.payload;
    if (event.threadId !== threadId) continue;
    if (event.type === "message.updated" && p.role === "user" && !messageAliases.has(p.id)) {
      // Bind by the dispatched message id, never by observation order.
      const input = messageInputs.get(p.id);
      const step = input === undefined ? undefined : sendByInput.get(input);
      if (!step) throw new Error(`unmapped message ${p.id}`);
      messageAliases.set(p.id, step.input);
      emit({kind: "input.accepted", thread: step.thread, input: step.input, from: "user", mode: step.mode, text: p.text});
      if (pendingQueuedMessages.delete(p.id)) emit({kind: "queue.changed", thread: step.thread, input: step.input, op: "enqueued"});
    }
    else if (event.type === "message.updated" && p.role === "user" && queuedRunMessages.has(p.id) && statuses.get(queuedRunMessages.get(p.id)!) === "queued") {
      const input = messageAliases.get(p.id);
      if (!input) throw new Error(`unmapped edited message ${p.id}`);
      emit({kind: "queue.changed", thread: thread, input, op: "edited", text: p.text});
    }
    if (event.type === "run.created" || event.type === "run.updated") {
      const old = statuses.get(p.id);
      statuses.set(p.id, p.status);
      if (p.status === "queued" && old !== "queued") {
        queuedRunMessages.set(p.userMessageId, p.id);
        const input = messageAliases.get(p.userMessageId);
        if (input) emit({kind: "queue.changed", thread: thread, input, op: "enqueued"});
        else pendingQueuedMessages.add(p.userMessageId);
      }
      if (p.status === "cancelled" && old === "queued") {
        const input = messageAliases.get(p.userMessageId);
        if (!input) throw new Error(`unmapped cancelled message ${p.userMessageId}`);
        emit({kind: "queue.changed", thread: thread, input, op: "cancelled"});
      }
      if (p.status === "running" && !runAliases.has(p.id)) {
        const input = messageAliases.get(p.userMessageId);
        if (!input) throw new Error(`unmapped run input ${p.userMessageId}`);
        const run = `r${runAliases.size + 1}`;
        runAliases.set(p.id, run);
        emit({kind: "run.started", thread: thread, run, inputs: [input]});
      }
      if (p.status === "completed" && old !== "completed") {
        const run = runAliases.get(p.id);
        if (!run) throw new Error(`unmapped run ${p.id}`);
        emit({kind: "run.finished", thread: thread, run, status: "done"});
      }
      if (p.status === "interrupted" && old !== "interrupted") {
        const run = runAliases.get(p.id);
        if (!run) throw new Error(`unmapped interrupted run ${p.id}`);
        emit({kind: "run.finished", thread: thread, run, status: "interrupted"});
      }
    }
  }
  const reason = state.failure ? String(state.failure) : failure;
  const outboundChecked = augmented.entries.slice(0, state.cursor).filter((entry: any) => entry.type === "expect_outbound" && entry.parityOriginal === true).length;
  return {v: 1, target: "v1", scenario: scenario.name, outcome: reason ? {outcome: "error", reason} : {outcome: "ok"}, events, streams: {codex: {consumedAll: state.cursor === augmented.entries.length, outboundChecked, outboundMismatches: reason ? [reason] : []}}, incomplete: false};
}

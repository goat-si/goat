export function traceFromV1(scenario: any, stored: readonly any[], augmented: any, state: any, threadId: string, messageInputs: ReadonlyMap<string, string>, replayObserved: ReadonlyArray<{readonly cursor: number; readonly label: string | undefined; readonly frame: any}>, restartBoundary: number | undefined, failure?: string) {
  const events: any[] = [];
  const sendByInput = new Map(scenario.steps.filter((step: any) => step.do === "send").map((step: any) => [step.input, step]));
  const thread = scenario.steps.find((step: any) => step.thread)?.thread;
  const messageAliases = new Map<string, string>();
  const runAliases = new Map<string, string>();
  const statuses = new Map<string, string>();
  const pendingQueuedMessages = new Set<string>();
  const queuedRunMessages = new Map<string, string>();
  const emit = (event: any) => events.push({seq: events.length + 1, ...event});
  // turn/steer responses delivered by the replay driver, each paired with the outbound request it
  // answers (the driver only advances past an outbound frame the adapter actually sent).
  const steerResponses = replayObserved.filter((o) => o.label === "turn/steer" && o.frame?.id !== undefined).map((o) => {
    const request = [...augmented.entries.slice(0, o.cursor)].reverse().find((e: any) => e.type === "expect_outbound" && e.frame?.method === "turn/steer" && e.frame?.id === o.frame.id);
    if (!request) throw new Error(`turn/steer response ${o.frame.id} without a matched request`);
    const text = (request.frame.params?.input ?? []).filter((i: any) => i.type === "text").map((i: any) => i.text).join("");
    const completed = replayObserved.find((c) => c.label === "turn/completed" && c.frame?.params?.turn?.id === request.frame.params?.expectedTurnId);
    return {ok: o.frame.result !== undefined && o.frame.error === undefined, text, turnId: request.frame.params?.expectedTurnId, beforeCompletion: completed === undefined || o.cursor < completed.cursor};
  });
  const turnRuns = new Map<string, string>();
  const attemptRuns = new Map<string, string>();
  const messageTexts = new Map<string, string[]>();
  const pendingSteers: Array<{runId: string; input: string; beforeCompletion: boolean}> = [];
  const steerResolved = new Set<number>();
  const resolveSteers = () => steerResponses.forEach((r, index) => {
    if (steerResolved.has(index) || !r.ok) return;
    const runId = turnRuns.get(r.turnId);
    const inputs = messageTexts.get(r.text) ?? [];
    if (runId === undefined || inputs.length === 0) return;
    if (inputs.length > 1) throw new Error(`steer text maps to several inputs: ${inputs}`);
    steerResolved.add(index);
    pendingSteers.push({runId, input: inputs[0], beforeCompletion: r.beforeCompletion});
  });
  const flushSteers = (runId: string, beforeFinish: boolean) => {
    for (const steer of pendingSteers.filter((x) => x.runId === runId && x.beforeCompletion === beforeFinish)) {
      const run = runAliases.get(runId);
      if (!run) throw new Error(`steer for unmapped run ${runId}`);
      emit({kind: "steer.applied", thread, run, input: steer.input});
      pendingSteers.splice(pendingSteers.indexOf(steer), 1);
    }
  };
  // host.restarted is a runner lifecycle marker: emitted once the second runtime was built, before
  // the first stored event that runtime wrote (sequences above the first runtime's last event).
  let restartEmitted = restartBoundary === undefined;
  for (const {event, sequence} of [...stored].sort((a, b) => a.sequence - b.sequence)) {
    if (!restartEmitted && sequence > restartBoundary!) { emit({kind: "host.restarted", thread}); restartEmitted = true; }
    const p = event.payload;
    if (event.threadId !== threadId) continue;
    if (event.type === "message.updated" && p.role === "user" && !messageAliases.has(p.id)) {
      // Bind by the dispatched message id, never by observation order.
      const input = messageInputs.get(p.id);
      const step = input === undefined ? undefined : sendByInput.get(input);
      if (!step) throw new Error(`unmapped message ${p.id}`);
      messageAliases.set(p.id, step.input);
      messageTexts.set(p.text, [...(messageTexts.get(p.text) ?? []), step.input]);
      emit({kind: "input.accepted", thread: step.thread, input: step.input, from: "user", mode: step.mode, text: p.text});
      if (pendingQueuedMessages.delete(p.id)) emit({kind: "queue.changed", thread: step.thread, input: step.input, op: "enqueued"});
    }
    else if (event.type === "message.updated" && p.role === "user" && queuedRunMessages.has(p.id) && statuses.get(queuedRunMessages.get(p.id)!) === "queued") {
      const input = messageAliases.get(p.id);
      if (!input) throw new Error(`unmapped edited message ${p.id}`);
      emit({kind: "queue.changed", thread: thread, input, op: "edited", text: p.text});
    }
    // Native Codex turn id -> provider turn -> run attempt -> run (contracts orchestrationV2.ts:675-700, 1049-1056).
    if (event.type === "run-attempt.created" || event.type === "run-attempt.updated") attemptRuns.set(p.id, p.runId);
    if (event.type === "provider-turn.updated" && p.nativeTurnRef?.nativeId && p.runAttemptId) {
      const runId = attemptRuns.get(p.runAttemptId);
      if (runId === undefined) throw new Error("provider turn for unknown run attempt " + p.runAttemptId);
      turnRuns.set(p.nativeTurnRef.nativeId, runId);
    }
    resolveSteers();
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
        // v1 promotion cancels the source run with terminationCause {kind: "queued_replaced"} (Orchestrator.ts:8659).
        emit({kind: "queue.changed", thread: thread, input, op: p.terminationCause?.kind === "queued_replaced" ? "promoted" : "cancelled"});
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
        flushSteers(p.id, true);
        emit({kind: "run.finished", thread: thread, run, status: "done"});
        flushSteers(p.id, false);
      }
      if (p.status === "interrupted" && old !== "interrupted") {
        const run = runAliases.get(p.id);
        if (!run) throw new Error(`unmapped interrupted run ${p.id}`);
        flushSteers(p.id, true);
        emit({kind: "run.finished", thread: thread, run, status: "interrupted"});
        flushSteers(p.id, false);
      }
    }
  }
  resolveSteers();
  for (const steer of [...pendingSteers]) {
    const run = runAliases.get(steer.runId);
    if (!run) throw new Error(`steer for unmapped run ${steer.runId}`);
    emit({kind: "steer.applied", thread, run, input: steer.input});
  }
  if (steerResponses.some((r, i) => r.ok && !steerResolved.has(i))) throw new Error("successful turn/steer response could not be correlated to an input and run");
  const reason = state.failure ? String(state.failure) : failure;
  const outboundChecked = augmented.entries.slice(0, state.cursor).filter((entry: any) => entry.type === "expect_outbound" && entry.parityOriginal === true).length;
  return {v: 1, target: "v1", scenario: scenario.name, outcome: reason ? {outcome: "error", reason} : {outcome: "ok"}, events, streams: {codex: {consumedAll: state.cursor === augmented.entries.length, outboundChecked, outboundMismatches: reason ? [reason] : []}}, incomplete: false};
}

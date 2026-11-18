// Raw notifications the mock ACP agent writes outside the effect-acp client.
export function writeJsonRpcNotification(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

export function emitGrokKillTaskScenario(
  sessionId: string,
  promptId: string | undefined,
  shape: string,
): void {
  const taskId = "call-fb9d0000-0000-0000-0000-000000000026-29";
  const outcome =
    shape === "already_exited" || shape === "known_failure" ? "already_exited" : "killed";
  writeJsonRpcNotification("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "kill-target-command",
      title: "run_terminal_command",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "sleep 40" },
    },
  });
  writeJsonRpcNotification("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "kill-target-command",
      status: "completed",
      rawOutput: {
        type: "BackgroundTaskStarted",
        task_id: taskId,
        task_type: "bash",
        command: "sleep 40",
      },
    },
  });
  if (shape === "known_failure") {
    writeJsonRpcNotification("_x.ai/task_completed", {
      sessionId,
      update: {
        sessionUpdate: "task_completed",
        task_snapshot: { task_id: taskId, kind: "bash", exit_code: 7, output: "known failure\n" },
      },
    });
  }
  writeJsonRpcNotification("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "kill-command",
      title: `kill ${taskId} (${outcome})`,
      kind: "other",
      status: "completed",
      rawInput: {
        task_id: taskId,
        ...(shape === "output_only" ? {} : { variant: "KillTask" }),
      },
      ...(shape === "variant_only" ? {} : { rawOutput: { type: "KillTask", outcome } }),
    },
  });
  writeJsonRpcNotification("_x.ai/session/prompt_complete", {
    sessionId,
    promptId,
    stopReason: "end_turn",
    agentResult: null,
  });
}

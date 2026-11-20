export function makeLoadReplayEmitter(
  writeJsonRpcNotification: (method: string, params: unknown) => void,
) {
  return (requestedSessionId: string) => {
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "replay-tool-1",
        title: "Replay tool",
        kind: "search",
        status: "completed",
      },
    });
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "mock-agent-message",
        content: { type: "text", text: "replayed assistant text" },
      },
    });
  };
}

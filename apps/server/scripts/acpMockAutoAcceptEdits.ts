import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AcpAgent } from "effect-acp/agent";
import { writeJsonRpcNotification } from "./acpMockGrokScenarios.ts";

export const emitEditUpdates = Effect.fn("emitEditUpdates")(function* (
  agent: AcpAgent["Service"],
  requestedSessionId: string,
  editUpdatesThenRequest: ReadonlyArray<unknown>,
  permissionOptionIds: { readonly allowOnce: string; readonly rejectOnce: string },
) {
  for (const update of editUpdatesThenRequest) {
    writeJsonRpcNotification("session/update", { sessionId: requestedSessionId, update });
  }
  const permission = yield* agent.client.requestPermission({
    sessionId: requestedSessionId,
    title: "Edit file",
    subject: {
      type: "tool_call",
      toolCall: { toolCallId: "edit-tracked", title: "Edit file", kind: "edit" },
    },
    options: [
      { optionId: permissionOptionIds.allowOnce, name: "Allow once", kind: "allow_once" },
      { optionId: permissionOptionIds.rejectOnce, name: "Reject", kind: "reject_once" },
    ],
  });
  // The answer is reported as a tool call so a test can read it from the turn's items.
  yield* agent.client.sessionUpdate({
    sessionId: requestedSessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: `edit-answered:${
        permission.outcome.outcome === "selected"
          ? permission.outcome.optionId
          : permission.outcome.outcome
      }`,
      title: "Edit answered",
      kind: "other",
      status: "completed",
    },
  });
});

export const editUpdatesThenRequest =
  process.env.GOAT_ACP_EMIT_EDIT_UPDATES_THEN_REQUEST === undefined
    ? undefined
    : Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(
        process.env.GOAT_ACP_EMIT_EDIT_UPDATES_THEN_REQUEST,
      );
export const permissionOptionIds = {
  allowOnce: process.env.GOAT_ACP_ALLOW_ONCE_OPTION_ID ?? "allow-once",
  allowAlways: process.env.GOAT_ACP_ALLOW_ALWAYS_OPTION_ID ?? "allow-always",
  rejectOnce: process.env.GOAT_ACP_REJECT_ONCE_OPTION_ID ?? "reject-once",
};

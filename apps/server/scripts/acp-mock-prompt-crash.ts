import * as Effect from "effect/Effect";
import type * as AcpSchema from "effect-acp/schema";
import type { AcpAgent } from "effect-acp/agent";

export const crashOnPrompt = Effect.fnUntraced(function* (
  request: AcpSchema.PromptRequest,
  agent: AcpAgent["Service"],
) {
  const mode = process.env.GOAT_ACP_CRASH_PROMPT;
  const after = mode === "after";
  if (
    !after &&
    mode !== "before" &&
    !(
      mode === "1" &&
      request.prompt.some((part) => part.type === "text" && part.text === "crash now")
    )
  )
    return;
  if (after)
    for (const text of ["first", "second"]) {
      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    }
  // Await a round trip so the client has consumed both notifications before the pipe closes.
  if (after) yield* agent.raw.request("fixture/flush", {}).pipe(Effect.ignore);
  process.exit(23);
});

import {
  BROWSER_CLAIM_ANSWER_HANDOFF_PATH,
  HandoffError,
  isHandoffPending,
  type Handoff,
  type HandoffRespondInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import type { BrowserClaimResponder } from "./BrowserClaimResponder.ts";
import type { PrivatePayload } from "./handoffPrivatePayload.ts";

export const answerBrowserClaim = Effect.fn("Handoffs.answerBrowserClaim")(function* (
  record: Handoff,
  input: HandoffRespondInput,
  responder: Option.Option<BrowserClaimResponder["Service"]>,
  load: () => Effect.Effect<PrivatePayload | null, HandoffError>,
) {
  if (
    record.target.path !== BROWSER_CLAIM_ANSWER_HANDOFF_PATH ||
    !isHandoffPending(record.state) ||
    input.action === "opened"
  )
    return;
  const decisionAt = yield* DateTime.now;
  if (
    record.expiresAt !== null &&
    DateTime.toEpochMillis(record.expiresAt) <= DateTime.toEpochMillis(decisionAt)
  )
    return yield* new HandoffError({ reason: "expired" });
  if (Option.isNone(responder))
    return yield* new HandoffError({
      reason: "unavailable",
      detail: "Browser claims are unavailable.",
    });
  const payload = yield* load();
  if (!payload || payload.kind !== "continuation" || typeof payload.args.claimId !== "string")
    return yield* new HandoffError({
      reason: "unavailable",
      detail: "Browser claim binding is unavailable.",
    });
  const answer = yield* responder.value.answer(payload.args.claimId, input.action === "completed");
  return { answer, decisionAt };
});

export const browserClaimResultMessage = (
  result: Effect.Success<ReturnType<typeof answerBrowserClaim>>,
) => {
  if (!result) return undefined;
  if ("personMessage" in result.answer && result.answer.personMessage)
    return result.answer.personMessage.replace(/^blocked_url: /, "");
  return result.answer.agentResult.status === "attached"
    ? "Attached"
    : result.answer.agentResult.message;
};

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
  if (
    record.expiresAt !== null &&
    DateTime.toEpochMillis(record.expiresAt) <= DateTime.toEpochMillis(yield* DateTime.now)
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
  return yield* responder.value.answer(payload.args.claimId, input.action === "completed");
});

export const browserClaimResultMessage = (
  result: Effect.Success<ReturnType<typeof answerBrowserClaim>>,
) => {
  if (!result) return undefined;
  if ("personMessage" in result && result.personMessage)
    return result.personMessage.replace(/^blocked_url: /, "");
  return result.agentResult.status === "attached" ? "Attached" : result.agentResult.message;
};

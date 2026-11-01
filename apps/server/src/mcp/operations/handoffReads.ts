import { type Handoff, TurnItemId, isHandoffPending } from "@goat/contracts";
import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Handoffs from "../../handoffs/Handoffs.ts";
import { ProviderSettingsProgress } from "../../provider/ProviderSettingsProgress.ts";
import { McpInvocationContext } from "../McpInvocationContext.ts";

const decodeProgress = Schema.decodeUnknownOption(Schema.toCodecJson(ProviderSettingsProgress));
/** The recorded effects and outcome as stored (JSON), once the record decodes; never the plan. */
const changeOf = (progress: unknown) => {
  if (Option.isNone(decodeProgress(progress))) return undefined;
  const { effects, outcome } = progress as {
    readonly effects: unknown;
    readonly outcome?: unknown;
  };
  return outcome === undefined ? { effects } : { effects, outcome };
};

const missing: AgentSurfaceResult = {
  status: "error",
  error: {
    code: "not_found",
    reason: "not_found",
    message: "This thread has no handoff with that id.",
    retryable: false,
  },
};
const unreadable: AgentSurfaceResult = {
  status: "error",
  error: {
    code: "unavailable",
    reason: "unavailable",
    message: "Could not read the handoff. Try again.",
    retryable: true,
  },
};

/** HandoffSummary on the wire, as goat_call's needs_human carries it. */
const summaryOf = (handoff: Handoff) => ({
  handoffId: handoff.handoffId,
  kind: handoff.kind,
  title: handoff.title,
  state: handoff.state,
  expiresAt: handoff.expiresAt === null ? null : DateTime.formatIso(handoff.expiresAt),
  targetPath: handoff.target.path,
});

/**
 * Reads the caller's own handoff, as a thread reads its own cards: another thread's handoff is not
 * found. While a person has not acted it is needs_human; after, it carries whether its approved
 * change is still applying and what that change recorded (effects and outcome, never the plan).
 */
export type HandoffReader = (
  handoffId: string,
) => Effect.Effect<AgentSurfaceResult, never, McpInvocationContext>;

export const makeHandoffReader = (
  handoffs: Option.Option<Handoffs.Handoffs["Service"]>,
): HandoffReader =>
  Effect.fn("Operation.readHandoff")(function* (handoffId: string) {
    const scope = yield* McpInvocationContext;
    if (Option.isNone(handoffs) || scope.thread === undefined) return missing;
    const read = yield* handoffs.value
      .readProviderContinuation({
        threadId: scope.thread.threadId,
        handoffId: TurnItemId.make(handoffId),
      })
      .pipe(Effect.result);
    if (read._tag === "Failure") return read.failure.reason === "not_found" ? missing : unreadable;
    const { handoff, applying, progress } = read.success;
    if (isHandoffPending(handoff.state))
      return { status: "needs_human", handoff: summaryOf(handoff) } satisfies AgentSurfaceResult;
    const change = changeOf(progress);
    return {
      status: "ok",
      value: { handoff: summaryOf(handoff), applying, ...(change === undefined ? {} : { change }) },
    } satisfies AgentSurfaceResult;
  });

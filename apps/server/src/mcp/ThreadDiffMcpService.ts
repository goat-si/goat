import {
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetTurnDiffInput,
  OrchestratorMcpFailure,
  type OrchestrationGetTurnDiffResult as ThreadTurnDiff,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { bytesOf, clipJsonText, READ_BUDGET_BYTES } from "./toolkits/pullRequests/readBudget.ts";

/** A checkpoint diff as agents get it: cut at the read budget, saying when. */
export type ThreadDiffRead = typeof ThreadTurnDiff.Type & { readonly truncated: boolean };

export class ThreadDiffMcpService extends Context.Service<
  ThreadDiffMcpService,
  {
    readonly turnDiff: (
      scope: McpInvocationScope,
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<ThreadDiffRead, OrchestratorMcpFailure>;
    readonly fullDiff: (
      scope: McpInvocationScope,
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<ThreadDiffRead, OrchestratorMcpFailure>;
  }
>()("goat/mcp/ThreadDiffMcpService") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorMcpService.OrchestratorMcpService;
  const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const unavailable = (error: { readonly message: string }) =>
    new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: `Unable to read the thread's diff: ${error.message}`,
    });
  const clipped = (diff: typeof ThreadTurnDiff.Type): ThreadDiffRead => {
    const rest = bytesOf({ ...diff, diff: "", truncated: true });
    const cut = clipJsonText(diff.diff, READ_BUDGET_BYTES - rest);
    return { ...diff, diff: cut.text, truncated: cut.truncated };
  };
  // Visibility is checked first, so an empty range never answers for a thread the caller cannot read.
  return ThreadDiffMcpService.of({
    turnDiff: Effect.fn("ThreadDiffMcpService.turnDiff")(function* (scope, input) {
      yield* orchestrator.assertReadableThread(scope, input.threadId);
      if (input.fromTurnCount > input.toTurnCount)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "fromTurnCount must be at most toTurnCount.",
        });
      return clipped(yield* diffs.getTurnDiff(input).pipe(Effect.mapError(unavailable)));
    }),
    fullDiff: Effect.fn("ThreadDiffMcpService.fullDiff")(function* (scope, input) {
      yield* orchestrator.assertReadableThread(scope, input.threadId);
      return clipped(yield* diffs.getFullThreadDiff(input).pipe(Effect.mapError(unavailable)));
    }),
  });
});

export const layer: Layer.Layer<
  ThreadDiffMcpService,
  never,
  OrchestratorMcpService.OrchestratorMcpService | CheckpointDiffQuery.CheckpointDiffQuery
> = Layer.effect(ThreadDiffMcpService, make);

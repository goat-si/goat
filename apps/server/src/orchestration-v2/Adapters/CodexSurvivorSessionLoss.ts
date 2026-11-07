import * as Effect from "effect/Effect";
import type { CodexSurvivorBinding, CodexSurvivors } from "../../provider/CodexSurvivors.ts";
import type { DetachedClassification } from "../../provider/CodexDetachedAppServer.ts";

export const isVerifiedCodexProcessLoss = (classification: DetachedClassification) =>
  classification.type === "mismatch" ||
  (classification.type === "gone" && (classification.possibleLeftovers?.length ?? 0) === 0);

export const settleSurvivorSessionLoss = Effect.fn("CodexSurvivorSessionLoss.settle")(
  function* (input: {
    readonly binding: CodexSurvivorBinding;
    readonly service: CodexSurvivors["Service"];
    readonly settle: (detail: string) => Effect.Effect<void>;
  }) {
    const { binding, service } = input;
    const classification = yield* service
      .classifyRecord(binding)
      .pipe(Effect.orElseSucceed(() => ({ type: "unverifiable" as const })));
    if (isVerifiedCodexProcessLoss(classification)) {
      yield* input.settle(
        "The Codex process stopped while the turn that ran across the restart was still running.",
      );
      const obligations = yield* service.getStopObligations(binding.threadId);
      for (const { record, block } of obligations) {
        if (
          record.instanceId !== binding.instanceId ||
          record.recordName !== binding.recordName ||
          block.nativeThreadId !== binding.nativeThreadId ||
          block.nativeTurnId !== binding.nativeTurnId
        )
          continue;
        yield* service
          .clearStopObligation(record, block)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Failed to clear a dead Codex survivor stop obligation", { cause }),
            ),
          );
      }
      return;
    }
    yield* service
      .recordStopObligation(binding, binding)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to fence an unverified Codex survivor", { cause }),
        ),
      );
    yield* input.settle(
      "GOAT could not confirm the Codex process from before the restart stopped.",
    );
  },
);

import type { OrchestrationV2AppThread, ThreadId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";

export function registerCompactUnsupportedCase(
  captureRootRunTermination: typeof import("./RunExecutionService.test.ts").captureRootRunTermination,
) {
  it.effect("tells the user why /compact failed on a provider without compaction", () =>
    Effect.gen(function* () {
      const { written } = yield* captureRootRunTermination({
        key: "start-failure:compact-unsupported",
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () => Stream.never,
        afterStart: (closed) => Deferred.succeed(closed, undefined),
        messageText: "/compact",
      });
      const error = written.find((item) => item.type === "error");
      assert.include(error?.failure.message ?? "", "does not support /compact");
    }),
  );
}

export const rootAppThread = (id: ThreadId) =>
  ({
    id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  }) as OrchestrationV2AppThread;

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ProviderSessionId, type ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
export function registerAgentOomRunCases(
  captureRootRunTermination: typeof import("./RunExecutionService.test.ts").captureRootRunTermination,
  driver: ProviderDriverKind,
) {
  it.effect.each([false, true])(
    "attributes provider start failures only to marked threads (%s)",
    (oomKilled) =>
      Effect.gen(function* () {
        const { written } = yield* captureRootRunTermination({
          key: "oom-start",
          oomKilled,
          shouldFinalizeRun: () => Effect.succeed(true),
          events: () => Stream.never,
          startTurn: (input) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver,
                threadId: input.threadId,
                providerThreadId: input.providerThread.id,
                runId: input.runId,
                cause: "start failed",
              }),
            ),
        });
        const error = written.find((item) => item.type === "error");
        if (oomKilled) assert.equal(error?.failure.code, "oom_kill");
        else assert.notEqual(error?.failure.code, "oom_kill");
      }),
  );
  it.effect.each([false, true])(
    "attributes provider stream failures only to marked threads (%s)",
    (oomKilled) =>
      Effect.gen(function* () {
        const { written } = yield* captureRootRunTermination({
          key: "oom-stream",
          oomKilled,
          shouldFinalizeRun: () => Effect.succeed(true),
          events: () =>
            Stream.fail(
              new ProviderAdapter.ProviderAdapterEventStreamError({
                driver,
                providerSessionId: ProviderSessionId.make("session:oom-stream"),
                cause: "stream failed",
              }),
            ),
        });
        const error = written.find((item) => item.type === "error");
        if (oomKilled) assert.equal(error?.failure.code, "oom_kill");
        else assert.notEqual(error?.failure.code, "oom_kill");
      }),
  );
}

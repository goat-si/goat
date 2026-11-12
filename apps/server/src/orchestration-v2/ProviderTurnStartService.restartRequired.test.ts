import { it as effectIt } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";
import { ProviderSessionOpenError } from "./ProviderSessionManager.ts";
import { ProviderRestartRequiredError } from "./ProviderSessionRetirement.ts";

effectIt.effect("fails the run without a retry while the provider waits to restart", () =>
  Effect.gen(function* () {
    const refusal = new ProviderRestartRequiredError({ runningTurns: 2 });
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new ProviderSessionOpenError({
        instanceId: ProviderInstanceId.make("codex"),
        providerSessionId: ProviderSessionId.make(
          "provider-session:provider-instance:codex:shared",
        ),
        cause: refusal,
      }),
    });

    yield* harness.startWithRetry;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      { type: "error", status: "failed", failure: { message: refusal.message } },
    ]);
  }),
);

effectIt.effect(
  "a start that fails after its session opened gives up its restart reservation",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        ensureThreadFailure: new Error("thread/resume failed"),
      });

      yield* harness.start.pipe(Effect.exit);

      expect(harness.open).toHaveBeenCalledOnce();
      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
      expect(harness.settleTurnStart).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: harness.threadId, runId: harness.runId }),
      );
    }),
);

effectIt.effect("a goal pause opens its session without the new-turn model check", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "/goal pause" });

    yield* harness.start.pipe(Effect.exit);

    expect(harness.open).toHaveBeenCalledWith(expect.objectContaining({ startsTurn: false }));
  }),
);

effectIt.effect(
  "a restart continuation skips the model check only when the adapter can adopt the survivor",
  () =>
    Effect.gen(function* () {
      // With cancelled background work the continuation sends a restart note as a new native turn.
      for (const cancelledWork of [false, true]) {
        const harness = makeLocalCommandHarness({
          text: "Continue",
          previousTurn: { runStatus: "interrupted", turnStatus: "interrupted" },
          restartContinuation: { cancelledWork },
        });

        yield* harness.start.pipe(Effect.exit);

        expect(harness.open).toHaveBeenCalledWith(
          expect.objectContaining({ startsTurn: cancelledWork }),
        );
      }
    }),
);

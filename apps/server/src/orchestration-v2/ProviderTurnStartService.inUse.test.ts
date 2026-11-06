import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { ProviderDriverKind, ProviderThreadId } from "@goat/contracts";
import { it as effectIt } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

effectIt.effect("fails the run instead of replacing a native thread another client holds", () =>
  Effect.gen(function* () {
    const detail = "This conversation is open in another Codex client.";
    const harness = makeLocalCommandHarness({
      text: "Continue",
      resumeFailure: new ProviderAdapter.ProviderAdapterThreadInUseError({
        driver: ProviderDriverKind.make("codex"),
        providerThreadId: ProviderThreadId.make("new-provider-thread"),
        detail,
        cause: new Error("thread native-resume-thread already has an active writer"),
      }),
    });

    const exit = yield* Effect.exit(harness.start);

    expect(harness.fallbackEnsureThread).not.toHaveBeenCalled();
    expect(exit._tag).toBe("Success");
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.providerThreads.at(-1)?.nativeThreadRef?.nativeId).toBe(
      "native-resume-thread",
    );
    expect(projection.contextHandoffs).toEqual([]);
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider turn failed to start",
        failure: { class: "provider_error", message: detail },
      },
    ]);
  }),
);

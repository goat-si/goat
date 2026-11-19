import { it } from "@effect/vitest";
import { ProviderDriverKind, ProviderThreadId } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

it.effect("returns a typed provider start failure when a runtime omits its session", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      omitResumeProviderSession: true,
      resumeFailure: new ProviderAdapter.ProviderAdapterThreadInUseError({
        driver: ProviderDriverKind.make("codex"),
        providerThreadId: ProviderThreadId.make("new-provider-thread"),
        detail: "in use",
        cause: new Error("in use"),
      }),
    });
    const failure = yield* Effect.flip(harness.start);
    expect(failure._tag).toBe("ProviderTurnStartError");
    expect(String(failure.cause)).toContain("codex");
    expect(String(failure.cause)).toContain("providerSession");
    expect(harness.fallbackEnsureThread).not.toHaveBeenCalled();
  }),
);

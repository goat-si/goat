import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { ProviderDriverKind, ProviderSessionId } from "@goat/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as CodexErrors from "effect-codex-app-server/errors";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

const deadline = () =>
  new CodexErrors.CodexAppServerTransportError({
    operation: "read-input-stream",
    cause: { category: "request-deadline", method: "thread/resume" },
  });

it.effect("does not retry a thread load whose outcome is unknown", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", ensureThreadFailure: deadline() });
    yield* harness.startWithRetry;
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.startRootRun).not.toHaveBeenCalled();
  }),
);

it.effect("does not replace a native thread after an unanswered resume", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      resumeFailure: new ProviderAdapter.ProviderAdapterEventStreamError({
        driver: ProviderDriverKind.make("codex"),
        providerSessionId: ProviderSessionId.make("session"),
        cause: deadline(),
      }),
    });
    yield* harness.start;
    expect(harness.fallbackEnsureThread).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
  }),
);

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

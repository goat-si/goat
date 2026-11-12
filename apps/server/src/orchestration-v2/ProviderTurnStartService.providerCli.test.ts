import { it as effectIt } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ProviderSessionId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as Gate from "../provider/ProviderCliGate.ts";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";
import { ProviderSessionOpenError } from "./ProviderSessionManager.ts";

const instanceId = ProviderInstanceId.make("codex-personal");
const openFailure = new ProviderSessionOpenError({
  instanceId,
  providerSessionId: ProviderSessionId.make("provider-session:provider-instance:codex:shared"),
  cause: new Error("spawn codex ENOENT"),
});

const gate = (missing: boolean) =>
  Layer.succeed(
    Gate.ProviderCliGate,
    Gate.ProviderCliGate.of({
      require: () => Effect.die("a started run is not refused again"),
      probe: () => Effect.die("explained through missing"),
      missing: (requested, created, cause) =>
        Effect.succeed(
          missing
            ? new Gate.ProviderCliMissingError({
                instanceId: requested,
                driver: ProviderDriverKind.make("codex"),
                displayName: "Codex",
                host: "vm-1",
                binary: "codex",
                syncable: true,
                created,
                cause,
              })
            : undefined,
        ),
    }),
  );

effectIt.effect(
  "a session that fails because its CLI is gone says so and asks to retry this thread",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        openFailure: openFailure.cause,
        providerCliGate: gate(true),
      });
      yield* harness.start;
      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
      expect(harness.projection().turnItems).toMatchObject([
        {
          type: "error",
          failure: {
            class: "provider_error",
            code: "provider_cli_missing",
            message:
              'Codex is not installed on vm-1 (the codex command was not found), so this thread could not start. Install it with goat_call {path:"provider.sync", args:{driver:"codex", login:false}} on that machine, or in Settings → Connections → Providers on your machines. Then retry this thread.',
          },
        },
      ]);
    }),
);

effectIt.effect("a session that fails while its CLI is present keeps its own message", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: openFailure.cause,
      providerCliGate: gate(false),
    });
    yield* harness.start;
    const [item] = harness.projection().turnItems;
    expect(item).toMatchObject({ type: "error" });
    expect(JSON.stringify(item)).not.toContain("provider_cli_missing");
  }),
);

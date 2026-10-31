import { assert, it } from "@effect/vitest";
import { ServerSettingsError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ServerSettings from "../serverSettings.ts";
import { withHarness } from "../handoffs/Handoffs.testkit.ts";
import { supported, withRequests } from "./ComputerUseRequests.testkit.ts";
import { applyPatch } from "./ComputerUseSettings.ts";

it.effect("two removals from stale views cannot restore the first app", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ handoffs }) =>
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ cuaAllowedApps: ["com.example.A", "com.example.B"] });
        yield* handoffs.removeComputerUseAllowedApp("com.example.A");
        const legacy = yield* applyPatch(
          handoffs,
          { cuaAllowedApps: ["com.example.A"] },
          settings.updateSettings({ cuaAllowedApps: ["com.example.A"] }),
          "test",
        ).pipe(Effect.result);
        assert.equal(legacy._tag, "Failure");
        assert.deepEqual((yield* settings.getSettings).cuaAllowedApps, ["com.example.B"]);
        yield* handoffs.removeComputerUseAllowedApp("com.example.B");
        assert.deepEqual((yield* settings.getSettings).cuaAllowedApps, []);
      }),
    ),
  ),
);

it.effect("removal leaves the allowed apps unchanged when authority expires", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ handoffs }) =>
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ cuaAllowedApps: ["com.example.A"] });
        const result = yield* handoffs
          .removeComputerUseAllowedApp(
            "com.example.A",
            Effect.fail(new ServerSettingsError({ settingsPath: "test", operation: "normalize" })),
          )
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.deepEqual((yield* settings.getSettings).cuaAllowedApps, ["com.example.A"]);
      }),
    ),
  ),
);

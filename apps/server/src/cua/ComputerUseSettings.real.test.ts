import { assert, it } from "@effect/vitest";
import { ServerSettingsError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Handoffs from "../handoffs/Handoffs.ts";
import { withHarness } from "../handoffs/Handoffs.testkit.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseSettings from "./ComputerUseSettings.ts";
import * as CuaDriver from "./CuaDriver.ts";
import { supported, withRequests } from "./ComputerUseRequests.testkit.ts";

const isSettingsError = Schema.is(ServerSettingsError);

it.effect("real handoffs preserve enable, disable, and commit-time revocation", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ handoffs }) =>
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ enableCua: false });
        const revoked = yield* Ref.make(false);
        const authorize = Ref.get(revoked).pipe(
          Effect.flatMap((value) =>
            value
              ? Effect.fail(
                  new ServerSettingsError({
                    settingsPath: "revoked",
                    operation: "enable-computer-use",
                  }),
                )
              : Effect.void,
          ),
        );
        const invoke = (enabled: boolean, revoke: boolean) =>
          ComputerUseSettings.setEnabled(enabled, authorize).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(Handoffs.Handoffs, handoffs),
                Layer.mock(CuaDriver.CuaDriver)({ admitEnable: Ref.set(revoked, revoke) }),
                ServerConfig.layerTest("/tmp", { prefix: "cu-settings-test-" }),
              ),
            ),
          );
        const refused = yield* invoke(true, true).pipe(Effect.result);
        assert.equal(refused._tag, "Failure");
        if (refused._tag === "Failure") {
          assert.isTrue(isSettingsError(refused.failure));
          if (isSettingsError(refused.failure))
            assert.equal(refused.failure.settingsPath, "revoked");
        }
        assert.isFalse((yield* settings.getSettings).enableCua);
        assert.deepEqual(yield* invoke(true, false), { enabled: true });
        assert.isTrue((yield* settings.getSettings).enableCua);
        assert.deepEqual(yield* invoke(false, false), { enabled: false });
        assert.isFalse((yield* settings.getSettings).enableCua);
      }),
    ),
  ),
);

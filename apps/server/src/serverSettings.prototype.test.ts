import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ServerSettingsModule from "./serverSettings.ts";
import { layerServerSettings } from "./serverSettingsLayers.testkit.ts";

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("creates provider instances named after Object.prototype members", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // An inherited Object.prototype member is not an instance that already exists.
      for (const name of ["constructor", "toString", "valueOf"]) {
        const instanceId = ProviderInstanceId.make(name);
        const created = yield* serverSettings.updateProviderInstance({
          operation: "create",
          instanceId,
          instance: { driver: ProviderDriverKind.make("codex") },
        });
        assert.isTrue(Object.hasOwn(created.providerInstances, instanceId));
      }
    }).pipe(Effect.provide(layerServerSettings())),
  );
});

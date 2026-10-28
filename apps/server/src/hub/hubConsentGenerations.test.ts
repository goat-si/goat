import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";

const layer = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "goat-hub-consent-test-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "a committed hub or cloud switch change advances its generation before any subscriber",
  () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const generations = settings.hubConsentGenerations;
      if (generations === undefined) return yield* Effect.die("The live settings omit generations");
      yield* settings.updateSettings({ hub: { enabled: true, autoJoinCloudMachines: true } });
      const start = yield* generations;
      // Off then on: two committed changes, read back with no subscriber having run.
      yield* settings.updateSettings({ hub: { autoJoinCloudMachines: false } });
      yield* settings.updateSettings({ hub: { autoJoinCloudMachines: true } });
      expect(yield* generations).toEqual({ hub: start.hub, cloud: start.cloud + 2 });
      // The hub switch withdraws cloud consent with it.
      yield* settings.updateSettings({ hub: { enabled: false } });
      expect(yield* generations).toEqual({ hub: start.hub + 1, cloud: start.cloud + 3 });
      // Other settings leave both alone.
      yield* settings.updateSettings({ enableCua: true });
      expect(yield* generations).toEqual({ hub: start.hub + 1, cloud: start.cloud + 3 });
    }).pipe(Effect.provide(layer)),
);

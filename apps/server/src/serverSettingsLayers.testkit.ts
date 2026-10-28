import * as Layer from "effect/Layer";
import * as ServerSettingsModule from "./serverSettings.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerConfig from "./config.ts";

export const layerServerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "goat-server-settings-test-",
        }),
      ),
    ),
  );

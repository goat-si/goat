import { assert } from "@effect/vitest";
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

export const assertTerminalSecret = (environment: Record<string, string>, persisted: string) => {
  assert.equal(environment.OPENROUTER_API_KEY, "sk-terminal-secret");
  assert.match(environment.CODEX_HOME ?? "", /[\\/][.]codex-terminal$/);
  assert.notInclude(persisted, "sk-terminal-secret");
  assert.include(persisted, '"valueRedacted": true');
};

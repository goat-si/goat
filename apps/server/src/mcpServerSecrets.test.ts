import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
const layerServerSettingsWithSecrets = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "goat-mcp-settings-test-" })),
    ),
  );
it.layer(NodeServices.layer)("MCP server secrets", (it) => {
  it.effect("redacts MCP secrets, preserves resubmitted values, and removes stale secrets", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const saved = yield* service.updateSettings({
        mcpServers: {
          local: {
            enabled: true,
            transport: "stdio",
            command: "test",
            args: [],
            env: { TOKEN: "sample-token", OLD: "sample-old" },
          },
          remote: {
            enabled: true,
            transport: "http",
            url: "https://example.test",
            headers: { Authorization: "sample-header" },
          },
        },
      });
      const redacted = ServerSettingsModule.redactServerSettingsForClient(saved).mcpServers;
      assert.notInclude(JSON.stringify(redacted), "sample-token");
      assert.notInclude(JSON.stringify(redacted), "sample-header");
      assert.notInclude(yield* fs.readFileString(config.settingsPath), "sample-token");
      yield* service.updateSettings({ mcpServers: redacted });
      assert.deepEqual((yield* service.getSettings).mcpServers, saved.mcpServers);
      const local = redacted.local;
      if (local?.transport !== "stdio") return yield* Effect.die("missing local server");
      yield* service.updateSettings({
        mcpServers: { local: { ...local, env: { TOKEN: local.env.TOKEN! } }, remote: null },
      });
      assert.isTrue(Option.isSome(yield* secrets.get("mcp-server:local:env:TOKEN")));
      assert.isTrue(Option.isNone(yield* secrets.get("mcp-server:local:env:OLD")));
      assert.isTrue(Option.isNone(yield* secrets.get("mcp-server:remote:header:Authorization")));
      yield* service.updateSettings({ mcpServers: { local: null } });
      assert.isTrue(Option.isNone(yield* secrets.get("mcp-server:local:env:TOKEN")));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );
});

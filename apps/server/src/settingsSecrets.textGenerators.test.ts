import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId, type ServerSettings } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { redactServerSettingsForClient } from "./serverSettings.ts";
import { it as effectIt, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerSettingsModule from "./serverSettings.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerConfig from "./config.ts";

it("never exposes a text generator API key in client settings", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    textGenerators: {
      example: {
        kind: "openaiCompatible",
        baseUrl: "https://model.example/v1",
        apiKey: "test-secret-never-log-932",
        enabled: true,
      },
    },
  } as unknown as ServerSettings;
  expect(JSON.stringify(redactServerSettingsForClient(settings))).not.toContain(
    "test-secret-never-log-932",
  );
});

effectIt.effect("keeps API keys out of settings files and client snapshots", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettingsModule.ServerSettingsService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const saved = yield* service.updateSettings({
      textGenerators: {
        [ProviderInstanceId.make("example")]: {
          kind: "openaiCompatible",
          baseUrl: "https://model.example/v1",
          apiKey: "test-secret-never-log-932",
          enabled: true,
        },
      },
    });
    const disk = yield* fs.readFileString(config.settingsPath);
    assert.notInclude(disk, "test-secret-never-log-932");
    assert.notInclude(
      JSON.stringify(redactServerSettingsForClient(saved)),
      "test-secret-never-log-932",
    );
    assert.notInclude(
      JSON.stringify(redactServerSettingsForClient(yield* service.getSettings)),
      "test-secret-never-log-932",
    );
    yield* service.updateSettings({
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("example"),
        model: "test-model",
      },
    });
    assert.equal((yield* service.getSettings).textGenerationModelSelection.instanceId, "example");
    const client = redactServerSettingsForClient(saved);
    yield* service.updateSettings({ textGenerators: client.textGenerators });
    assert.equal(
      (yield* service.getSettings).textGenerators[ProviderInstanceId.make("example")]?.apiKey,
      "test-secret-never-log-932",
    );
    yield* service.updateSettings({
      textGenerators: { [ProviderInstanceId.make("example")]: null },
    });
    const name = `text-generator-${Buffer.from("example").toString("base64url")}-${Buffer.from("apiKey").toString("base64url")}`;
    assert.isTrue(Option.isNone(yield* secrets.get(name)));
  }).pipe(
    Effect.provide(
      ServerSettingsModule.layer.pipe(
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provideMerge(
          Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "goat-textgen-secrets-" })),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

effectIt.effect("does not log API keys when settings contain an invalid generator", () =>
  Effect.gen(function* () {
    const logs: unknown[] = [];
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.writeFileString(
      config.settingsPath,
      JSON.stringify({
        textGenerators: {
          broken: {
            kind: "openaiCompatible",
            baseUrl: "https://model.example/v1",
            apiKey: `test-secret-never-log-932${"x".repeat(8192)}`,
            enabled: true,
          },
        },
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* service.start;
    }).pipe(
      Effect.provide(
        Logger.layer(
          [
            Logger.make(({ message, cause }) => {
              logs.push({ message, cause });
            }),
          ],
          { mergeWithExisting: false },
        ),
      ),
    );
    assert.isAbove(logs.length, 0);
    assert.notInclude(JSON.stringify(logs), "test-secret-never-log-932");
  }).pipe(
    Effect.provide(
      ServerSettingsModule.layer.pipe(
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provideMerge(
          Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "goat-textgen-logs-" })),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

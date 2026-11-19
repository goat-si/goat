import { assert, it } from "@effect/vitest";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import { AcpRegistrySettings } from "@goat/provider-acp-registry/settings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layerServerSettings } from "../serverSettingsLayers.testkit.ts";

it.effect("persists legacy ACP model IDs while retaining validated structured details", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const instanceId = ProviderInstanceId.make("acp-structured-models");
    const instance = {
      driver: ProviderDriverKind.make("acpRegistry"),
      config: {
        agentId: "example",
        customModels: [{ slug: "x", name: "Friendly" }],
      },
    };
    yield* settings.updateProviderInstance({ operation: "upsert", instanceId, instance });
    const saved = JSON.parse(yield* fs.readFileString(config.settingsPath));
    let persisted = saved.providerInstances[instanceId].config;
    assert.deepEqual(persisted.customModels, ["x"]);
    assert.deepEqual(persisted.customModelDetails, [{ slug: "x", name: "Friendly" }]);
    const { customModelDetails: _ignored, ...oldFields } = AcpRegistrySettings.fields;
    const oldDecode = Schema.decodeUnknownEffect(
      Schema.Struct({ ...oldFields, customModels: Schema.Array(Schema.String) }),
    );
    assert.deepEqual((yield* oldDecode(persisted)).customModels, ["x"]);
    yield* settings.updateProviderInstance({
      operation: "upsert",
      instanceId,
      instance: {
        ...instance,
        config: { ...persisted, customModels: [{ slug: "x", name: "Updated by old client" }] },
      },
    });
    persisted = JSON.parse(yield* fs.readFileString(config.settingsPath)).providerInstances[
      instanceId
    ].config;
    assert.deepEqual(persisted.customModels, ["x"]);
    assert.deepEqual(persisted.customModelDetails, [{ slug: "x", name: "Updated by old client" }]);
    const capabilities = {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [{ id: "high", label: "High", isDefault: true }],
        },
      ],
    };
    yield* settings.updateProviderInstance({
      operation: "upsert",
      instanceId,
      instance: {
        ...instance,
        config: {
          ...persisted,
          customModels: ["x"],
          customModelDetails: [{ slug: "x", name: "New client", capabilities }],
        },
      },
    });
    persisted = JSON.parse(yield* fs.readFileString(config.settingsPath)).providerInstances[
      instanceId
    ].config;
    assert.deepEqual(persisted.customModels, ["x"]);
    assert.deepEqual(persisted.customModelDetails, [
      { slug: "x", name: "New client", capabilities },
    ]);
    const invalid = yield* Effect.result(
      settings.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          ...instance,
          config: {
            agentId: "example",
            customModels: ["x"],
            customModelDetails: [{ slug: "x", name: 42 }],
          },
        },
      }),
    );
    assert.isTrue(Result.isFailure(invalid));
    if (Result.isFailure(invalid))
      assert.include(invalid.failure.message, "Invalid ACP custom model settings");
    const invalidBulk = yield* Effect.result(
      settings.updateSettings({
        providerInstances: {
          [instanceId]: {
            ...instance,
            config: {
              agentId: "example",
              customModels: ["x"],
              customModelDetails: [{ slug: "orphan", name: "Orphan" }],
            },
          },
        },
      }),
    );
    assert.isTrue(Result.isFailure(invalidBulk));
    const after = JSON.parse(yield* fs.readFileString(config.settingsPath));
    assert.deepEqual(after.providerInstances[instanceId].config, persisted);
  }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("normalizes legacy named ACP models when another setting is saved", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const instanceId = ProviderInstanceId.make("acp-existing-named");
    yield* fs.writeFileString(
      config.settingsPath,
      JSON.stringify({
        providerInstances: {
          [instanceId]: {
            driver: "acpRegistry",
            config: { agentId: "example", customModels: [{ slug: "x", name: "Friendly" }] },
          },
        },
      }),
    );
    yield* settings.updateSettings({ responseStreamingMode: "turn" });
    const persisted = JSON.parse(yield* fs.readFileString(config.settingsPath)).providerInstances[
      instanceId
    ].config;
    assert.deepEqual(persisted.customModels, ["x"]);
    assert.deepEqual(persisted.customModelDetails, [{ slug: "x", name: "Friendly" }]);
  }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("keeps remaining named details when an older client removes a model", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const instanceId = ProviderInstanceId.make("acp-old-remove");
    const details = [
      { slug: "a", name: "Alpha" },
      { slug: "b", name: "Beta" },
    ];
    const instance = {
      driver: ProviderDriverKind.make("acpRegistry"),
      config: { agentId: "example", customModels: ["a", "b"], customModelDetails: details },
    };
    yield* settings.updateProviderInstance({ operation: "upsert", instanceId, instance });
    const saved = yield* settings.updateProviderInstance({
      operation: "upsert",
      instanceId,
      instance: { ...instance, config: { ...instance.config, customModels: ["b"] } },
    });
    assert.deepEqual(saved.providerInstances[instanceId]?.config, {
      agentId: "example",
      customModels: ["b"],
      customModelDetails: [{ slug: "b", name: "Beta" }],
    });
  }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);

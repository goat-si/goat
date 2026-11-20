import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  UsageLimitSourceId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as ServerSettings from "./serverSettings.ts";

const layer = ServerSettings.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(Sqlite.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "goat-secret-destination-" })),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.effect("keeps a saved reference for its address but clears it when an address changes", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const id = ProviderInstanceId.make("api");
    const original = {
      provider: SecretProviderId.make("vault"),
      reference: "op://vault/item/first",
    };
    const fresh = { provider: SecretProviderId.make("vault"), reference: "op://vault/item/second" };
    const initial = {
      kind: "openaiCompatible" as const,
      baseUrl: "https://old.example/v1",
      apiKey: original,
      enabled: true,
    };
    yield* settings.updateSettings({ textGenerators: { [id]: initial } });
    expect((yield* settings.getSettings).textGenerators[id]?.apiKey).toEqual(original);
    const cleared = yield* settings.updateSettings({
      textGenerators: { [id]: { ...initial, baseUrl: "https://new.example/v1" } },
    });
    expect(cleared.textGenerators[id]?.apiKey).toBe("");
    expect((yield* settings.getSettings).textGenerators[id]?.apiKey).toBe("");
    yield* settings.updateSettings({
      textGenerators: { [id]: { ...initial, baseUrl: "https://new.example/v1" } },
    });
    const saved = yield* settings.updateSettings({
      textGenerators: { [id]: { ...initial, baseUrl: "https://third.example/v1", apiKey: fresh } },
    });
    expect(saved.textGenerators[id]?.apiKey).toEqual(fresh);
  }).pipe(Effect.provide(layer)),
);

it.effect("clears an echoed management-key reference when its hub URL changes", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const reference = {
      provider: SecretProviderId.make("vault"),
      reference: "op://vault/item/first",
    };
    const source = {
      kind: "cliproxy" as const,
      url: "https://old.example",
      managementKey: "",
      managementKeyReference: reference,
      enabled: true,
    };
    const id = UsageLimitSourceId.make("hub");
    yield* settings.updateSettings({ usageLimitSources: { [id]: source } });
    const result = yield* settings.updateSettings({
      usageLimitSources: { [id]: { ...source, url: "https://new.example" } },
    });
    expect(result.usageLimitSources[id]?.managementKeyReference ?? null).toBeNull();
    expect(
      (yield* settings.getSettings).usageLimitSources[id]?.managementKeyReference ?? null,
    ).toBeNull();
    yield* settings.updateSettings({ usageLimitSources: { [id]: source } });
    const fresh = { ...reference, reference: "op://vault/item/second" };
    const replaced = yield* settings.updateSettings({
      usageLimitSources: {
        [id]: { ...source, url: "https://third.example", managementKeyReference: fresh },
      },
    });
    expect(replaced.usageLimitSources[id]?.managementKeyReference).toEqual(fresh);
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["driver", "binary", "endpoint", "endpointAdded", "model"] as const)(
  "protects provider references on %s edits",
  (change) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const id = ProviderInstanceId.make(`test_${change}`);
      const reference = {
        provider: SecretProviderId.make("vault"),
        reference: "op://vault/item/field",
      };
      const initial = {
        driver: ProviderDriverKind.make("opencode"),
        config: { binaryPath: "/usr/bin/agent", serverUrl: "https://old.example", model: "one" },
        environment: [
          { name: "TOKEN", value: "", sensitive: true, secret: reference },
          ...(change === "endpointAdded"
            ? []
            : [{ name: "OPENAI_BASE_URL", value: "https://old.example", sensitive: false }]),
        ],
      };
      yield* settings.updateSettings({ providerInstances: { [id]: initial } });
      const next =
        change === "driver"
          ? { ...initial, driver: ProviderDriverKind.make("codex") }
          : change === "binary"
            ? { ...initial, config: { ...initial.config, binaryPath: "/usr/bin/other" } }
            : change === "endpoint" || change === "endpointAdded"
              ? {
                  ...initial,
                  environment: [
                    initial.environment[0]!,
                    { name: "OPENAI_BASE_URL", value: "https://new.example", sensitive: false },
                  ],
                }
              : { ...initial, config: { ...initial.config, model: "two" } };
      const result = yield* settings.updateSettings({ providerInstances: { [id]: next } });
      const secret = result.providerInstances[id]?.environment?.find(
        (entry) => entry.name === "TOKEN",
      )?.secret;
      if (change === "model") expect(secret).toEqual(reference);
      else expect(secret).toBeUndefined();
    }).pipe(Effect.provide(layer)),
);

it.effect("binds OpenCode password references to the saved server URL", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const id = ProviderInstanceId.make("opencode_bound");
    const reference = {
      provider: SecretProviderId.make("vault"),
      reference: "op://vault/item/first",
    };
    const fresh = { provider: SecretProviderId.make("vault"), reference: "op://vault/item/second" };
    const initial = {
      driver: ProviderDriverKind.make("opencode"),
      config: { serverUrl: "https://old.example", serverPassword: reference },
    };
    yield* settings.updateSettings({ providerInstances: { [id]: initial } });
    const cleared = yield* settings.updateSettings({
      providerInstances: {
        [id]: { ...initial, config: { ...initial.config, serverUrl: "https://new.example" } },
      },
    });
    expect(cleared.providerInstances[id]?.config).toMatchObject({ serverPassword: "" });
    yield* settings.updateSettings({ providerInstances: { [id]: initial } });
    const replaced = yield* settings.updateSettings({
      providerInstances: {
        [id]: { ...initial, config: { serverUrl: "https://new.example", serverPassword: fresh } },
      },
    });
    expect(replaced.providerInstances[id]?.config).toMatchObject({ serverPassword: fresh });
  }).pipe(Effect.provide(layer)),
);

it.effect("preserves a legacy redacted echo at the saved destination only", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const id = ProviderInstanceId.make("legacy_api");
    const reference = {
      provider: SecretProviderId.make("vault"),
      reference: "op://vault/item/first",
    };
    const initial = {
      kind: "openaiCompatible" as const,
      baseUrl: "https://old.example/v1",
      apiKey: reference,
      enabled: true,
    };
    yield* settings.updateSettings({ textGenerators: { [id]: initial } });
    const echoed = yield* settings.updateSettings({
      textGenerators: { [id]: { ...initial, apiKey: "••••••" } },
    });
    expect(echoed.textGenerators[id]?.apiKey).toEqual(reference);
    const changed = yield* settings.updateSettings({
      textGenerators: { [id]: { ...initial, baseUrl: "https://new.example/v1", apiKey: "••••••" } },
    });
    expect(changed.textGenerators[id]?.apiKey).toBe("");
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps a legacy OpenCode redacted reference only at its saved URL", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const id = ProviderInstanceId.make("opencode_legacy");
    const reference = {
      provider: SecretProviderId.make("vault"),
      reference: "op://vault/item/first",
    };
    const initial = {
      driver: ProviderDriverKind.make("opencode"),
      config: { serverUrl: "https://old.example", serverPassword: reference },
    };
    yield* settings.updateSettings({ providerInstances: { [id]: initial } });
    const echoed = yield* settings.updateSettings({
      providerInstances: {
        [id]: { ...initial, config: { ...initial.config, serverPassword: "••••••" } },
      },
    });
    expect(echoed.providerInstances[id]?.config).toMatchObject({ serverPassword: reference });
    const moved = yield* settings.updateSettings({
      providerInstances: {
        [id]: {
          ...initial,
          config: { serverUrl: "https://new.example", serverPassword: "••••••" },
        },
      },
    });
    expect(moved.providerInstances[id]?.config).toMatchObject({ serverPassword: "" });
  }).pipe(Effect.provide(layer)),
);

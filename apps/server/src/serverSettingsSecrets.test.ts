import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  type ProviderInstanceEnvironment,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
import { layerServerSettings } from "./serverSettingsLayers.testkit.ts";

const layerServerSettingsWithSecrets = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "goat-server-settings-test-" })),
    ),
  );

it.layer(NodeServices.layer)("server settings duplicate secrets", (it) => {
  it.effect.each(
    [
      { label: "redacted then empty sensitive", duplicate: { value: "", sensitive: true } },
      {
        label: "empty sensitive then redacted",
        duplicate: { value: "", sensitive: true },
        redactedLast: true,
      },
      { label: "redacted then plain", duplicate: { value: "plain-foo", sensitive: false } },
      {
        label: "plain then redacted",
        duplicate: { value: "plain-foo", sensitive: false },
        redactedLast: true,
      },
      {
        label: "secret reference then redacted",
        duplicate: {
          value: "",
          secret: { provider: SecretProviderId.make("personal"), reference: "op://Private/FOO" },
          sensitive: true,
        },
        redactedLast: true,
      },
      {
        label: "inline seed, redacted then empty sensitive",
        duplicate: { value: "", sensitive: true },
        inline: '[{"name":"FOO","value":"stored-foo","sensitive":true}]',
      },
      {
        label: "inline seed with an empty duplicate, redacted then empty sensitive",
        duplicate: { value: "", sensitive: true },
        inline:
          '[{"name":"FOO","value":"stored-foo","sensitive":true},{"name":"FOO","value":"","sensitive":true}]',
      },
      {
        label: "inline seed with an empty duplicate, new value then redacted",
        duplicate: { value: "new-foo", sensitive: true },
        redactedLast: true,
        inline:
          '[{"name":"FOO","value":"stored-foo","sensitive":true},{"name":"FOO","value":"","sensitive":true}]',
        expected: "new-foo",
      },
    ].map((testCase) => [testCase.label, testCase] as const),
  )(
    "keeps a stored secret a redacted row still claims when a duplicate name is saved (%s)",
    ([, { duplicate, redactedLast, inline, expected = "stored-foo" }]) =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("codex_personal");
        const save = (environment: ProviderInstanceEnvironment) =>
          service.updateSettings({
            providerInstances: {
              [instanceId]: { driver: ProviderDriverKind.make("codex"), environment, config: {} },
            },
          });
        if (inline) {
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(
            config.settingsPath,
            `{"providerInstances":{"codex_personal":{"driver":"codex","environment":${inline},"config":{}}}}`,
          );
          yield* service.getSettings;
        } else {
          yield* save([{ name: "FOO", value: "stored-foo", sensitive: true }]);
        }
        const redacted = { name: "FOO", value: "", sensitive: true, valueRedacted: true };
        const copy = { name: "FOO", ...duplicate };
        yield* save(redactedLast ? [copy, redacted] : [redacted, copy]);

        const reloaded = yield* Effect.gen(function* () {
          const fresh = yield* ServerSettingsModule.ServerSettingsService;
          return yield* fresh.getSettings;
        }).pipe(
          Effect.provide(
            Layer.fresh(ServerSettingsModule.layer).pipe(Layer.provide(ServerSecretStore.layer)),
          ),
        );
        assert.equal(
          reloaded.providerInstances[instanceId]?.environment?.[redactedLast ? 1 : 0]?.value,
          expected,
        );
      }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect.each(
    [
      {
        label: "write then empty sensitive",
        duplicate: { value: "", sensitive: true },
        writeLast: false,
      },
      {
        label: "empty sensitive then write",
        duplicate: { value: "", sensitive: true },
        writeLast: true,
      },
      {
        label: "write then plain",
        duplicate: { value: "plain-foo", sensitive: false },
        writeLast: false,
      },
      {
        label: "plain then write",
        duplicate: { value: "plain-foo", sensitive: false },
        writeLast: true,
      },
    ].map((testCase) => [testCase.label, testCase] as const),
  )(
    "keeps duplicate rows consistent with the last secret operation (%s)",
    ([, { duplicate, writeLast }]) =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const store = yield* ServerSecretStore.ServerSecretStore;
        const instanceId = ProviderInstanceId.make("codex_personal");
        const written = { name: "FOO", value: "new-foo", sensitive: true };
        const copy = { name: "FOO", ...duplicate };
        const saved = yield* service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: writeLast ? [copy, written] : [written, copy],
              config: {},
            },
          },
        });
        const stored = yield* store.get("provider-env-Y29kZXhfcGVyc29uYWw-Rk9P");
        assert.equal(Option.isSome(stored), writeLast);
        if (Option.isSome(stored)) assert.equal(new TextDecoder().decode(stored.value), "new-foo");
        const fresh = yield* Effect.gen(function* () {
          const reloaded = yield* ServerSettingsModule.ServerSettingsService;
          return yield* reloaded.getSettings;
        }).pipe(
          Effect.provide(
            Layer.fresh(ServerSettingsModule.layer).pipe(Layer.provide(ServerSecretStore.layer)),
          ),
        );
        for (const settings of [saved, fresh]) {
          const rows = settings.providerInstances[instanceId]?.environment;
          const secret = rows?.[writeLast ? 1 : 0];
          assert.equal(secret?.value, writeLast ? "new-foo" : "");
          assert.equal(secret?.valueRedacted === true, writeLast);
          assert.equal(rows?.[writeLast ? 0 : 1]?.value, duplicate.value);
        }
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("removes a kept secret once every row with its name is deleted", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const store = yield* ServerSecretStore.ServerSecretStore;
      const instanceId = ProviderInstanceId.make("codex_personal");
      const save = (environment: ProviderInstanceEnvironment) =>
        service.updateSettings({
          providerInstances: {
            [instanceId]: { driver: ProviderDriverKind.make("codex"), environment, config: {} },
          },
        });
      yield* save([{ name: "FOO", value: "stored-foo", sensitive: true }]);
      yield* save([
        { name: "FOO", value: "", sensitive: true, valueRedacted: true },
        { name: "FOO", value: "plain-foo", sensitive: false },
      ]);
      const secretName = "provider-env-Y29kZXhfcGVyc29uYWw-Rk9P";
      assert.isTrue(Option.isSome(yield* store.get(secretName)));
      yield* save([]);
      assert.isTrue(Option.isNone(yield* store.get(secretName)));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );
});

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_OPENCODEX_BASE_URL,
  EnvironmentId,
  type CodexSettings,
  ProviderInstanceConfigMap,
  ServerSettings as ServerSettingsSchema,
  ProviderInstanceId,
} from "@goat/contracts";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexDriver } from "./Drivers/CodexDriver.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { ProviderDriverError } from "./Errors.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const decodeProviderInstanceConfigMap = Schema.decodeUnknownSync(ProviderInstanceConfigMap);
const decodeSecretProviderSettings = Schema.decodeUnknownSync(ServerSettingsSchema);

const layerBackgroundPolicyAlwaysRun = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  modelRoute: "default",
  opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
  opencodexAuth: "openai",
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

describe("ProviderInstanceRegistry — multi-instance codex slice", () => {
  const layerBaseDeps = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-test",
  }).pipe(
    Layer.provideMerge(
      Layer.mock(CodexManagedTokenBroker.CodexManagedTokenBroker)({
        endpoint: Effect.succeed("unused-private-pipe"),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.mock(CodexInstallation.CodexInstallation)({
        managedDirectory: "unused-managed-installation",
      }),
    ),
    Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
    ),
    Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(layerTestHttpClient),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(ProviderLatestVersions.layer),
    Layer.provideMerge(McpProviderSessions.layer),
    Layer.provideMerge(ModelManifest.layerTest),
    Layer.provideMerge(ResetCreditCoordinator.layerTest),
  );
  const layerBase = ProviderHostLive.layer.pipe(Layer.provideMerge(layerBaseDeps));
  const layerTest = ProviderOrchestrationAdapterInfrastructure.layer.pipe(
    Layer.provideMerge(layerBase),
  );

  it.effect(
    "does not launch a provider when its referenced environment secret is unavailable",
    () =>
      Effect.gen(function* () {
        let created = false;
        const driver: typeof CodexDriver = {
          ...CodexDriver,
          create: (input) => {
            created = true;
            return CodexDriver.create(input);
          },
        };
        const id = ProviderInstanceId.make("secret_test");
        const settings = decodeProviderInstanceConfigMap({
          [id]: {
            driver: "codex",
            config: makeCodexConfig({ enabled: true }),
            environment: [
              {
                name: "API_KEY",
                value: "",
                sensitive: true,
                secret: { provider: "vault", reference: "op://work/item/password" },
              },
            ],
          },
        });
        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: settings,
        });
        expect(created).toBe(false);
        expect(yield* registry.getInstance(id)).toBeUndefined();
        expect(yield* registry.listUnavailable).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("resolves referenced environment values only for the provider driver", () =>
    Effect.gen(function* () {
      let received: ReadonlyArray<{
        readonly name: string;
        readonly value: string;
        readonly sensitive: boolean;
      }> = [];
      const driver: typeof CodexDriver = {
        ...CodexDriver,
        create: (input) => {
          received = input.environment;
          return CodexDriver.create(input);
        },
      };
      const id = ProviderInstanceId.make("secret_test");
      const settings = decodeProviderInstanceConfigMap({
        [id]: {
          driver: "codex",
          config: makeCodexConfig({ enabled: true }),
          environment: [
            {
              name: "API_KEY",
              value: "",
              sensitive: true,
              secret: { provider: "vault", reference: "op://work/item/password" },
            },
          ],
        },
      });
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [driver],
        configMap: settings,
        resolveSecret: () => Effect.succeed("fixture-secret"),
      });
      expect(yield* registry.getInstance(id)).toBeDefined();
      expect(received).toEqual([{ name: "API_KEY", value: "fixture-secret", sensitive: true }]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("rebuilds a provider when its referenced secret provider changes", () =>
    Effect.gen(function* () {
      let creations = 0;
      const driver: typeof CodexDriver = {
        ...CodexDriver,
        create: (input) => {
          creations++;
          return CodexDriver.create(input);
        },
      };
      const id = ProviderInstanceId.make("secret_test");
      const configMap = decodeProviderInstanceConfigMap({
        [id]: {
          driver: "codex",
          config: makeCodexConfig({ enabled: true }),
          environment: [
            {
              name: "API_KEY",
              value: "",
              sensitive: true,
              secret: { provider: "vault", reference: "op://work/item/password" },
            },
          ],
        },
      });
      const providers = (account: string) =>
        decodeSecretProviderSettings({
          secretProviders: { vault: { kind: "one_password", label: "Vault", config: { account } } },
        }).secretProviders;
      const { mutator } = yield* makeProviderInstanceRegistry({
        drivers: [driver],
        configMap,
        secretProviders: providers("first"),
        resolveSecret: () => Effect.succeed("fixture"),
      });
      yield* mutator.reconcile(configMap, providers("second"));
      expect(creations).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("retries an unavailable secret-backed provider on explicit refresh", () =>
    Effect.gen(function* () {
      let available = false;
      let invalidations = 0;
      const id = ProviderInstanceId.make("secret_test");
      const configMap = decodeProviderInstanceConfigMap({
        [id]: {
          driver: "codex",
          config: makeCodexConfig({ enabled: true }),
          environment: [
            {
              name: "API_KEY",
              value: "",
              sensitive: true,
              secret: { provider: "vault", reference: "op://work/item/password" },
            },
          ],
        },
      });
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
        resolveSecret: () =>
          available
            ? Effect.succeed("fixture")
            : Effect.fail(
                new ProviderDriverError({
                  driver: CodexDriver.driverKind,
                  instanceId: id,
                  detail: "locked",
                }),
              ),
        invalidateSecrets: () => {
          invalidations++;
        },
      });
      expect(yield* registry.getInstance(id)).toBeUndefined();
      available = true;
      yield* mutator.reloadSecrets?.(id) ?? Effect.void;
      expect(yield* registry.getInstance(id)).toBeDefined();
      expect(invalidations).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("can publish a loading provider before starting a secret read", () =>
    Effect.gen(function* () {
      let reads = 0;
      const id = ProviderInstanceId.make("secret_test");
      const configMap = decodeProviderInstanceConfigMap({
        [id]: {
          driver: "codex",
          config: makeCodexConfig({ enabled: true }),
          environment: [
            {
              name: "API_KEY",
              value: "",
              sensitive: true,
              secret: { provider: "vault", reference: "op://work/item/password" },
            },
          ],
        },
      });
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
        deferSecrets: true,
        resolveSecret: () => {
          reads++;
          return Effect.succeed("fixture");
        },
      });
      expect(reads).toBe(0);
      expect(yield* registry.listUnavailable).toHaveLength(1);
      yield* mutator.reloadSecrets?.(id) ?? Effect.void;
      expect(reads).toBe(1);
      expect(yield* registry.getInstance(id)).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("bounds the total secret-read time for a provider", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const wait = yield* Deferred.make<string>();
      const id = ProviderInstanceId.make("secret_test");
      const configMap = decodeProviderInstanceConfigMap({
        [id]: {
          driver: "codex",
          config: makeCodexConfig({ enabled: true }),
          environment: [
            {
              name: "API_KEY",
              value: "",
              sensitive: true,
              secret: { provider: "vault", reference: "op://work/item/password" },
            },
          ],
        },
      });
      const fiber = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
        resolveSecret: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(wait))),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("45 seconds");
      const { registry } = yield* Fiber.join(fiber);
      expect(yield* registry.getInstance(id)).toBeUndefined();
      expect(yield* registry.listUnavailable).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps a live provider when an explicit secret refresh reads the same value", () =>
    Effect.gen(function* () {
      let creations = 0;
      let secret = "fixture";
      const driver: typeof CodexDriver = {
        ...CodexDriver,
        create: (input) => {
          creations++;
          return CodexDriver.create(input);
        },
      };
      const id = ProviderInstanceId.make("secret_test");
      const configMap = decodeProviderInstanceConfigMap({
        [id]: {
          driver: "codex",
          config: makeCodexConfig({ enabled: true }),
          environment: [
            {
              name: "API_KEY",
              value: "",
              sensitive: true,
              secret: { provider: "vault", reference: "op://work/item/password" },
            },
          ],
        },
      });
      const { mutator } = yield* makeProviderInstanceRegistry({
        drivers: [driver],
        configMap,
        resolveSecret: () => Effect.succeed(secret),
      });
      yield* mutator.reloadSecrets?.(id) ?? Effect.void;
      expect(creations).toBe(1);
      secret = "rotated";
      yield* mutator.reloadSecrets?.(id) ?? Effect.void;
      expect(creations).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});

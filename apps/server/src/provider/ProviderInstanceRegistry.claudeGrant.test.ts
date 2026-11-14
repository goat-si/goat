import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@goat/contracts";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as HostProcess from "@goat/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeDriver } from "./Drivers/ClaudeDriver.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

// The mock CLIs from makeTildeProviderFixtures are scripts Windows cannot execute.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

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

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  autoCompactWindow: "",
  idleCompaction: "default",
  ...overrides,
});

const makeTildeProviderFixtures = Effect.fn(
  "ProviderInstanceRegistry.test.makeTildeProviderFixtures",
)(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = yield* HostProcess.HomeDirectory;
  const fixtureDir = yield* fileSystem.makeTempDirectory({
    directory: homePath,
    prefix: ".goat-provider-path-test-",
  });
  const codexPath = path.join(fixtureDir, "codex");
  const claudePath = path.join(fixtureDir, "claude");
  const claudeHomePath = path.join(fixtureDir, "claude-home");
  const codexScriptPath = path.join(fixtureDir, "codex-script.json");
  const codexFixtureDir = path.join(import.meta.dirname, "testFixtures");

  yield* fileSystem.copyFile(path.join(codexFixtureDir, "codexCollabMockPeer.sh"), codexPath);
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexCollabMockPeer.mjs"),
    path.join(fixtureDir, "codexCollabMockPeer.mjs"),
  );
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexMultiAgentWire.json"),
    path.join(fixtureDir, "codexMultiAgentWire.json"),
  );
  yield* fileSystem.writeFileString(
    codexScriptPath,
    JSON.stringify({ rootThreadId: "probe-thread", notifications: [] }),
  );
  yield* fileSystem.chmod(codexPath, 0o755);

  yield* fileSystem.copyFile(
    yield* path.fromFileUrl(
      new URL("./testing/ProviderInstanceRegistryLive.fixture.mjs", import.meta.url),
    ),
    claudePath,
  );
  yield* fileSystem.chmod(claudePath, 0o755);
  yield* fileSystem.makeDirectory(claudeHomePath);

  const asTildePath = (filePath: string) => `~/${path.relative(homePath, filePath)}`;
  return {
    codexBinaryPath: asTildePath(codexPath),
    claudeBinaryPath: asTildePath(claudePath),
    claudeHomePath,
    codexScriptPath,
  };
});

describe("ProviderInstanceRegistry Claude grants", () => {
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
      Layer.effectContext(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "provider-registry-home-" });
          return Context.make(HostProcess.HomeDirectory, home).pipe(
            Context.add(HostProcess.Environment, {
              HOME: home,
              PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
            }),
            Context.add(FileSystem.FileSystem, {
              ...fs,
              readFileString: (file: string) =>
                fs.readFileString(
                  file.endsWith("/managed-settings.json") ||
                    file.endsWith("\\managed-settings.json")
                    ? path.join(home, "missing")
                    : file,
                ),
            }),
          );
        }),
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
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

  const redeemSelectedClaudeReset = (claim: {
    result: string;
    usageFailsAfterClaim: boolean;
    creditId?: string;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtures = yield* makeTildeProviderFixtures();
      const marker = path.join(fixtures.claudeHomePath, "redeemed");
      yield* fs.writeFileString(
        path.join(fixtures.claudeHomePath, ".credentials.json"),
        '{"claudeAiOauth":{"accessToken":"fake-token"}}',
      );
      yield* fs.writeFileString(
        path.join(fixtures.claudeHomePath, ".claude.json"),
        '{"oauthAccount":{"organizationUuid":"fake-org"}}',
      );
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.url.endsWith("/api/oauth/usage")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                cedar_ember: {
                  eligible: true,
                  next_grant_id: "grant_a",
                  grants: [
                    { id: "grant_a", resets_left: 1, usable_now: true, clears: ["seven_day"] },
                  ],
                },
              }),
            );
          }
          if (request.url.endsWith("/reset_rate_limits")) {
            yield* fs.writeFileString(marker, "redeemed").pipe(Effect.orDie);
            return HttpClientResponse.fromWeb(request, Response.json({ result: claim.result }));
          }
          return HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }));
        }),
      );
      const instanceId = ProviderInstanceId.make("claude_reset");
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [ClaudeDriver],
        configMap: {
          [instanceId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            environment: [
              { name: "GOAT_CLAUDE_RESET_MARKER", value: marker, sensitive: false },
              ...(claim.usageFailsAfterClaim
                ? [{ name: "GOAT_CLAUDE_USAGE_FAILS_AFTER_CLAIM", value: "1", sensitive: false }]
                : []),
            ],
            config: makeClaudeConfig({
              enabled: true,
              binaryPath: fixtures.claudeBinaryPath,
              homePath: fixtures.claudeHomePath,
            }),
          },
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      const instance = yield* registry.getInstance(instanceId);
      expect(instance).toBeDefined();
      const before = yield* instance!.snapshot.refresh;
      expect(before.usageLimits?.windows[0]?.usedPercent).toBe(100);
      expect(before.usageLimits?.resetCredits?.nextCreditId).toBe("grant_a");
      const invalid = yield* instance!.consumeResetCredit!("unknown-grant");
      expect(invalid).toBe("noCredit");
      expect(yield* fs.exists(marker)).toBe(false);
      const outcome = yield* instance!.consumeResetCredit!(claim.creditId).pipe(Effect.result);
      return { outcome, after: yield* instance!.snapshot.getSnapshot };
    }).pipe(
      // macOS logins live in the Keychain, where resets are never read.
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provide(layerTest),
    );

  it.live.skipIf(windowsHost)("redeems a selected Claude grant and rejects unknown grants", () =>
    Effect.gen(function* () {
      const { outcome } = yield* redeemSelectedClaudeReset({
        result: "already_used",
        usageFailsAfterClaim: true,
        creditId: "grant_a",
      });
      expect(outcome).toMatchObject({ _tag: "Success", success: "alreadyRedeemed" });
    }),
  );
});

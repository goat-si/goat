import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderInstanceId,
  SecretProviderId,
  type ProviderInstanceEnvironment,
  type ServerProvider,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { AcpRegistryDriver } from "./driver.ts";

const quotaReader = vi.hoisted(() => ({
  create: vi.fn<() => void>(),
  read: vi.fn<
    (
      environment: NodeJS.ProcessEnv,
      args: readonly string[],
    ) => Effect.Effect<ServerProvider["usageLimits"]>
  >(),
}));
vi.mock("./minimaxCodeAccountQuota.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    makeMiniMaxCodeQuotaReader: () =>
      Effect.sync(() => {
        quotaReader.create();
        return quotaReader.read;
      }),
  };
});

const decodeSettings = Schema.decodeUnknownSync(AcpRegistrySettings);
const environment = { HOME: "/fixture/home", MINIMAX_DATA_DIR: "/fixture/inherited-profile" };
const mcodeProfile = {
  name: "MINIMAX_DATA_DIR",
  value: "/fixture/mcode-profile",
  sensitive: false,
};
const mcodeRegion = { name: "MAVIS_REGION", value: "en", sensitive: false };
const bootstrap = (installed: boolean) =>
  Layer.mergeAll(
    IdAllocator.layer,
    McpProviderSessions.layer,
    TestProviderHost.layer({ runBackgroundWork: false }).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
    Layer.succeed(HostProcess.Environment, environment),
    Layer.succeed(HostProcess.HomeDirectory, environment.HOME),
    Layer.succeed(AcpRegistrySupport.AcpRegistryCatalog, {
      inspect: () =>
        Effect.succeed(
          installed
            ? { status: "ready", agentId: "minimax-code", version: "1", distribution: "local" }
            : { status: "not_found", agentId: "minimax-code" },
        ),
      resolve: () =>
        new AcpRegistrySupport.AcpRegistryError({
          reason: "probe_failed",
          detail: "No process should be started by this quota wiring test.",
        }),
      search: () => Effect.die("unused"),
      prepare: () => Effect.die("unused"),
      uninstallManagedBinary: () => Effect.die("unused"),
    }),
    NodeServices.layer,
    NodeCrypto.layer,
  );

const makeProvider = (
  instanceName: string,
  raw: unknown,
  variables: ProviderInstanceEnvironment = [mcodeProfile],
) =>
  AcpRegistryDriver.create({
    instanceId: ProviderInstanceId.make(instanceName),
    displayName: undefined,
    environment: variables,
    enabled: true,
    config: decodeSettings(raw),
  });

const mcode = { source: "local", commandPath: "mcode", commandArgs: ["acp"] };

it.effect("does not construct the quota reader for disabled or unrelated ACP settings", () =>
  Effect.gen(function* () {
    quotaReader.create.mockClear();
    quotaReader.read.mockClear();
    yield* makeProvider("off", mcode);
    yield* makeProvider("unrelated", {
      ...mcode,
      commandPath: "other",
      readMiniMaxCodeQuota: true,
    });
    assert.strictEqual(quotaReader.create.mock.calls.length, 0);
    assert.strictEqual(quotaReader.read.mock.calls.length, 0);
  }).pipe(Effect.scoped, Effect.provide(bootstrap(true))),
);

it.effect("does not read quota for a missing executable even with opt-in", () =>
  Effect.gen(function* () {
    quotaReader.read.mockClear();
    const instance = yield* makeProvider("not-installed", { ...mcode, readMiniMaxCodeQuota: true });
    const snapshot = yield* instance.snapshot.refresh;
    assert.strictEqual(snapshot.installed, false);
    assert.strictEqual(quotaReader.read.mock.calls.length, 0);
  }).pipe(Effect.scoped, Effect.provide(bootstrap(false))),
);

it.effect("does not arm quota for inherited, ambiguous, or secret profile variables", () =>
  Effect.gen(function* () {
    quotaReader.create.mockClear();
    quotaReader.read.mockClear();
    const rejected = [
      [],
      [mcodeProfile, mcodeProfile],
      [{ ...mcodeProfile, value: "   " }],
      [{ ...mcodeProfile, value: "./relative/profile" }],
      [{ ...mcodeProfile, sensitive: true }],
      [{ ...mcodeProfile, valueRedacted: true }],
      [
        {
          ...mcodeProfile,
          secret: { provider: SecretProviderId.make("vault"), reference: "fixture" },
        },
      ],
      [mcodeProfile, { ...mcodeRegion, sensitive: true }],
      [mcodeProfile, { ...mcodeRegion, value: "unknown" }],
      [mcodeProfile, mcodeRegion, { ...mcodeRegion, value: "cn" }],
    ] satisfies ReadonlyArray<ProviderInstanceEnvironment>;
    for (const [index, variables] of rejected.entries()) {
      yield* makeProvider(
        `invalid-profile-${index}`,
        { ...mcode, readMiniMaxCodeQuota: true },
        variables,
      );
    }
    assert.strictEqual(quotaReader.create.mock.calls.length, 0);
    assert.strictEqual(quotaReader.read.mock.calls.length, 0);
  }).pipe(Effect.scoped, Effect.provide(bootstrap(true))),
);

it.effect("publishes quota from the selected environment without blocking readiness", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const limits = {
      checkedAt: "2026-01-01T00:00:00Z",
      windows: [{ id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 30 }],
    };
    quotaReader.read
      .mockReset()
      .mockImplementation(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.as(limits),
        ),
      );
    const instance = yield* makeProvider("mcode-quota", { ...mcode, readMiniMaxCodeQuota: true }, [
      mcodeProfile,
      mcodeRegion,
    ]);
    const updates = yield* instance.snapshot.streamChanges.pipe(
      Stream.toQueue({ capacity: "unbounded" }),
    );
    const refreshed = yield* instance.snapshot.refresh;
    assert.strictEqual(refreshed.installed, true);
    yield* Deferred.await(started);
    const ready = yield* instance.snapshot.getSnapshot;
    assert.strictEqual(ready.installed, true);
    assert.strictEqual(ready.usageLimits, undefined);
    assert.strictEqual(quotaReader.read.mock.calls[0]?.[0].MINIMAX_DATA_DIR, mcodeProfile.value);
    assert.strictEqual(quotaReader.read.mock.calls[0]?.[0].MAVIS_REGION, mcodeRegion.value);
    assert.deepStrictEqual(quotaReader.read.mock.calls[0]?.[1], ["acp"]);
    yield* Deferred.succeed(finish, undefined);
    const enriched = yield* Stream.fromQueue(updates).pipe(
      Stream.filter((snapshot) => snapshot.usageLimits !== undefined),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    assert.deepStrictEqual(enriched.usageLimits, limits);
  }).pipe(Effect.scoped, Effect.provide(bootstrap(true))),
);

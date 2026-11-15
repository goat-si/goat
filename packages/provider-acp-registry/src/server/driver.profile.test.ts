import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  AcpRegistryOperationError,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";

const decodeSettings = Schema.decodeEffect(AcpRegistrySettings);

it.live(
  "discards an earlier profile's failed probe and logout after the current profile is confirmed",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const logoutStarted = yield* Deferred.make<void>();
      const logoutRelease = yield* Deferred.make<void>();
      const host = { HOME: "/profile/a", PATH: "/fixture" };
      const published: ServerProvider[] = [];
      let confirm: Effect.Effect<void> | undefined;
      let isConfirmed: Effect.Effect<boolean> | undefined;
      let enrich: Effect.Effect<void> | undefined;
      let check: Effect.Effect<ServerProvider> | undefined;
      yield* Effect.sync(() => {
        vi.doMock("./authenticationState.ts", async (importOriginal) => {
          const actual = await importOriginal<typeof import("./authenticationState.ts")>();
          return {
            ...actual,
            makeAcpRegistryAuthenticationState: (
              ...args: Parameters<typeof actual.makeAcpRegistryAuthenticationState>
            ) =>
              actual.makeAcpRegistryAuthenticationState(...args).pipe(
                Effect.tap((state) =>
                  Effect.sync(() => {
                    confirm = state.set(true);
                    isConfirmed = state.get;
                  }),
                ),
              ),
          };
        });
        vi.doMock("./probe.ts", async (importOriginal) => {
          const actual = await importOriginal<typeof import("./probe.ts")>();
          return {
            ...actual,
            logoutAcpRegistry: () =>
              Deferred.succeed(logoutStarted, undefined).pipe(
                Effect.andThen(Deferred.await(logoutRelease)),
              ),
            probeAcpRegistryConfiguration: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(
                  Effect.fail(
                    new AcpRegistryOperationError({
                      reason: "authentication_failed",
                      message: "profile A is signed out",
                    }),
                  ),
                ),
              ),
          };
        });
        vi.doMock("@goat/provider-core/server/managedProvider", async (importOriginal) => {
          const actual =
            await importOriginal<typeof import("@goat/provider-core/server/managedProvider")>();
          return {
            ...actual,
            makeManagedServerProvider: (
              input: Parameters<typeof actual.makeManagedServerProvider>[0],
            ) =>
              Effect.gen(function* () {
                const settings = yield* input.getSettings;
                check = input.checkProvider.pipe(Effect.orDie);
                const snapshot = yield* input.checkProvider;
                const getSnapshot = Effect.succeed(snapshot);
                if (input.enrichSnapshot) {
                  enrich = input.enrichSnapshot({
                    settings,
                    snapshot,
                    getSnapshot,
                    publishSnapshot: (next) =>
                      Effect.sync(() => {
                        published.push(next);
                      }),
                  });
                }
                return {
                  getSnapshot,
                  refresh: input.checkProvider,
                  streamChanges: Stream.empty,
                  resolveMaintenance: input.resolveMaintenance,
                };
              }),
          };
        });
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          vi.doUnmock("./authenticationState.ts");
          vi.doUnmock("./probe.ts");
          vi.doUnmock("@goat/provider-core/server/managedProvider");
        }),
      );
      const { AcpRegistryDriver } = yield* Effect.promise(() => import("./driver.ts"));
      const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
        inspect: () =>
          Effect.succeed({
            status: "ready",
            agentId: "test",
            version: "1",
            distribution: "binary",
          }),
        resolve: (_settings, cwd, environment) =>
          Effect.succeed({
            distribution: "local" as const,
            spawn: {
              command: process.execPath,
              args: [],
              cwd,
              ...(environment === undefined ? {} : { env: environment }),
            },
          }),
        search: () => Effect.die("unused"),
        prepare: () => Effect.die("unused"),
        uninstallManagedBinary: () => Effect.die("unused"),
      };
      const instance = yield* AcpRegistryDriver.create({
        instanceId: ProviderInstanceId.make("stale-profile-probe"),
        displayName: undefined,
        environment: [],
        enabled: true,
        config: yield* decodeSettings({ agentId: "test" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.provideService(HostProcess.Environment, host),
        Effect.provideService(HostProcess.HomeDirectory, host.HOME),
      );
      if (!enrich || !confirm || !isConfirmed || !check)
        return yield* Effect.die("driver was not initialized");
      const probe = yield* enrich.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      host.HOME = "/profile/b";
      yield* confirm;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(probe);
      assert.isTrue(yield* isConfirmed);
      assert.strictEqual((yield* check).auth.status, "authenticated");
      assert.deepStrictEqual(published, []);
      host.HOME = "/profile/a";
      const logout = yield* instance
        .acpSessionManagement!.logout("/workspace")
        .pipe(Effect.forkChild);
      yield* Deferred.await(logoutStarted);
      host.HOME = "/profile/b";
      yield* confirm;
      yield* Deferred.succeed(logoutRelease, undefined);
      yield* Fiber.join(logout);
      assert.isTrue(yield* isConfirmed);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          TestProviderHost.layer({ runBackgroundWork: false }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
          NodeServices.layer,
        ),
      ),
    ),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { AcpRegistryDriver } from "./driver.ts";

const decodeSettings = Schema.decodeEffect(AcpRegistrySettings);

it.live("refreshes the successful readiness probe when the effective profile changes", () =>
  Effect.gen(function* () {
    const host = { HOME: "/profile/one", PATH: "/fixture", GOAT_ACP_SESSION_LIFECYCLE: "1" };
    let probes = 0;
    const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
      inspect: () =>
        Effect.succeed({ status: "ready", agentId: "test", version: "1", distribution: "binary" }),
      resolve: (_settings, cwd, environment, options) =>
        Effect.sync(() => {
          if (options?.allowInstall === false) probes++;
          return {
            distribution: "local" as const,
            spawn: {
              command: process.execPath,
              args: [
                new URL("../../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url)
                  .pathname,
              ],
              cwd,
              ...(environment === undefined ? {} : { env: environment }),
            },
          };
        }),
      search: () => Effect.die("unused"),
      prepare: () => Effect.die("unused"),
      uninstallManagedBinary: () => Effect.die("unused"),
    };
    const instance = yield* AcpRegistryDriver.create({
      instanceId: ProviderInstanceId.make("cache-profile"),
      displayName: undefined,
      environment: [],
      enabled: true,
      config: yield* decodeSettings({ agentId: "test" }),
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.provideService(HostProcess.Environment, host),
      Effect.provideService(HostProcess.HomeDirectory, host.HOME),
    );
    const queue = yield* instance.snapshot.streamChanges.pipe(
      Stream.toQueue({ capacity: "unbounded" }),
    );
    const enriched = Stream.fromQueue(queue).pipe(
      Stream.filter(
        (snapshot) =>
          snapshot.installed &&
          snapshot.message !==
            "Checking ACP authentication, models, and commands in the background...",
      ),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    yield* instance.snapshot.refresh;
    const first = yield* enriched;
    assert.strictEqual(first.status, "ready");
    const before = probes;
    yield* instance.snapshot.refresh;
    yield* enriched;
    assert.strictEqual(probes, before + 1);
    host.HOME = "/profile/two";
    yield* instance.snapshot.refresh;
    yield* enriched;
    assert.strictEqual(probes, before + 3);
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

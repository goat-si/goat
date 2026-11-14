import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { OpenCodeDriver } from "./driver.ts";

const reachedServer = (operation: string) =>
  Effect.fail(new OpenCodeRuntime.OpenCodeRuntimeError({ operation, detail: "reached server" }));
const openCode2Runtime = {} as OpenCodeRuntime.OpenCodeRuntime["Service"];
const noHttp = HttpClient.make(() => Effect.die("unexpected HTTP"));
const create = (_config: object, http: HttpClient.HttpClient) =>
  OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make("opencode-test"),
    displayName: undefined,
    environment: [],
    enabled: true,
    config: OpenCodeDriver.defaultConfig(),
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer(),
  Layer.succeed(HostProcess.HomeDirectory, "/fixture/opencode-test"),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, openCode2Runtime),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("OpenCode workspace environment", (it) => {
  it.effect("status probing and inventory launch share an environment when PATH changes", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const hostEnvironment = { PATH: "/old", HOME: "/fixture/opencode-test" };
      const launched: string[] = [];
      let armed = false;
      let probeCount = 0;
      const runtime = {
        ...openCode2Runtime,
        runOpenCodeCommand: ({ environment }: { readonly environment?: NodeJS.ProcessEnv }) =>
          !armed
            ? reachedServer("initial probe")
            : Effect.gen(function* () {
                launched.push(environment?.PATH ?? "");
                probeCount++;
                if (probeCount === 2) {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(resume);
                }
                return { stdout: "1.18.32", stderr: "", code: 0 };
              }),
        startOpenCodeServerProcess: ({
          environment,
        }: {
          readonly environment?: NodeJS.ProcessEnv;
        }) =>
          Effect.sync(() => launched.push(environment?.PATH ?? "")).pipe(
            Effect.andThen(reachedServer("inventory")),
          ),
      };
      const instance = yield* create({}, noHttp).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
        Effect.provideService(HostProcess.Environment, hostEnvironment),
        Effect.provide(TestProviderHost.layer({ runBackgroundWork: false })),
      );
      yield* instance.snapshot.refresh;
      yield* instance.snapshot.resolveMaintenance();
      armed = true;
      const work = yield* instance.snapshot.refresh.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      hostEnvironment.PATH = "/new";
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(work);
      assert.isAbove(launched.length, 1);
      assert.deepStrictEqual([...new Set(launched)], ["/old"]);
    }),
  );

  it.effect("workspace probing and launch share an environment when PATH changes", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const hostEnvironment = { PATH: "/old", HOME: "/fixture/opencode-test" };
      const launched: string[] = [];
      let armed = false;
      const runtime = {
        ...openCode2Runtime,
        runOpenCodeCommand: ({ environment }: { readonly environment?: NodeJS.ProcessEnv }) =>
          !armed
            ? reachedServer("initial probe")
            : Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.as({
                  stdout: environment?.PATH === "/old" ? "1.18.32" : "2.0.18",
                  stderr: "",
                  code: 0,
                }),
              ),
        startOpenCodeServerProcess: ({
          environment,
        }: {
          readonly environment?: NodeJS.ProcessEnv;
        }) =>
          Effect.sync(() => launched.push(environment?.PATH ?? "")).pipe(
            Effect.andThen(reachedServer("workspace")),
          ),
      };
      const instance = yield* create({}, noHttp).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
        Effect.provideService(HostProcess.Environment, hostEnvironment),
        Effect.provide(TestProviderHost.layer({ runBackgroundWork: false })),
      );
      yield* instance.snapshot.refresh;
      yield* instance.snapshot.resolveMaintenance();
      armed = true;
      const work = yield* instance.snapshotForCwd!("/workspace").pipe(
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      hostEnvironment.PATH = "/new";
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(work);
      assert.isAbove(launched.length, 0);
      assert.deepStrictEqual([...new Set(launched)], ["/old"]);
    }),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { ProviderAdapterV2RuntimePolicy } from "@goat/provider-core/server/ProviderAdapter";
import * as PlatformError from "effect/PlatformError";
import * as HostProcess from "@goat/shared/HostProcess";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "../../../provider-testing/src/TestProviderHost.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { FxDriver } from "./driver.ts";

const layer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
);

it.layer(layer)("FxDriver", (it) => {
  it.effect("regression #3079: status reads the current host PATH while instance PATH wins", () => {
    const host = { PATH: "/old/bin", HOME: "/tmp" };
    const paths: Array<string | undefined> = [];
    let failSpawn = false;
    const spawner = lazyChildProcessSpawner((command) => {
      if (ChildProcess.isStandardCommand(command)) paths.push(command.options.env?.PATH);
      if (failSpawn)
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            cause: { code: "ENOENT" },
          }),
        );
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    return Effect.gen(function* () {
      const make = (override: boolean) =>
        FxDriver.create({
          instanceId: ProviderInstanceId.make(override ? "fx-override" : "fx-inherit"),
          displayName: undefined,
          enabled: true,
          environment: override
            ? [{ name: "PATH", value: "/old/bin", sensitive: false }]
            : [{ name: "TEST_VAR", value: "1", sensitive: false }],
          config: FxDriver.defaultConfig(),
        });
      const inherited = yield* make(false);
      const overridden = yield* make(true);
      host.PATH = "/new/bin";
      yield* inherited.snapshot.refresh;
      expect(paths.at(-1)).toBe("/new/bin");
      yield* overridden.snapshot.refresh;
      expect(paths.at(-1)).toBe("/old/bin");
      failSpawn = true;
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/tmp",
      });
      const launch = (instance: typeof inherited, id: string) =>
        instance.orchestrationAdapter
          .openSession({
            threadId: ThreadId.make(id),
            providerSessionId: ProviderSessionId.make(id),
            modelSelection: { instanceId: instance.instanceId, model: "default" },
            runtimePolicy,
          })
          .pipe(Effect.result);
      paths.length = 0;
      yield* launch(inherited, "inherited-session");
      expect(paths.at(-1)).toBe("/new/bin");
      yield* launch(overridden, "overridden-session");
      expect(paths.at(-1)).toBe("/old/bin");
    }).pipe(
      Effect.provideService(HostProcess.Environment, host),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.scoped,
    );
  });
});

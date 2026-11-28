import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import { createManager, layerWithHostPlatform, openInput } from "./Manager.testkit.ts";

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    McpProviderSessions.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
  { excludeTestServices: true },
)("terminal signals", (it) => {
  it.effect.each([
    ["linux", ["SIGHUP", "SIGTERM"]],
    ["win32", ["SIGTERM"]],
  ] as const)("closing a %s terminal hangs up the shell's jobs", ([platform, signals]) =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5).pipe(
        Effect.provide(layerWithHostPlatform(platform)),
      );
      yield* manager.open(openInput());
      const shell = ptyAdapter.processes[0]!;
      const terminated = yield* Deferred.make<void>();
      shell.onKill = (signal) => {
        if (signal === "SIGTERM") Deferred.doneUnsafe(terminated, Effect.void);
      };

      yield* manager.close({ threadId: "thread-1" });
      yield* Deferred.await(terminated);

      expect(shell.killSignals).toEqual(signals);
      shell.emitExit({ exitCode: 0, signal: 0 });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

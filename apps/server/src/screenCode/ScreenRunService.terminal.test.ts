import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { fixture as desktopFixture } from "./DesktopTargetHost.testkit.ts";

const invocation = {
  environmentId: EnvironmentId.make("env"),
  capabilities: new Set<"preview">(),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId: ThreadId.make("thread"),
    providerSessionId: "s",
    providerInstanceId: ProviderInstanceId.make("p"),
  },
};

it.live.each(["lock first", "stop first"])(
  "end-cell collection merges terminal causes and preserves possible input: %s",
  (order) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let notify: Parameters<
        NonNullable<ComputerUseLeases.ComputerUseLeases["Service"]["onAuthorityChange"]>
      >[0] = () => {};
      const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
        Effect.provide(
          Layer.mock(ComputerUseLeases.ComputerUseLeases)({
            proxy: undefined,
            onAuthorityChange: (listener) => {
              notify = listener;
              return () => {};
            },
            releaseForeground: () => Effect.succeed(false),
          }),
        ),
      );
      const { host } = desktopFixture({});
      const service = yield* ScreenRunService.pipe(
        Effect.provide(
          ScreenRunService.layerWithRuntime({
            leases,
            invocation: {
              command: process.execPath,
              entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
            },
            assetResolver: () => resolveScreenRuntimeAsset("dev"),
            desktopHost: {
              ...host,
              finishCell: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    Effect.fail({
                      code: order === "lock first" ? "stopped_by_person" : "screen_locked",
                      effectStarted: true,
                      nextStep: "interrupted",
                    }),
                  ),
                ),
            },
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      const pending = yield* service
        .runCell({
          runId: "run-terminal",
          turnId: "turn-terminal",
          threadId: "thread",
          environmentId: "env",
          invocation,
          source: "return 1;",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      const terminal = order === "lock first" ? "screen_locked" : "stopped_by_person";
      notify({
        kind: terminal === "screen_locked" ? "pause" : "stop",
        threadId: ThreadId.make("thread"),
        controlId: "control",
        terminal,
      });
      yield* Deferred.succeed(release, undefined);
      const answer = yield* Fiber.join(pending);
      expect(answer._tag).toBe("Failure");
      if (answer._tag === "Failure") {
        expect(answer.failure.code).toBe("stopped_by_person");
        expect(answer.failure.safety?.retryClass).toBe("never");
        expect(answer.failure.safety?.possibleCommit).toBe(true);
      }
    }),
);

it.live.each(["stopped_by_person", "screen_locked"] as const)(
  "a lease authority %s cutoff stays terminal at the screen.run boundary",
  (reason) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let trigger = () => {};
      const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
        Effect.provide(
          Layer.mock(ComputerUseLeases.ComputerUseLeases)({
            proxy: undefined,
            onAuthorityChange: (listener) => {
              trigger = () =>
                listener({
                  kind: reason === "screen_locked" ? "pause" : "stop",
                  threadId: ThreadId.make("thread"),
                  controlId: "control",
                  terminal: reason,
                });
              return () => {};
            },
            releaseForeground: () => Effect.succeed(false),
          }),
        ),
      );
      const service = yield* ScreenRunService.pipe(
        Effect.provide(
          ScreenRunService.layerWithRuntime({
            leases,
            invocation: {
              command: process.execPath,
              entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
            },
            assetResolver: () => resolveScreenRuntimeAsset("dev"),
            dispatcher: {
              availability: () => Effect.succeed([{ kind: "app", available: true }]),
              dispatch: () =>
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            },
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      const running = yield* service
        .runCell({
          runId: "run-terminal",
          turnId: "turn-terminal",
          threadId: "thread",
          environmentId: "env",
          invocation,
          source: "return await screen.list_apps();",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      trigger();
      const result = yield* Fiber.join(running);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe(reason);
        expect(result.failure.safety?.retryClass).toBe("never");
      }
    }),
);

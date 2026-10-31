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

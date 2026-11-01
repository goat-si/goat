import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { screenRunLimits } from "./ScreenRunLimits.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const context = {
  runId: "run",
  turnId: "turn",
  cellId: "cell",
  threadId: "thread",
  environmentId: "env",
  limits: screenRunLimits(),
  invocation: {
    environmentId: EnvironmentId.make("env"),
    capabilities: new Set(["preview" as const]),
    issuedAt: 0,
    requestNamespace: "test",
    client: undefined,
    thread: {
      threadId: ThreadId.make("thread"),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("provider"),
    },
    reauthorize: () => Effect.void,
  },
};
it.live("a held cell deadline preserves unknown input receipts through the service error", () =>
  Effect.gen(function* () {
    const offered = yield* Deferred.make<void>();
    const held = yield* Deferred.make<void>();
    let fireDeadline: (() => void) | undefined;
    const serviceLayer = ScreenRunService.layerWithRuntime({
      invocation: {
        command: process.execPath,
        entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
      },
      assetResolver: () => resolveScreenRuntimeAsset("dev"),
      scheduleDeadline: (run) => {
        fireDeadline = run;
        return () => {
          fireDeadline = undefined;
        };
      },
      dispatcher: {
        availability: () => Effect.succeed([{ kind: "app", available: true }]),
        dispatch: () =>
          Deferred.succeed(offered, undefined).pipe(
            Effect.flatMap(() => Deferred.await(held)),
            Effect.as({ value: true, category: "confirmed" as const, evidence: ["late"] }),
          ),
      },
    }).pipe(Layer.provide(NodeServices.layer));
    return yield* Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const running = yield* service
        .runCell({
          runId: "run",
          turnId: "turn",
          threadId: "thread",
          environmentId: "env",
          invocation: context.invocation,
          source: "return await screen.launch_app({bundle_id: 'org.example.Editor'});",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(offered);
      expect(fireDeadline).toBeDefined();
      fireDeadline?.();
      const result = yield* Fiber.join(running);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "unknown_outcome",
          effectStarted: true,
          receipts: [{ dispatched: true, journalState: "unknown", category: "unknown_outcome" }],
        });
      yield* Deferred.succeed(held, undefined);
      yield* service.finishTurn({
        runId: "run",
        turnId: "turn",
        threadId: "thread",
        environmentId: "env",
        reason: "test",
      });
    }).pipe(Effect.provide(serviceLayer));
  }),
);

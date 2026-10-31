// @effect-diagnostics nodeBuiltinImport:off - The real child runs the cell; the test reads its deadline result.
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as NodeURL from "node:url";
import type { EnvironmentId, ThreadId, ProviderInstanceId } from "@goat/contracts";
import { screenRunLimits } from "./ScreenRunLimits.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { createScreenRunSupervisor } from "./ScreenRunSupervisor.ts";

const context = (limits: ReturnType<typeof screenRunLimits>) => ({
  runId: "r",
  turnId: "t",
  cellId: "one",
  threadId: "thread",
  environmentId: "env",
  limits,
  invocation: {
    environmentId: "env" as EnvironmentId,
    capabilities: new Set<"preview">(),
    issuedAt: 0,
    requestNamespace: "test",
    thread: {
      threadId: "thread" as ThreadId,
      providerSessionId: "s",
      providerInstanceId: "p" as ProviderInstanceId,
    },
    client: undefined,
  },
});

const supervisorFor = (
  asset: { path: string; sha256: string },
  limits: ReturnType<typeof screenRunLimits>,
  hostBridge: ScreenHostBridge,
) =>
  createScreenRunSupervisor({
    asset,
    limits,
    hostBridge,
    // Only the child's own wall limit ends the cell, never the supervisor's backstop timer.
    scheduleDeadline: () => () => {},
    invocation: {
      command: process.execPath,
      entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
    },
    // The supervisor callback enters Effect from a child-process event listener.
    // oxlint-disable-next-line goat/no-manual-effect-runtime-in-tests
    runCallback: (effect, signal) => Effect.runPromise(effect, signal ? { signal } : undefined),
  });

it.live("a cell that reaches its deadline still returns the calls it finished", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const offered = yield* Deferred.make<void>();
    let presses = 0;
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: (call) =>
        call.method === "bind_app"
          ? Effect.succeed({
              value: {
                id: "window",
                kind: "app",
                environmentId: "env",
                runId: "r",
                turnId: "t",
                generation: 1,
              },
              category: "unverifiable" as const,
            })
          : ++presses === 1
            ? Effect.succeed({ category: "confirmed" as const, evidence: ["driver:acted"] })
            : Deferred.succeed(offered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const supervisor = supervisorFor(asset, limits, bridge);
    const warmup = yield* supervisor.runCell(
      { runId: "r", turnId: "t", context: { ...context(limits), cellId: "warmup" } },
      "return 1;",
      false,
    );
    expect(warmup.status).toBe("completed");
    expect(warmup.value).toBe(1);
    const result = yield* supervisor.runCell(
      { runId: "r", turnId: "t", context: context(limits) },
      "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.press('Escape'); await app.press('Escape'); return true;",
      false,
    );
    expect(result.status).toBe("deadline");
    expect(result.value).toEqual({ partial: [expect.objectContaining({ call: "press" })] });
    yield* Effect.sync(supervisor.dispose);
  }),
);

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeUrl from "node:url";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const invocation = {
  environmentId: "env" as EnvironmentId,
  capabilities: new Set<"preview">(),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId: "thread" as ThreadId,
    providerSessionId: "s",
    providerInstanceId: "p" as ProviderInstanceId,
  },
};

it.effect(
  "the service layer starts without WASM and the first cell fails runtime_unavailable",
  () =>
    Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service
        .runCell({
          runId: "r",
          turnId: "t",
          threadId: "thread",
          environmentId: "env",
          invocation,
          source: "return 1;",
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe("runtime_unavailable");
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          invocation: { command: process.execPath, entrypoint: "/tmp/goat-screen-test-entry.ts" },
          assetResolver: () =>
            resolveScreenRuntimeAsset("dev", {
              devPath: "/tmp/goat-screen-missing/quickjs.wasm",
            }),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
);

it.live("a later cell uses the renewed invocation for preview reauthorization", () =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation,
      source: "return 1;",
    });
    const renewed = {
      ...invocation,
      capabilities: new Set(["preview" as const]),
      reauthorize: () => Effect.void,
    };
    const source = `return await screen.click({targetRef: ${JSON.stringify({
      id: "target",
      kind: "tab",
      environmentId: "env",
      runId: "r",
      turnId: "t",
      generation: 0,
    })}});`;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: renewed,
      source,
    });
    expect(result.value).toBe(true);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        invocation: {
          command: process.execPath,
          entrypoint: NodeUrl.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
        dispatcher: {
          availability: () => Effect.succeed([{ kind: "tab", available: true }]),
          dispatch: () =>
            Effect.succeed({ value: true, category: "confirmed", evidence: ["observation:o"] }),
        },
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  ),
);

it.live("asset failure is retried and a successful load is cached", () => {
  let attempts = 0;
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const request = {
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation,
      source: "return 1;",
    };
    const first = yield* service.runCell(request).pipe(Effect.result);
    expect(first._tag).toBe("Failure");
    const second = yield* service.runCell(request);
    const third = yield* service.runCell(request);
    expect(second.value).toBe(1);
    expect(third.value).toBe(1);
    expect(attempts).toBe(2);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        invocation: {
          command: process.execPath,
          entrypoint: NodeUrl.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () =>
          ++attempts === 1
            ? resolveScreenRuntimeAsset("dev", { devPath: "/tmp/goat-screen-missing/quickjs.wasm" })
            : resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

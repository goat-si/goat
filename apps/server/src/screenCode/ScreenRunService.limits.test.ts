import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
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

it.live(
  "a call past the pendingCalls limit is refused unsent with the limit it hit, while the admitted calls still answer",
  () =>
    Effect.gen(function* () {
      let admitted = 0;
      const fourth = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();
      const serviceLayer = ScreenRunService.layerWithRuntime({
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
        dispatcher: {
          availability: () => Effect.succeed([{ kind: "app", available: true }]),
          dispatch: () =>
            Effect.suspend(() =>
              ++admitted === 4 ? Deferred.succeed(fourth, undefined) : Effect.void,
            ).pipe(
              Effect.andThen(Deferred.await(held)),
              Effect.as({ value: [], category: "confirmed" as const }),
            ),
        },
      }).pipe(Layer.provide(NodeServices.layer));
      return yield* Effect.gen(function* () {
        const service = yield* ScreenRunService;
        const request = {
          runId: "run",
          turnId: "turn",
          threadId: "thread",
          environmentId: "env",
          invocation,
        };
        const cell = yield* service
          .runCell({
            ...request,
            source: `const held = Array.from({ length: 4 }, () => screen.list_apps());
const fifth = await screen.list_apps().then(() => null, (error) => ({ name: error.name, code: error.code, message: error.message, nothingSent: error.nothingSent, limit: error.limit }));
await Promise.all(held);
return fifth;`,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(fourth);
        yield* Deferred.succeed(held, undefined);
        const result = yield* Fiber.join(cell);
        expect(result.value).toMatchObject({
          name: "ScreenError",
          code: "pending_limit",
          nothingSent: true,
          limit: { name: "pendingCalls", maximum: 4 },
        });
        expect((result.value as { message: string }).message).toContain("pendingCalls limit 4");
        expect(admitted).toBe(4);
        yield* service.finishTurn({ ...request, reason: "test" });
      }).pipe(Effect.provide(serviceLayer));
    }),
);

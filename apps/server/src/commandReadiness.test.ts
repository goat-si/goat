import { assert, it } from "@effect/vitest";
import { GOAT_ENVIRONMENT_PATH, LEGACY_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import { WS_METHODS } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup, RpcTest } from "effect/rpc";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { layerCommandReadiness } from "./commandReadiness.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as PersistenceOwner from "./persistence/PersistenceRecoveryOwner.ts";
import { RpcInstrumentation, rpcInstrumentationLayer } from "./observability/RpcInstrumentation.ts";

it.effect(
  "answers the environment descriptor before commands are ready and holds other routes",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void, ServerRuntimeStartup.ServerRuntimeStartupError>();
      const app = Layer.mergeAll(
        HttpRouter.add("GET", GOAT_ENVIRONMENT_PATH, HttpServerResponse.text("descriptor")),
        HttpRouter.add("GET", LEGACY_ENVIRONMENT_PATH, HttpServerResponse.text("descriptor")),
        HttpRouter.add("GET", "/api/other", HttpServerResponse.text("other")),
      ).pipe(
        Layer.provide(layerCommandReadiness),
        Layer.provideMerge(
          Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, {
            awaitCommandReady: Deferred.await(ready),
            markHttpListening: Effect.void,
            enqueueCommand: (effect) => effect,
          }),
        ),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
      const get = (path: string) =>
        Effect.promise(async () => {
          const response = await handler(new Request(`http://127.0.0.1${path}`), Context.empty());
          return { status: response.status, body: await response.text() };
        });
      yield* Effect.gen(function* () {
        const other = yield* Effect.forkChild(get("/api/other"));
        // A launcher trial stays parked until its smoke probe reads the descriptor.
        for (const path of [GOAT_ENVIRONMENT_PATH, LEGACY_ENVIRONMENT_PATH]) {
          assert.deepStrictEqual(yield* get(path), { status: 200, body: "descriptor" });
        }
        assert.isUndefined(other.pollUnsafe(), "other routes wait for command readiness");
        yield* Deferred.succeed(ready, undefined);
        assert.deepStrictEqual(yield* Fiber.join(other), { status: 200, body: "other" });
      }).pipe(Effect.ensuring(Effect.promise(() => dispose())));
    }),
);

it.effect("returns a clear fatal 503 for HTTP requests including launcher descriptors", () =>
  Effect.gen(function* () {
    const captured =
      yield* Deferred.make<
        NonNullable<Context.Service.Shape<typeof PersistenceOwner.PersistenceRecoveryOwner>>
      >();
    yield* PersistenceOwner.run(
      Effect.gen(function* () {
        const owner = yield* PersistenceOwner.PersistenceRecoveryOwner;
        yield* Deferred.succeed(captured, owner!);
        return yield* Effect.never;
      }),
      { armHardExit: () => {}, exit: () => {} },
    ).pipe(Effect.exit, Effect.forkChild);
    const owner = yield* Deferred.await(captured);
    let mutations = 0;
    const app = Layer.mergeAll(
      HttpRouter.add("GET", GOAT_ENVIRONMENT_PATH, HttpServerResponse.text("descriptor")),
      HttpRouter.add(
        "POST",
        "/api/mutate",
        Effect.sync(() => {
          mutations++;
          return HttpServerResponse.empty();
        }),
      ),
    ).pipe(
      Layer.provide(layerCommandReadiness),
      Layer.provideMerge(Layer.succeed(PersistenceOwner.PersistenceRecoveryOwner, owner)),
      Layer.provideMerge(
        Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, {
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          enqueueCommand: (effect) => effect,
        }),
      ),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
    yield* Effect.gen(function* () {
      owner.report(new Error("writer failed"));
      for (const [method, path] of [
        ["GET", GOAT_ENVIRONMENT_PATH],
        ["POST", "/api/mutate"],
      ] as const) {
        const response = yield* Effect.promise(() =>
          handler(new Request(`http://local${path}`, { method }), Context.empty()),
        );
        assert.equal(response.status, 503);
        assert.include(
          yield* Effect.promise(() => response.text()),
          "Server persistence failed permanently",
        );
      }
      assert.equal(mutations, 0);
    }).pipe(Effect.ensuring(Effect.promise(() => dispose())));
  }).pipe(Effect.scoped),
);

it.effect("existing RPC clients receive a fatal defect before any further handler runs", () =>
  Effect.gen(function* () {
    const captured =
      yield* Deferred.make<
        NonNullable<Context.Service.Shape<typeof PersistenceOwner.PersistenceRecoveryOwner>>
      >();
    yield* PersistenceOwner.run(
      Effect.gen(function* () {
        const owner = yield* PersistenceOwner.PersistenceRecoveryOwner;
        yield* Deferred.succeed(captured, owner!);
        return yield* Effect.never;
      }),
      { armHardExit: () => {}, exit: () => {} },
    ).pipe(Effect.exit, Effect.forkChild);
    const owner = yield* Deferred.await(captured);
    let mutations = 0;
    const group = RpcGroup.make(
      Rpc.make(WS_METHODS.serverUpdateSettings, { success: Schema.Number }),
    ).middleware(RpcInstrumentation);
    const handlers = group.toLayer({
      [WS_METHODS.serverUpdateSettings]: () => Effect.sync(() => ++mutations),
    });
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(handlers, rpcInstrumentationLayer)),
      Effect.provideService(PersistenceOwner.PersistenceRecoveryOwner, owner),
    );
    assert.equal(yield* client[WS_METHODS.serverUpdateSettings](), 1);
    owner.report(new Error("writer failed"));
    const cause = yield* client[WS_METHODS.serverUpdateSettings]().pipe(Effect.flip, Effect.exit);
    assert.equal(cause._tag, "Failure");
    if (cause._tag === "Failure")
      assert.include(Cause.pretty(cause.cause), "Server persistence failed permanently");
    assert.equal(mutations, 1);
  }).pipe(Effect.scoped),
);

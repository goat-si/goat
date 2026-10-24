import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc";

import { WS_RPC_SERVER_OPTIONS } from "../ws.ts";
import * as DefectReporter from "./DefectReporter.ts";

class TestRpcs extends RpcGroup.make(
  Rpc.make("subscribe", { success: Schema.Number, stream: true }),
  Rpc.make("boom", { success: Schema.Void }),
) {}
type TestRpc = RpcGroup.Rpcs<typeof TestRpcs>;

const withErrorLogs = <A, E, R>(
  body: (logs: Queue.Queue<Cause.Cause<unknown>>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logs = yield* Queue.unbounded<Cause.Cause<unknown>>();
    const logger = Logger.make(({ cause, logLevel }) => {
      if (logLevel === "Error") Queue.offerUnsafe(logs, cause);
    });
    return yield* body(logs).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  });

const errorMessage = (cause: Cause.Cause<unknown>) => (Cause.squash(cause) as Error).message;

describe("DefectReporter", () => {
  it.effect("logs a defect's message without its credentials or fields (#1388)", () =>
    withErrorLogs((logs) =>
      Effect.gen(function* () {
        // Synthetic canaries; neither is a real credential.
        const defect = Object.assign(new Error("handler bug: Cookie: sid=canary-cookie-value"), {
          headers: { authorization: "Bearer canary-field-token-0123456789" },
        });
        yield* ErrorReporter.report(Cause.die(defect)).pipe(Effect.provide(DefectReporter.layer));

        const logged = yield* Queue.take(logs);
        const printed = Cause.pretty(logged);
        assert.include(printed, "handler bug");
        assert.notInclude(printed, "canary-cookie-value");
        assert.notProperty(Cause.squash(logged), "headers");
      }),
    ),
  );

  it.effect("logs a defect whose cause cannot be inspected", () =>
    withErrorLogs((logs) =>
      Effect.gen(function* () {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        yield* ErrorReporter.report(
          Cause.die(new Error("original failure", { cause: proxy })),
        ).pipe(Effect.provide(DefectReporter.layer));

        assert.include(Cause.pretty(yield* Queue.take(logs)), "original failure");
      }),
    ),
  );

  it.effect("logs a defect whose reason metadata cannot be inspected", () =>
    withErrorLogs((logs) =>
      Effect.gen(function* () {
        const { proxy, revoke } = Proxy.revocable(new Map(), {});
        revoke();
        const reason = Cause.makeDieReason(new Error("original failure"));
        Object.defineProperty(reason, "annotations", { value: proxy });
        yield* ErrorReporter.report(Cause.fromReasons([reason])).pipe(
          Effect.provide(DefectReporter.layer),
        );

        assert.include(Cause.pretty(yield* Queue.take(logs)), "original failure");
      }),
    ),
  );

  it.effect(
    "reads a reported cause without running its list's iterator or a reason's getters",
    () =>
      withErrorLogs((logs) =>
        Effect.gen(function* () {
          const forged = [Cause.makeDieReason(new Error("original failure"))];
          Object.defineProperty(forged, Symbol.iterator, {
            value: () => {
              throw new Error("iterator must not run");
            },
          });
          const getterReason = Cause.makeDieReason(new Error("second failure"));
          Object.defineProperty(getterReason, "_tag", {
            get: () => {
              throw new Error("getter must not run");
            },
          });
          yield* ErrorReporter.report(Cause.fromReasons(forged)).pipe(
            Effect.provide(DefectReporter.layer),
          );
          yield* ErrorReporter.report(Cause.fromReasons([getterReason])).pipe(
            Effect.provide(DefectReporter.layer),
          );

          assert.include(Cause.pretty(yield* Queue.take(logs)), "original failure");
          // A reason whose kind cannot be read is still reported, as an uninspectable defect.
          assert.include(Cause.pretty(yield* Queue.take(logs)), "[uninspectable]");
        }),
      ),
  );

  it.effect("logs a defect without the reporting fiber's raw log annotations or spans", () =>
    Effect.gen(function* () {
      const records = yield* Queue.unbounded<string>();
      const logger = Logger.make(({ fiber }) => {
        const spans = fiber.getRef(References.CurrentLogSpans).map(([label]) => label);
        Queue.offerUnsafe(
          records,
          JSON.stringify([fiber.getRef(References.CurrentLogAnnotations), spans]),
        );
      });
      // Synthetic canaries in the context the defect is reported from.
      yield* ErrorReporter.report(Cause.die(new Error("boom"))).pipe(
        Effect.provide(DefectReporter.layer),
        Effect.annotateLogs({ authorization: "Bearer canary-annotation-0123456789" }),
        Effect.withLogSpan("token=canary-span"),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      );

      const record = yield* Queue.take(records);
      assert.include(record, "authorization");
      assert.notInclude(record, "canary-annotation");
      assert.notInclude(record, "canary-span");
    }),
  );

  it.effect("reports a defect that follows many typed failures, and honors inherited ignore", () =>
    withErrorLogs((logs) =>
      Effect.gen(function* () {
        class Expected extends Error {}
        Object.defineProperty(Expected.prototype, ErrorReporter.ignore, { value: true });
        const failures = Array.from({ length: 16 }, (_, index) =>
          Cause.makeFailReason(new Error(`typed ${index}`)),
        );
        const report = (cause: Cause.Cause<unknown>) =>
          ErrorReporter.report(cause).pipe(Effect.provide(DefectReporter.layer));
        yield* report(Cause.die(new Expected("expected failure")));
        yield* report(
          Cause.fromReasons([...failures, Cause.makeDieReason(new Error("only defect"))]),
        );

        // The ignored defect logs nothing, so the first record is the defect after the failures.
        assert.equal(errorMessage(yield* Queue.take(logs)), "only defect");
        assert.equal(yield* Queue.size(logs), 0);
      }),
    ),
  );

  it.effect("a dying RPC handler fails alone, and its defect is logged", () =>
    withErrorLogs((logs) =>
      Effect.gen(function* () {
        const subscription = yield* Queue.unbounded<number>();
        let client!: Effect.Success<
          ReturnType<typeof RpcClient.makeNoSerialization<TestRpc, never>>
        >;
        const server = yield* RpcServer.makeNoSerialization(TestRpcs, {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) => client.write(response),
        }).pipe(
          Effect.provide(
            TestRpcs.toLayer({
              subscribe: () => Stream.fromQueue(subscription),
              boom: () => Effect.die(new Error("handler bug")),
            }).pipe(Layer.provide(DefectReporter.layer)),
          ),
        );
        client = yield* RpcClient.makeNoSerialization(TestRpcs, {
          supportsAck: true,
          onFromClient: ({ message }) => server.write(0, message),
        });

        const received = yield* Queue.unbounded<number>();
        const sibling = yield* client.client.subscribe().pipe(
          Stream.runForEach((value) => Queue.offer(received, value)),
          Effect.forkScoped,
        );
        yield* Queue.offer(subscription, 1);
        assert.equal(yield* Queue.take(received), 1);

        const boom = yield* Effect.exit(client.client.boom());
        assert.isTrue(Exit.hasDies(boom));
        const logged = yield* Queue.clear(logs);
        assert.deepEqual(logged.map(errorMessage), ["handler bug"]);

        yield* Queue.offer(subscription, 2);
        const next = yield* Queue.take(received).pipe(
          Effect.raceFirst(Fiber.await(sibling).pipe(Effect.as("subscription ended"))),
        );
        assert.equal(next, 2);
        assert.equal(yield* Queue.size(logs), 0);
      }),
    ).pipe(Effect.scoped),
  );
});

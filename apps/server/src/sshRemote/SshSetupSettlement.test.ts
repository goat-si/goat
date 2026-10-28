import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type { SshHostResult } from "@goat/contracts";
import * as Dispatch from "./SshRemoteDispatch.ts";
import * as Settlement from "./SshSetupSettlement.ts";
import { prepareFixture } from "./testkit/SshHostPrepareFixture.ts";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

it.effect.each(["before", "after", "publication", "interrupted"] as const)(
  "settles prepare on unexpected exit (%s)",
  (mode) => prepareSettlementRegression(mode).pipe(Effect.scoped),
);

it.effect.each(["success", "interrupted"] as const)(
  "an already-settled %s exit preserves its response without publishing a failure",
  (mode) =>
    Effect.gen(function* () {
      const result: SshHostResult = { kind: "error", code: "cancelled", message: "Forgotten" };
      const first = yield* Deferred.make<SshHostResult>();
      yield* Deferred.succeed(first, result);
      const settle = yield* Settlement.make.pipe(
        Effect.provide(
          Layer.mock(Dispatch.SshRemoteDispatch)({
            publishSetupOutcome: () => Effect.die("A retired setup must not publish"),
          }),
        ),
      );
      yield* settle(
        "box",
        { operationId: "retired", generation: 1, stage: "runtime" },
        first,
        mode === "success" ? Exit.void : Exit.interrupt(1),
      );
      expect(yield* Deferred.await(first)).toEqual(result);
    }),
);

it.effect("an unexpected successful exit settles before terminal publication", () =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<SshHostResult>();
    const settle = yield* Settlement.make.pipe(
      Effect.provide(
        Layer.mock(Dispatch.SshRemoteDispatch)({
          publishSetupOutcome: (_host, operation, outcome) =>
            Effect.gen(function* () {
              expect(operation).toEqual({
                operationId: "pending",
                generation: 7,
                stage: "runtime",
              });
              expect(outcome.kind).toBe("error");
              expect(yield* Deferred.isDone(first)).toBe(true);
              return false;
            }),
        }),
      ),
    );
    yield* settle(
      "box",
      { operationId: "pending", generation: 7, stage: "runtime" },
      first,
      Exit.void,
    );
    expect(yield* Deferred.await(first)).toMatchObject({ kind: "error", code: "operation_failed" });
  }),
);

const prepareSettlementRegression = Effect.fn("prepareSettlementRegression")(function* (
  mode: "before" | "after" | "publication" | "interrupted",
) {
  let fail = true;
  const crashed = yield* Deferred.make<void>();
  const completed = yield* Deferred.make<void>();
  const crash = Effect.suspend(() =>
    !fail
      ? Effect.void
      : (mode === "interrupted" ? Effect.interrupt : Effect.die("fixture runtime defect")).pipe(
          Effect.ensuring(Deferred.succeed(crashed, undefined)),
        ),
  );
  const f = yield* prepareFixture(
    undefined,
    mode === "after" ? Effect.void : crash,
    mode === "after" ? crash : Effect.void,
    mode === "publication" ? Effect.die("fixture publication defect") : Effect.void,
  );
  const caller = yield* f.setup.prepare({ host: "box" }, f.caller).pipe(
    Effect.tap(() => Deferred.succeed(completed, undefined)),
    Effect.forkChild,
  );
  try {
    if (mode === "after") {
      expect(yield* Fiber.join(caller)).toMatchObject({ status: { phase: "uploading" } });
      yield* Deferred.succeed(f.upload, undefined);
    }
    yield* Deferred.await(crashed);
    yield* TestClock.adjust("0 millis");
    expect(yield* Deferred.isDone(completed)).toBe(true);
    if (mode !== "after")
      expect(yield* Fiber.join(caller)).toMatchObject({ kind: "error", code: "operation_failed" });
    if (mode === "before" || mode === "after")
      expect(yield* f.setup.status({ host: "box" })).toMatchObject({
        status: { state: "failed", setup: { stage: "complete" } },
      });
    if (mode === "before") {
      fail = false;
      expect(yield* f.setup.prepare({ host: "box" }, f.caller)).toMatchObject({
        kind: "ok",
        status: { state: "preparing", phase: "uploading" },
      });
    }
  } finally {
    yield* Fiber.interrupt(caller);
  }
});

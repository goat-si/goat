import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { makeHarness, runId } from "./adapter.testkit.ts";

it.effect("keeps the credential captured at session open for launches and reads", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    h.readKey.mockReturnValue(Effect.succeed("new-key"));
    yield* h.runtime.startTurn(h.input);
    yield* Deferred.await(h.streamStarted);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "key-fixture" }));
    yield* h.finish;
    yield* h.runtime.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    expect(h.getRun).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ apiKey: "key-fixture" }),
    );
    const next = yield* makeHarness(Effect.succeed("new-key"));
    yield* next.runtime.startTurn(next.input);
    yield* Deferred.await(next.streamStarted);
    expect(next.create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "new-key" }));
    yield* next.finish;
    yield* next.runtime.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
  }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
);

it.effect(
  "refuses a session key when the SDK backend changes, and allows matching production",
  () =>
    Effect.gen(function* () {
      const previous = process.env.CURSOR_BACKEND_URL;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.CURSOR_BACKEND_URL;
          else process.env.CURSOR_BACKEND_URL = previous;
        }),
      );
      delete process.env.CURSOR_BACKEND_URL;
      const h = yield* makeHarness();
      process.env.CURSOR_BACKEND_URL = "https://custom.invalid";
      const result = yield* h.runtime.startTurn(h.input).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(h.create).not.toHaveBeenCalled();
      process.env.CURSOR_BACKEND_URL = "https://api2.cursor.sh///";
      const matching = yield* makeHarness();
      yield* matching.runtime.startTurn(matching.input);
      yield* Deferred.await(matching.streamStarted);
      expect(matching.create).toHaveBeenCalledOnce();
      yield* matching.finish;
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
);

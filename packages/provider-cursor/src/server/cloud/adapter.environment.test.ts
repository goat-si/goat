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

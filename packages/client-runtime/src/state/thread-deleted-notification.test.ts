import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import { awaitThreadState, deleted, snapshot } from "./threadsSyncFixtures.ts";
import { BASE_PROJECTION, TARGET, THREAD_ID, makeHarness } from "./threadsSync.testkit.ts";

it.effect("notifies exactly the deleted thread when a live deletion event arrives", () =>
  Effect.gen(function* () {
    const notify = vi.fn();
    const harness = yield* makeHarness({ onThreadDeleted: notify });
    yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
    yield* awaitThreadState(harness.observed, (state) => state.status === "live");
    yield* Queue.offer(harness.inputs, deleted());
    yield* awaitThreadState(harness.observed, (state) => state.status === "deleted");
    expect(notify).toHaveBeenCalledExactlyOnceWith(TARGET.environmentId, THREAD_ID);
  }),
);

it.effect("does not report a missing thread as a deletion", () =>
  Effect.gen(function* () {
    const notify = vi.fn();
    const harness = yield* makeHarness({
      onThreadDeleted: notify,
      httpSnapshot: { _tag: "missing" },
    });
    yield* awaitThreadState(harness.observed, (state) => state.status === "deleted");
    expect(notify).not.toHaveBeenCalled();
  }),
);

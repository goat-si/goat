import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { VcsStatusLocalResult } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";

it.effect("bounds queued branch changes and keeps the newest change for a slow consumer", () => {
  let local: VcsStatusLocalResult = {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: "initial",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  };
  const layer = VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () => Effect.sync(() => local),
        currentBranch: () => Effect.sync(() => local.refName),
        invalidateLocalStatus: () => Effect.void,
      }),
    ),
  );
  return Effect.gen(function* () {
    const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const received = yield* broadcaster.streamBranchChanges.pipe(
      Stream.tap((event) =>
        event.refName === "initial"
          ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      ),
      Stream.take(257),
      Stream.runCollect,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* broadcaster.refreshLocalStatus("/repo");
    yield* Deferred.await(started);
    for (let i = 0; i < 300; i++) {
      local = Object.assign({}, local, { refName: `branch-${i}` });
      yield* broadcaster.refreshLocalStatus("/repo");
    }
    yield* Deferred.succeed(release, undefined);
    const events = yield* Fiber.join(received);
    assert.equal(events.length, 257);
    assert.equal(events[0]?.refName, "initial");
    assert.equal(events[1]?.refName, "branch-44");
    assert.equal(events.at(-1)?.refName, "branch-299");
  }).pipe(Effect.provide(layer), Effect.scoped);
});

import { penLeftMesh, penStateDir, watchPenSnapshots } from "@goat/pen-protocol/snapshot";
import * as HostProcess from "@goat/shared/HostProcess";
import {
  followPenMembership,
  type PenMembershipSource,
  type PenMembershipView,
} from "@goat/ssh/penMembershipWatch";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * This server's one watch on its local Pen membership, shared by everything that follows it, so
 * the server holds one of Pen's eight watcher slots. Independent of the Pen trust root, the
 * target gate and every setting: it only reports, and nothing may authorize from what it reports.
 */
export class PenMembershipWatch extends Context.Service<
  PenMembershipWatch,
  {
    /** The view as of this instant: set inside the watch callback, ahead of `changes`. */
    readonly current: Effect.Effect<PenMembershipView>;
    /** The latest view, then each later one. A slow reader sees only the newest. */
    readonly changes: Stream.Stream<PenMembershipView>;
  }
>()("goat/pen/PenMembershipWatch") {}

export const make = Effect.fn("PenMembershipWatch.make")(function* (source: PenMembershipSource) {
  let current: PenMembershipView = { kind: "unavailable", reason: "stale" };
  const published = yield* SubscriptionRef.make<PenMembershipView>(current);
  yield* followPenMembership(
    source,
    (view) => {
      current = view;
    },
    (view) => SubscriptionRef.set(published, view),
  ).pipe(Effect.forkScoped);
  return PenMembershipWatch.of({
    current: Effect.sync(() => current),
    changes: SubscriptionRef.changes(published),
  });
});

export const layer = Layer.effect(
  PenMembershipWatch,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* HostProcess.HomeDirectory;
    const env = yield* HostProcess.Environment;
    return yield* make({
      stateDir: penStateDir(env, home),
      stateDirExists: (stateDir) => fs.exists(stateDir).pipe(Effect.orElseSucceed(() => false)),
      leftMesh: (stateDir) => Effect.promise(() => penLeftMesh(stateDir)),
      watch: watchPenSnapshots,
    });
  }),
);

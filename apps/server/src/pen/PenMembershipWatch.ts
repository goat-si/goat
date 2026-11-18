import { penLeftMesh, penStateDir, watchPenSnapshots } from "@goat/pen-protocol/snapshot";
import * as HostProcess from "@goat/shared/HostProcess";
import {
  followPenMembership,
  type PenMembershipSource,
  type PenMembershipView,
} from "@goat/ssh/penMembershipWatch";
import * as Context from "effect/Context";
import { ServerConfig } from "../config.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";

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
    /**
     * How many views so far closed the member list (anything but ready) and said this machine
     * left, so a reader that only saw the newest view still learns what the skipped ones ended.
     */
    readonly marks: Effect.Effect<PenMembershipMarks>;
  }
>()("goat/pen/PenMembershipWatch") {}

export interface PenMembershipMarks {
  readonly closed: number;
  readonly left: number;
}

export const make = Effect.fn("PenMembershipWatch.make")(function* (source: PenMembershipSource) {
  let current: PenMembershipView = { kind: "unavailable", reason: "stale" };
  const marks = { closed: 0, left: 0 };
  // One view per reader, newest wins: a reader that falls behind never holds a backlog.
  const published = yield* PubSub.sliding<PenMembershipView>({ capacity: 1, replay: 1 });
  yield* PubSub.publish(published, current);
  yield* followPenMembership(
    source,
    (view) => {
      if (view.kind !== "ready") marks.closed += 1;
      if (view.kind === "not-member") marks.left += 1;
      current = view;
    },
    (view) => PubSub.publish(published, view).pipe(Effect.asVoid),
  ).pipe(Effect.forkScoped);
  return PenMembershipWatch.of({
    current: Effect.sync(() => current),
    changes: Stream.fromPubSub(published),
    marks: Effect.sync(() => ({ ...marks })),
  });
});

export const layer = Layer.effect(
  PenMembershipWatch,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* HostProcess.HomeDirectory;
    const env = yield* HostProcess.Environment;
    const config = yield* ServerConfig;
    // Pen admits eight watchers per machine, and a dev server that refuses ssh reaches no member.
    const devWithoutSsh = config.devUrl !== undefined && env.GOAT_DEV_SSH !== "on";
    return yield* make({
      stateDir: devWithoutSsh ? undefined : penStateDir(env, home),
      stateDirExists: (stateDir) => fs.exists(stateDir).pipe(Effect.orElseSucceed(() => false)),
      leftMesh: (stateDir) => Effect.promise(() => penLeftMesh(stateDir)),
      watch: watchPenSnapshots,
    });
  }),
);

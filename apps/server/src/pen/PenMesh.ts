// @effect-diagnostics nodeBuiltinImport:off -- the watch runs on Pen's control socket.
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { PenId } from "@goat/contracts";
import { guardErrors } from "@goat/shared/errorGuards";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { lineReader } from "./penHandshake.ts";

/** A snapshot line holds every member with its host keys; this bounds one line. */
export const PEN_SNAPSHOT_LINE_CAP = 1 << 20;

const SnapshotMember = Schema.Struct({
  nodeId: PenId,
  signPub: Schema.String,
  noisePub: Schema.String,
  name: Schema.String,
});
const Snapshot = Schema.Struct({
  t: Schema.Literal("snapshot"),
  gen: Schema.Number,
  mesh: PenId,
  self: PenId,
  members: Schema.Array(SnapshotMember),
});
export type PenSnapshot = typeof Snapshot.Type;
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot));

export class PenWatchEnded extends Data.TaggedError("PenWatchEnded")<{ readonly reason: string }> {}

/**
 * Follows Pen's member list through the control op watch.snapshot (pen-protocol CONTRACT
 * "Snapshot watch") until the watch ends, closes or skips a generation; each of those means the list
 * is stale and the caller watches again. Nothing may authorize from this list: GOAT uses it only to
 * notice a changed mesh and to withdraw what departed members held.
 */
export const watchSnapshots = Effect.fn("PenMesh.watchSnapshots")(function* (
  stateDir: string,
  onSnapshot: (snapshot: PenSnapshot) => Effect.Effect<void>,
) {
  const socket = yield* Effect.acquireRelease(
    Effect.callback<NodeNet.Socket, PenWatchEnded>((resume) => {
      const connection = guardErrors(
        NodeNet.createConnection(NodePath.join(stateDir, "control.sock")),
        (error) => resume(Effect.fail(new PenWatchEnded({ reason: error.message }))),
      );
      connection.once("connect", () => resume(Effect.succeed(connection)));
    }),
    (connection) => Effect.sync(() => connection.destroy()),
  );
  const reader = lineReader(socket);
  socket.write('{"op":"watch.snapshot"}\n');
  let previous: number | undefined;
  for (;;) {
    const line = yield* reader
      .read(PEN_SNAPSHOT_LINE_CAP)
      .pipe(Effect.mapError(() => new PenWatchEnded({ reason: "the watch closed" })));
    const snapshot = yield* decodeSnapshot(line.toString("utf8")).pipe(
      Effect.mapError(
        () => new PenWatchEnded({ reason: "Pen sent a line that is not a snapshot" }),
      ),
    );
    if (previous !== undefined && snapshot.gen !== previous + 1)
      return yield* new PenWatchEnded({ reason: "the watch skipped a generation" });
    previous = snapshot.gen;
    yield* onSnapshot(snapshot);
  }
});

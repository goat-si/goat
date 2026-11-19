import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";

/**
 * What this server last settled about its own Pen membership, kept across restarts: the mesh and
 * node it was a member as, or a departure whose revocation had not finished. Without it a restart
 * between leaving and revoking would forget the departure.
 */
export const PenDepartureRecord = Schema.Union([
  Schema.Struct({ left: Schema.Literal(true) }),
  Schema.Struct({ mesh: Schema.String, self: Schema.String }),
]);
export type PenDepartureRecord = typeof PenDepartureRecord.Type;

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(PenDepartureRecord));
const encode = Schema.encodeEffect(Schema.fromJsonString(PenDepartureRecord));

export const make = Effect.fn("PenDepartureRecord.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join((yield* ServerConfig).stateDir, "pen-member-sessions.json");
  // Written atomically, so a damaged file came from outside GOAT; like no file, it revokes nothing.
  const initial = yield* fs.readFileString(file).pipe(
    Effect.flatMap(decode),
    Effect.tapError((error) =>
      error._tag === "PlatformError" && error.reason._tag === "NotFound"
        ? Effect.void
        : Effect.logWarning("pen.memberSessions.record.unreadable", error),
    ),
    Effect.option,
  );
  /** Undefined removes the record. A failed write leaves this run correct, only a restart blind. */
  const write = Effect.fn("PenDepartureRecord.write")(function* (
    record: PenDepartureRecord | undefined,
  ) {
    yield* (
      record === undefined
        ? fs.remove(file, { force: true })
        : encode(record).pipe(
            Effect.flatMap((contents) => writeFileStringAtomically({ filePath: file, contents })),
          )
    ).pipe(
      Effect.catchCause((cause) => Effect.logWarning("pen.memberSessions.record.failed", cause)),
    );
  });
  return { initial: Option.getOrUndefined(initial), write };
});

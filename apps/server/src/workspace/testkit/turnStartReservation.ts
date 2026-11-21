import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import { reserveTurnStart } from "../checkpointRestoreReservation.ts";

/**
 * Runs a turn startup unless a file restore overlaps cwd: None then, without running, so the
 * start goes back to the outbox retry instead of holding an effect worker. Startups never
 * exclude each other.
 */
export const tryTurnStartReservation = <A, E, R>(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E, R> =>
  Effect.scoped(
    Effect.flatMap(reserveTurnStart(fileSystem, path, cwd), (reserved) =>
      reserved ? Effect.asSome(effect) : Effect.succeed(Option.none<A>()),
    ),
  );

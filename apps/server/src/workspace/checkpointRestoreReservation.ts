import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

// A restore rewrites files under its directory, so it must exclude provider startup in any
// overlapping workspace: symlink aliases, parents, and children. Kept apart from the folder lease,
// which is exact-path and held by restores already. Process-local: another GOAT server on this
// machine is excluded only for the same worktree, through the lease's claim.
interface Reservation {
  readonly cwd: string;
  readonly kind: "restore" | "turn-start";
}

const reservations = new Set<Reservation>();
let reservationReleased = Deferred.makeUnsafe<void>();

// path.relative folds win32 drive-letter case and treats a POSIX backslash as part of a name.
const contains = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const conflicts = (path: Path.Path, a: Reservation, b: Reservation) =>
  (a.kind === "restore" || b.kind === "restore") &&
  (contains(path, a.cwd, b.cwd) || contains(path, b.cwd, a.cwd));

const conflicting = (path: Path.Path, reservation: Reservation) =>
  [...reservations].some((held) => conflicts(path, held, reservation));

const reserve = (path: Path.Path, reservation: Reservation): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (conflicting(path, reservation))
      return Deferred.await(reservationReleased).pipe(Effect.andThen(reserve(path, reservation)));
    reservations.add(reservation);
    return Effect.void;
  });

const release = (reservation: Reservation) =>
  Effect.sync(() => {
    if (!reservations.delete(reservation)) return;
    const released = reservationReleased;
    reservationReleased = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(released, Effect.void);
  });

// A worktree removed by storage cleanup is recreated inside the reserved section, so resolve its
// nearest existing ancestor: a symlink alias above it must still canonicalize the same on both
// sides. Walks at most the path depth.
const canonicalize = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
): Effect.Effect<string> =>
  fileSystem.realPath(target).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => {
      const parent = path.dirname(target);
      return parent === target
        ? Effect.succeed(target)
        : canonicalize(fileSystem, path, parent).pipe(
            Effect.map((resolved) => path.join(resolved, path.basename(target))),
          );
    }),
    Effect.orElseSucceed(() => target),
  );

/** Exclusive over every overlapping workspace while checkpoint files are restored. */
export const withCheckpointRestoreReservation = <A, E, R>(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  canonicalize(fileSystem, path, cwd).pipe(
    Effect.flatMap((canonical) => {
      const reservation: Reservation = { cwd: canonical, kind: "restore" };
      return reserve(path, reservation).pipe(
        Effect.andThen(effect),
        Effect.ensuring(release(reservation)),
      );
    }),
  );

/**
 * Reserves cwd for a turn startup until the enclosing scope closes; false when a file restore
 * overlaps it, so the start goes back to the outbox retry. Startups never exclude each other.
 */
export const reserveTurnStart = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
): Effect.Effect<boolean, never, Scope.Scope> =>
  canonicalize(fileSystem, path, cwd).pipe(
    Effect.flatMap((canonical) => {
      const reservation: Reservation = { cwd: canonical, kind: "turn-start" };
      return Effect.acquireRelease(
        Effect.sync(() => {
          if (conflicting(path, reservation)) return false;
          reservations.add(reservation);
          return true;
        }),
        (reserved) => (reserved ? release(reservation) : Effect.void),
      );
    }),
  );

import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

/**
 * Folders held whole by a removal: no lease on the folder or anything inside it is granted while
 * one is held. Keys are compared case-insensitively except on Linux, as the volumes behave.
 */
const subtrees = new Map<string, Deferred.Deferred<void>>();
/** Subtrees this fiber holds; its own leases inside them are allowed. */
const HeldSubtrees = Context.Reference<ReadonlyArray<string>>(
  "goat/workspace/workspaceLease/HeldSubtrees",
  { defaultValue: () => [] },
);

const comparable = (folder: string, platform: NodeJS.Platform) => {
  const slashed = folder.replaceAll("\\", "/").replace(/\/+$/u, "");
  return platform === "linux" ? slashed : slashed.toLowerCase();
};
const inside = (root: string, key: string) => key === root || key.startsWith(root + "/");

/** The subtree hold covering cwd that this fiber does not hold itself, if any. */
const blockingSubtree = (cwd: string, fiber: Fiber.Fiber<unknown, unknown>) => {
  const held = fiber.getRef(HeldSubtrees);
  const key = comparable(cwd, fiber.getRef(HostProcess.Platform));
  for (const [root, released] of subtrees)
    if (inside(root, key) && !held.includes(root)) return released;
  return undefined;
};

const withLeaseSemaphore = <A, E, R>(
  cwd: string,
  use: (semaphore: Semaphore.Semaphore) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const lease = leases.get(cwd) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(cwd, lease);
    lease.users++;
    return use(lease.semaphore).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lease.users--;
          if (lease.users === 0) leases.delete(cwd);
        }),
      ),
    );
  });

/** Coordinates checkout removal and cleanup across threads using the same resolved cwd. */
export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    // Checked and registered in one synchronous step, so a subtree hold cannot slip between.
    const blocking = blockingSubtree(cwd, fiber);
    return blocking === undefined
      ? withLeaseSemaphore(cwd, (semaphore) => semaphore.withPermit(effect))
      : Deferred.await(blocking).pipe(Effect.andThen(withWorkspaceLease(cwd, effect)));
  });

/** Attempts checkout startup without keeping an effect worker waiting on another holder. */
export const tryWithWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E, R> =>
  Effect.withFiber((fiber) =>
    blockingSubtree(cwd, fiber) === undefined
      ? withLeaseSemaphore(cwd, (semaphore) => semaphore.withPermitsIfAvailable(1)(effect))
      : Effect.succeed(Option.none()),
  );

/**
 * Runs effect holding the whole folder at root: while it runs, no lease on root or inside it is
 * granted to anyone else (turn start reports busy, others wait), so a thread bound inside it
 * meanwhile cannot start writing there. None, without running, when a lease inside it is already
 * held or awaited, or another hold overlaps it. The holder may still take leases inside it.
 */
export const tryWithWorkspaceSubtree = <A, E, R>(
  root: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E, R> =>
  Effect.withFiber((fiber) => {
    const platform = fiber.getRef(HostProcess.Platform);
    const key = comparable(root, platform);
    const busy =
      [...leases.keys()].some((cwd) => inside(key, comparable(cwd, platform))) ||
      [...subtrees.keys()].some((other) => inside(other, key) || inside(key, other));
    if (busy) return Effect.succeed(Option.none());
    const released = Deferred.makeUnsafe<void>();
    subtrees.set(key, released);
    return effect.pipe(
      Effect.provideService(HeldSubtrees, [...fiber.getRef(HeldSubtrees), key]),
      Effect.map(Option.some),
      Effect.ensuring(
        Effect.suspend(() => {
          subtrees.delete(key);
          return Deferred.succeed(released, undefined);
        }),
      ),
    );
  });

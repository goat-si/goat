// @effect-diagnostics nodeBuiltinImport:off -- realpathSync resolves a folder inside the one synchronous step that admits a lease.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { claimWorkspace, type WorkspaceClaimKind } from "./workspaceLeaseRegistry.ts";

/** Another GOAT server's claims on this machine could not be checked, so the folder stays untouched. */
export class WorkspaceLeaseUnavailableError extends Schema.TaggedError<WorkspaceLeaseUnavailableError>()(
  "WorkspaceLeaseUnavailableError",
  { path: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `${this.path} is not available: ${this.reason}`;
  }
}

export const isWorkspaceLeaseUnavailableError = Schema.is(WorkspaceLeaseUnavailableError);

interface Lease {
  readonly semaphore: Semaphore.Semaphore;
  users: number;
  /** Where the folder really is, for comparing with folders held whole. */
  readonly canonical: string;
}

/** Leases by the cwd callers name, held or awaited while users is above zero. */
const leases = new Map<string, Lease>();
/**
 * Folders held whole by a removal, by canonical path: no lease on the folder or anything inside it
 * is granted to anyone else while one is held.
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

/**
 * The folder as the filesystem names it, so a link or alias (`/var` for `/private/var`) meets
 * the folder it points into: links are resolved through its nearest existing ancestor.
 */
const canonical = (folder: string, platform: NodeJS.Platform) => {
  const absolute = NodePath.resolve(folder);
  const rest: Array<string> = [];
  for (let existing = absolute; ;) {
    try {
      const real = NodeFS.realpathSync.native(existing);
      return comparable(
        rest.length === 0 ? real : NodePath.join(real, ...rest.toReversed()),
        platform,
      );
    } catch {
      const parent = NodePath.dirname(existing);
      if (parent === existing) return comparable(absolute, platform);
      rest.push(NodePath.basename(existing));
      existing = parent;
    }
  }
};

type Admission =
  | { readonly kind: "admitted"; readonly cwd: string; readonly lease: Lease }
  | { readonly kind: "blocked"; readonly released: Deferred.Deferred<void> };

/**
 * Checks the holds and registers the lease in one synchronous step, inside the uninterruptible
 * acquire of acquireUseRelease, so no hold can begin between them and the registration is always
 * undone.
 */
const admit = (cwd: string) =>
  Effect.withFiber((fiber): Effect.Effect<Admission> => {
    const key = canonical(cwd, fiber.getRef(HostProcess.Platform));
    const held = fiber.getRef(HeldSubtrees);
    for (const [root, released] of subtrees)
      if (inside(root, key) && !held.includes(root))
        return Effect.succeed({ kind: "blocked", released });
    const lease = leases.get(cwd) ?? {
      semaphore: Semaphore.makeUnsafe(1),
      users: 0,
      canonical: key,
    };
    leases.set(cwd, lease);
    lease.users++;
    return Effect.succeed({ kind: "admitted", cwd, lease });
  });

const leave = (admission: Admission) =>
  Effect.sync(() => {
    if (admission.kind !== "admitted") return;
    admission.lease.users--;
    if (admission.lease.users === 0) leases.delete(admission.cwd);
  });

/**
 * Runs effect holding a claim other GOAT servers on this machine respect, or None while one of
 * theirs conflicts. A lease inside a folder this fiber holds whole needs none: that hold already
 * keeps every other server out.
 */
const withForeignClaim = <A, E, R>(
  kind: WorkspaceClaimKind,
  key: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E | WorkspaceLeaseUnavailableError, R> =>
  Effect.withFiber((fiber) =>
    kind === "lease" && fiber.getRef(HeldSubtrees).some((root) => inside(root, key))
      ? Effect.map(effect, Option.some)
      : Effect.acquireUseRelease(
          Effect.sync(() => claimWorkspace(kind, key)),
          (claim): Effect.Effect<Option.Option<A>, E | WorkspaceLeaseUnavailableError, R> =>
            claim.kind === "acquired"
              ? Effect.map(effect, Option.some)
              : claim.kind === "busy"
                ? Effect.succeed(Option.none())
                : Effect.fail(
                    new WorkspaceLeaseUnavailableError({ path: key, reason: claim.reason }),
                  ),
          (claim) =>
            Effect.sync(() => {
              if (claim.kind === "acquired") claim.release();
            }),
        ),
  );

/**
 * Waits while another server holds a folder over key whole. A fiber that holds a folder whole
 * itself fails instead, so no removal waits on another and two servers cannot deadlock.
 */
const waitForForeignClaim = <A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | WorkspaceLeaseUnavailableError, R> =>
  withForeignClaim("lease", key, effect).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Effect.withFiber((fiber) =>
            fiber.getRef(HeldSubtrees).length > 0
              ? Effect.fail(
                  new WorkspaceLeaseUnavailableError({
                    path: key,
                    reason:
                      "another GOAT server on this machine is removing a folder that holds it",
                  }),
                )
              : Random.nextIntBetween(150, 350).pipe(
                  Effect.flatMap((millis) => Effect.sleep(Duration.millis(millis))),
                  Effect.andThen(Effect.suspend(() => waitForForeignClaim(key, effect))),
                ),
          ),
      }),
    ),
  );

/** Coordinates checkout removal and cleanup across threads and GOAT servers using one resolved cwd. */
export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | WorkspaceLeaseUnavailableError, R> =>
  Effect.acquireUseRelease(
    admit(cwd),
    (admission): Effect.Effect<A, E | WorkspaceLeaseUnavailableError, R> =>
      admission.kind === "admitted"
        ? admission.lease.semaphore.withPermit(
            waitForForeignClaim(admission.lease.canonical, effect),
          )
        : Deferred.await(admission.released).pipe(Effect.andThen(withWorkspaceLease(cwd, effect))),
    leave,
  );

/** Attempts checkout startup without keeping an effect worker waiting on another holder. */
export const tryWithWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E | WorkspaceLeaseUnavailableError, R> =>
  Effect.acquireUseRelease(
    admit(cwd),
    (admission): Effect.Effect<Option.Option<A>, E | WorkspaceLeaseUnavailableError, R> =>
      admission.kind === "admitted"
        ? admission.lease.semaphore
            .withPermitsIfAvailable(1)(withForeignClaim("lease", admission.lease.canonical, effect))
            .pipe(Effect.map(Option.flatten))
        : Effect.succeed(Option.none()),
    leave,
  );

/**
 * Runs effect holding the whole folder at root: while it runs, no lease on root or inside it,
 * through any alias, is granted to anyone else (turn start reports busy, others wait), so a thread
 * bound inside it meanwhile cannot start writing there. None, without running, when a lease
 * inside it is already held or awaited, or another hold overlaps it. The holder may still take
 * leases inside it.
 */
export const tryWithWorkspaceSubtree = <A, E, R>(
  root: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E | WorkspaceLeaseUnavailableError, R> =>
  Effect.acquireUseRelease(
    Effect.withFiber((fiber) => {
      const key = canonical(root, fiber.getRef(HostProcess.Platform));
      const busy =
        [...leases.values()].some((lease) => inside(key, lease.canonical)) ||
        [...subtrees.keys()].some((other) => inside(other, key) || inside(key, other));
      const none = Option.none<{
        readonly key: string;
        readonly held: ReadonlyArray<string>;
        readonly release: () => void;
      }>();
      if (busy) return Effect.succeed(none);
      const claim = claimWorkspace("subtree", key);
      if (claim.kind === "busy") return Effect.succeed(none);
      if (claim.kind === "unavailable")
        return Effect.fail(new WorkspaceLeaseUnavailableError({ path: key, reason: claim.reason }));
      subtrees.set(key, Deferred.makeUnsafe<void>());
      return Effect.succeed(
        Option.some({ key, held: fiber.getRef(HeldSubtrees), release: claim.release }),
      );
    }),
    (hold): Effect.Effect<Option.Option<A>, E | WorkspaceLeaseUnavailableError, R> =>
      Option.isNone(hold)
        ? Effect.succeed(Option.none())
        : effect.pipe(
            Effect.provideService(HeldSubtrees, [...hold.value.held, hold.value.key]),
            Effect.map(Option.some),
          ),
    (hold) =>
      Effect.suspend(() => {
        if (Option.isNone(hold)) return Effect.void;
        hold.value.release();
        const released = subtrees.get(hold.value.key);
        subtrees.delete(hold.value.key);
        return released === undefined ? Effect.void : Deferred.succeed(released, undefined);
      }),
  );

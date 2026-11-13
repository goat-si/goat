import * as HostProcess from "@goat/shared/HostProcess";
import { SshInvalidTargetError } from "@goat/ssh/errors";
import { inspectPenExactAlias, type PenAliasUnreadable } from "@goat/ssh/penAlias";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { PenMembershipWatch } from "../pen/PenMembershipWatch.ts";

export interface PenRouteBinding {
  readonly meshId: string;
  readonly nodeId: string;
  readonly noisePub: string;
}

type PenAliasInspection = Effect.Success<ReturnType<typeof inspectPenExactAlias>>;
export type PenRouteCleanup = (alias: string, binding: PenRouteBinding) => Effect.Effect<void>;

/**
 * The ssh aliases this server reaches only because Pen lists their machine: the one place that
 * says an alias is Pen-managed, read at every SSH operation, and the one check that admits use
 * of it. HubNodes writes the set under its lock; nothing else does.
 */
export class PenManagedRoutes extends Context.Service<
  PenManagedRoutes,
  {
    /** True from the moment a Pen registration holds the alias until its cleanup has finished. */
    readonly isManaged: (alias: string) => boolean;
    readonly binding: (alias: string) => PenRouteBinding | undefined;
    /**
     * Fails unless Pen is live here, still lists the member with the bound key, and ssh's exact
     * alias still pins that key. Answers this server's own node id, for a member session.
     */
    readonly admit: (
      alias: string,
    ) => Effect.Effect<{ readonly selfNodeId: string }, SshInvalidTargetError>;
    readonly hold: (alias: string, binding: PenRouteBinding) => Effect.Effect<void>;
    /**
     * Runs every registered cleanup, then drops the alias. A failed cleanup leaves the alias
     * managed and unusable, and fails, so the caller retries.
     */
    readonly release: (alias: string) => Effect.Effect<void, PenRouteCleanupError>;
    /** Sessions, relays and tunnels opened for a managed alias register how to close them. */
    readonly registerCleanup: (cleanup: PenRouteCleanup) => Effect.Effect<void>;
  }
>()("goat/hubNodes/PenManagedRoutes") {}

export class PenRouteCleanupError extends Data.TaggedError("PenRouteCleanupError")<{
  readonly alias: string;
}> {
  override get message(): string {
    return `GOAT could not close what it held open for ${this.alias}; it stays blocked until it can.`;
  }
}

export const make = Effect.fn("PenManagedRoutes.make")(function* (input: {
  readonly inspect: (alias: string) => Effect.Effect<PenAliasInspection, PenAliasUnreadable>;
}) {
  const watch = yield* PenMembershipWatch;
  const held = new Map<string, { readonly binding: PenRouteBinding; releasing: boolean }>();
  const cleanups: PenRouteCleanup[] = [];
  const refuse = (message: string) => new SshInvalidTargetError({ message });

  const admit = Effect.fn("PenManagedRoutes.admit")(function* (alias: string) {
    const entry = held.get(alias);
    if (entry === undefined || entry.releasing)
      return yield* refuse(`${alias} is not a Pen machine this server follows.`);
    const { binding } = entry;
    if (alias !== `pen-${binding.nodeId}`)
      return yield* refuse("A Pen machine is reached only through its own Pen alias.");
    const route = yield* input.inspect(alias).pipe(
      Effect.catchTags({
        PenAliasUnreadable: () => Effect.succeed({ refused: "unreadable" as const }),
      }),
    );
    if ("refused" in route)
      return yield* refuse(`Pen does not vouch for ${alias} on this machine (${route.refused}).`);
    if (route.nodeId !== binding.nodeId || route.noisePub !== binding.noisePub)
      return yield* refuse(`${alias} no longer leads to the Pen machine it was added for.`);
    // Read after the inspection, so a departure during it is seen.
    const view = yield* watch.current;
    if (view.kind !== "ready")
      return yield* refuse("Pen's member list cannot be confirmed on this server right now.");
    const member = view.snapshot.members.find((candidate) => candidate.nodeId === binding.nodeId);
    if (
      view.snapshot.mesh !== binding.meshId ||
      member?.noisePub !== binding.noisePub ||
      binding.nodeId === view.snapshot.self
    )
      return yield* refuse("That machine is no longer a Pen member with this key.");
    if (held.get(alias) !== entry || entry.releasing)
      return yield* refuse(`${alias} is not a Pen machine this server follows.`);
    return { selfNodeId: view.snapshot.self };
  });

  return PenManagedRoutes.of({
    isManaged: (alias) => held.has(alias),
    binding: (alias) => held.get(alias)?.binding,
    admit,
    hold: Effect.fn("PenManagedRoutes.hold")(function* (alias: string, binding: PenRouteBinding) {
      held.set(alias, { binding, releasing: false });
    }),
    release: Effect.fn("PenManagedRoutes.release")(function* (alias: string) {
      const entry = held.get(alias);
      if (entry === undefined) return;
      entry.releasing = true;
      let failed = false;
      for (const cleanup of cleanups)
        yield* cleanup(alias, entry.binding).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("pen.managedRoute.cleanup.failed", { alias }, cause).pipe(
              Effect.andThen(Effect.sync(() => void (failed = true))),
            ),
          ),
        );
      if (failed) return yield* new PenRouteCleanupError({ alias });
      if (held.get(alias) === entry) held.delete(alias);
    }),
    registerCleanup: Effect.fn("PenManagedRoutes.registerCleanup")(function* (
      cleanup: PenRouteCleanup,
    ) {
      cleanups.push(cleanup);
    }),
  });
});

export const layer = Layer.effect(
  PenManagedRoutes,
  Effect.gen(function* () {
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const services = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();
    return yield* make({
      inspect: (alias) =>
        inspectPenExactAlias({ alias, homeDirectory }).pipe(Effect.provide(services)),
    });
  }),
);

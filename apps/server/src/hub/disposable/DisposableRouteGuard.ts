import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as SshHostKeys from "../../sshRemote/SshHostKeys.ts";
import { readPenConfig } from "../penConfigFile.ts";
import * as DisposableMachineStore from "./DisposableMachineStore.ts";
import {
  claimedBy,
  type DisposableClaim,
  penAliases,
  refusalText,
  type RouteClaim,
} from "./routeGuard.ts";

export interface GuardInput extends RouteClaim {
  /** Identifies the GOAT the route reaches; run only while an open record is left to match it. */
  readonly identify?: Effect.Effect<string | null | undefined>;
  /** An SSH destination whose ED25519 host key is read and compared while an open record has a pin. */
  readonly probe?: {
    readonly alias: string;
    readonly username: string | null;
    readonly port: number | null;
  };
}

/**
 * Design section 6, Disposable: Pen only. The one check every path that adds, links or moves a route
 * calls: the alias (pen-<nodeId>, or a pen-<name> that Pen's own known_hosts ties to the record's node
 * or key, read offline), the environment it reached, and the sshd key it offers. Only open records
 * refuse; anything unread reads as kept (design section 1, Fail safe).
 */
export class DisposableRouteGuard extends Context.Service<
  DisposableRouteGuard,
  {
    readonly claim: (input: GuardInput) => Effect.Effect<DisposableClaim | undefined>;
    /** The refusal text naming `target`, or undefined when the route names no open record. */
    readonly refusal: (input: GuardInput, target: string) => Effect.Effect<string | undefined>;
  }
>()("goat/hub/disposable/DisposableRouteGuard") {}

/** `penKnownHosts` is Pen's known_hosts text, "" when absent or unread. */
export const make = Effect.fn("DisposableRouteGuard.make")(function* (
  penKnownHosts: Effect.Effect<string>,
) {
  const store = yield* DisposableMachineStore.DisposableMachineStore;
  const keys = yield* SshHostKeys.SshHostKeys;
  const claim = Effect.fn("DisposableRouteGuard.claim")(function* (input: GuardInput) {
    const open = (yield* store.recordsOrKept).filter((record) => !record.final);
    if (open.length === 0) return undefined;
    const pen = input.alias === undefined ? undefined : penAliases(yield* penKnownHosts);
    const named = claimedBy(open, input, pen);
    if (named !== undefined) return named;
    // Identifying the GOAT takes a network read; it is skipped while no record has one to compare.
    if (input.identify !== undefined && open.some((record) => record.environmentId !== null)) {
      const environmentId = yield* input.identify;
      const reached = claimedBy(open, { environmentId: environmentId ?? null });
      if (reached !== undefined) return reached;
    }
    if (input.probe === undefined) return undefined;
    if (open.every((record) => record.sshdPin === null)) return undefined;
    const negotiated = yield* keys.negotiatedFingerprint(input.probe);
    return negotiated === undefined
      ? undefined
      : claimedBy(open, { hostKeyFingerprint: negotiated });
  });
  const refusal = Effect.fn("DisposableRouteGuard.refusal")(function* (
    input: GuardInput,
    target: string,
  ) {
    const found = yield* claim(input);
    return found === undefined ? undefined : refusalText(found, target);
  });
  return DisposableRouteGuard.of({ claim, refusal });
});

export const layer = Layer.effect(
  DisposableRouteGuard,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(yield* HostProcess.HomeDirectory, ".ssh", "pen", "known_hosts");
    return yield* make(readPenConfig(fs, file).pipe(Effect.orElseSucceed(() => "")));
  }),
).pipe(Layer.provide(DisposableMachineStore.layer), Layer.provide(SshHostKeys.layer));

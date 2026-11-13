// @effect-diagnostics nodeBuiltinImport:off -- Windows snapshots use a local Pen child.
import * as NodeChildProcess from "node:child_process";
import {
  DesktopPenMembersState,
  type DesktopPenMember,
  type DesktopSshEnvironmentTarget,
} from "@goat/contracts";
import {
  penLeftMesh,
  penStateDir,
  watchPenSnapshots,
  type PenSnapshot,
} from "@goat/pen-protocol/snapshot";
import { SshInvalidTargetError } from "@goat/ssh/errors";
import { inspectPenExactAlias, type PenAliasUnreadable } from "@goat/ssh/penAlias";
import {
  followPenMembership,
  type PenMembershipSource,
  type PenMembershipView,
} from "@goat/ssh/penMembershipWatch";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { PEN_MEMBERS_CHANGED_CHANNEL } from "../ipc/channels.ts";
import { openPenSnapshotChild } from "./penSnapshotChild.ts";
import { resolvePenBinary } from "./penPipe.ts";

const REINSPECT_AFTER = "2 seconds";

type PenAliasInspection = Effect.Success<ReturnType<typeof inspectPenExactAlias>>;
type PublishedState = DesktopPenMembersState extends infer State
  ? State extends unknown
    ? Omit<State, "seq">
    : never
  : never;

export interface DesktopPenMembersDeps extends PenMembershipSource {
  readonly inspect: (alias: string) => Effect.Effect<PenAliasInspection, PenAliasUnreadable>;
  readonly publish: (state: DesktopPenMembersState) => Effect.Effect<void>;
}

export interface TrustedPenSelf {
  readonly selfNodeId: string;
  readonly selfName: string;
}

export interface NativePenPin {
  readonly meshId: string;
  readonly nodeId: string;
  readonly noisePub: string;
}

export type NativePenMembership = "member" | "not-member" | "unavailable";

export interface DesktopPenMembersShape {
  readonly state: Effect.Effect<DesktopPenMembersState>;
  readonly member?: (pin: NativePenPin) => Effect.Effect<string | undefined>;
  readonly requireMember?: (pin: NativePenPin) => Effect.Effect<NativePenMembership>;
  readonly subscribeMembership?: (listener: (view: PenMembershipView) => void) => () => void;
  /**
   * Fails unless ssh, as configured now, reaches exactly that member over this target's alias.
   * `requireReady` is for a new credential: it also needs a live member list naming the member.
   */
  readonly requireTrusted: (
    target: DesktopSshEnvironmentTarget,
    nodeId: string,
    options: { readonly requireReady: boolean },
  ) => Effect.Effect<TrustedPenSelf | undefined, SshInvalidTargetError>;
}

/** Without the layer nothing is a Pen member: every managed route is refused. */
export class DesktopPenMembers extends Context.Reference<DesktopPenMembersShape>(
  "@goat/desktop/pen/DesktopPenMembers",
  {
    defaultValue: () => ({
      state: Effect.succeed({ kind: "unavailable", seq: 0, reason: "no-pen" }),
      requireTrusted: () =>
        Effect.fail(new SshInvalidTargetError({ message: "Pen machines are not available here." })),
    }),
  },
) {}

const settles = (reason: string) => reason === "not-in-pen-config" || reason === "no-recorded-key";
const sameState = Schema.toEquivalence(DesktopPenMembersState);

export const make = Effect.fn("DesktopPenMembers.make")(function* (deps: DesktopPenMembersDeps) {
  let current: DesktopPenMembersState = { kind: "unavailable", seq: 0, reason: "stale" };
  // Set the moment Pen reports it: a member a snapshot removed is refused before any inspection.
  let membership: PenMembershipView = { kind: "unavailable", reason: "stale" };
  const listeners = new Set<(view: PenMembershipView) => void>();

  const set = (next: PublishedState) =>
    Effect.suspend(() => {
      if (sameState({ ...next, seq: current.seq } as DesktopPenMembersState, current))
        return Effect.void;
      current = { ...next, seq: current.seq + 1 } as DesktopPenMembersState;
      return deps.publish(current);
    });

  const inspectMember = (member: PenSnapshot["members"][number]) =>
    deps.inspect(`pen-${member.nodeId}`).pipe(
      Effect.map((result): DesktopPenMember["route"] =>
        "refused" in result
          ? { kind: "refused", reason: result.refused }
          : result.nodeId === member.nodeId && result.noisePub === member.noisePub
            ? { kind: "trusted", target: result.target, revision: result.revision }
            : { kind: "refused", reason: "key-mismatch" },
      ),
      Effect.catchTags({
        PenAliasUnreadable: () =>
          Effect.succeed<DesktopPenMember["route"]>({ kind: "refused", reason: "unreadable" }),
      }),
      Effect.map((route): DesktopPenMember => ({
        nodeId: member.nodeId,
        name: member.name,
        online: member.online,
        noisePub: member.noisePub,
        route,
      })),
    );

  yield* followPenMembership(
    deps,
    (view) => {
      membership = view;
      for (const listener of listeners) {
        try {
          listener(view);
        } catch {
          // A listener that failed once must still hear the next view: it may be a revocation.
        }
      }
    },
    Effect.fnUntraced(function* (view, turn) {
      if (view.kind !== "ready") return yield* set(view);
      const { snapshot } = view;
      const inspectAll = Effect.forEach(
        snapshot.members.filter((member) => member.nodeId !== snapshot.self),
        inspectMember,
      );
      const ready = (members: ReadonlyArray<DesktopPenMember>): PublishedState => ({
        kind: "ready",
        meshId: snapshot.mesh,
        selfNodeId: snapshot.self,
        members,
      });
      const members = yield* inspectAll;
      if (!turn.isCurrent()) return;
      yield* set(ready(members));
      // Pen rewrites its ssh config after it publishes a snapshot, so a new member settles late.
      if (
        !members.some((member) => member.route.kind === "refused" && settles(member.route.reason))
      )
        return;
      const superseded = yield* Effect.race(
        Effect.as(Effect.sleep(REINSPECT_AFTER), false),
        Effect.as(turn.superseded, true),
      );
      if (superseded) return;
      const settled = yield* inspectAll;
      if (turn.isCurrent()) yield* set(ready(settled));
    }),
  ).pipe(Effect.forkScoped);

  const refuse = (message: string) => new SshInvalidTargetError({ message });
  const requireTrusted = Effect.fn("DesktopPenMembers.requireTrusted")(function* (
    target: DesktopSshEnvironmentTarget,
    nodeId: string,
    options: { readonly requireReady: boolean },
  ) {
    const alias = `pen-${nodeId}`;
    if (target.alias !== alias || target.hostname !== alias)
      return yield* refuse("A Pen machine is reached only through its own Pen alias.");
    const route = yield* deps.inspect(alias).pipe(
      Effect.catchTags({
        PenAliasUnreadable: () => Effect.succeed({ refused: "unreadable" as const }),
      }),
    );
    if ("refused" in route)
      return yield* refuse(`Pen does not vouch for ${alias} on this machine (${route.refused}).`);
    if (route.nodeId !== nodeId)
      return yield* refuse(`${alias} does not lead to that Pen machine.`);
    const view = membership;
    if (view.kind === "ready") {
      const member = view.snapshot.members.find((entry) => entry.nodeId === nodeId);
      if (member?.noisePub !== route.noisePub || nodeId === view.snapshot.self)
        return yield* refuse("That machine is no longer a Pen member with this key.");
      return { selfNodeId: view.snapshot.self, selfName: view.selfName };
    }
    if (view.kind === "not-member")
      return yield* refuse("This machine is no longer in the Pen mesh.");
    if (options.requireReady)
      return yield* refuse("Pen is not running here, so its member list cannot be confirmed.");
    return undefined;
  });

  const requireMember = Effect.fn("DesktopPenMembers.requireMember")((pin: NativePenPin) =>
    Effect.sync((): NativePenMembership => {
      const view = membership;
      if (view.kind === "unavailable") return "unavailable";
      if (view.kind === "not-member") return "not-member";
      const matches = view.snapshot.members.filter((member) => member.nodeId === pin.nodeId);
      return view.snapshot.mesh === pin.meshId &&
        view.snapshot.self !== pin.nodeId &&
        matches.length === 1 &&
        matches[0]?.noisePub === pin.noisePub &&
        !view.snapshot.revoked.some((member) => member.nodeId === pin.nodeId)
        ? "member"
        : "not-member";
    }),
  );
  const member = Effect.fn("DesktopPenMembers.member")((pin: NativePenPin) =>
    Effect.sync(() => {
      const view = membership;
      if (
        view.kind !== "ready" ||
        view.snapshot.mesh !== pin.meshId ||
        view.snapshot.self === pin.nodeId ||
        view.snapshot.revoked.some((entry) => entry.nodeId === pin.nodeId)
      )
        return undefined;
      const matches = view.snapshot.members.filter((entry) => entry.nodeId === pin.nodeId);
      return matches.length === 1 && matches[0]?.noisePub === pin.noisePub
        ? matches[0].name
        : undefined;
    }),
  );
  const subscribeMembership = (listener: (view: PenMembershipView) => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };

  return {
    state: Effect.sync(() => current),
    requireTrusted,
    requireMember,
    member,
    subscribeMembership,
  } satisfies DesktopPenMembersShape;
});

export function selectPenSnapshotWatch(
  platform: NodeJS.Platform,
  searchPath: string | undefined,
): PenMembershipSource["watch"] {
  if (platform !== "win32") return watchPenSnapshots;
  return (input) =>
    watchPenSnapshots({
      ...input,
      connect: () =>
        openPenSnapshotChild({
          stateDir: input.stateDir,
          resolveBinary: () => resolvePenBinary({ platform, path: searchPath }),
          spawn: (path, args, options) => NodeChildProcess.spawn(path, [...args], options),
        }),
    });
}

export const layer = Layer.effect(
  DesktopPenMembers,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const platform = yield* HostProcess.Platform;
    const hostEnvironment = yield* HostProcess.Environment;
    const fs = yield* FileSystem.FileSystem;
    const services = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();
    return yield* make({
      stateDir: penStateDir(hostEnvironment, environment.homeDirectory),
      stateDirExists: (stateDir) => fs.exists(stateDir).pipe(Effect.orElseSucceed(() => false)),
      leftMesh: (stateDir) => Effect.promise(() => penLeftMesh(stateDir)),
      watch: selectPenSnapshotWatch(platform, hostEnvironment.PATH),
      inspect: (alias) =>
        inspectPenExactAlias({ alias, homeDirectory: environment.homeDirectory }).pipe(
          Effect.provide(services),
        ),
      publish: (state) => electronWindow.sendAll(PEN_MEMBERS_CHANGED_CHANNEL, state),
    });
  }),
);
